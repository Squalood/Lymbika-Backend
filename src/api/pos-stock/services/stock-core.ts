/**
 * Stock por ubicación para el POS.
 *
 * Una **ubicación** es el documentId de una farmacia, o `null` para la **bodega central**.
 *
 * - `product.stock_central` es el **total** del producto en todas las ubicaciones.
 * - Cada farmacia lleva su stock en una fila de `pharmacy-stock` (una por par producto-farmacia,
 *   garantizado por `pairKey` + índice único en bootstrap).
 * - La **bodega no se guarda: se calcula** como `total − Σ farmacias`. Así los tres números
 *   cuadran por construcción.
 * - Los lotes (`inventory-lot`) pertenecen a una ubicación por su relación `pharmacy`
 *   (sin farmacia = bodega).
 *
 * Un movimiento en una ubicación (venta, compra, devolución, merma, ajuste) mueve esa ubicación
 * **y** el total. Un traspaso resta del origen y suma al destino: el total no cambia.
 *
 * Reglas que no se pueden romper:
 *
 * 1. **Todo movimiento corre dentro de `strapi.db.transaction`**, con las filas bloqueadas
 *    (`FOR UPDATE`) antes de leerlas. El cliente nunca manda el valor resultante: manda el
 *    documento (venta, compra…) o el delta, y el servidor calcula sobre el valor bloqueado.
 *    Así dos cajas vendiendo el mismo producto ya no se pisan.
 * 2. **`stock_central` se escribe con SQL sobre `document_id`**, nunca por el Document
 *    Service: el servicio REST publica por defecto (`status: 'published'`), y un PUT de
 *    stock re-publicaba el borrador completo del producto. Por `document_id` se actualizan
 *    a la vez la fila borrador y la publicada, sin tocar `publishedAt`.
 * 3. **Cada operación deja una fila en `stock-operation` con `opKey` único.** Reintentar la
 *    misma venta/compra/devolución devuelve el resultado anterior sin volver a aplicarla.
 * 4. **Orden de bloqueo fijo: primero las filas del producto, luego las de sus farmacias.**
 *    Evita interbloqueos entre dos operaciones sobre el mismo producto.
 */

type Loc = string | null;

export const UID = {
  product: 'api::product.product',
  lot: 'api::inventory-lot.inventory-lot',
  pharmacyStock: 'api::pharmacy-stock.pharmacy-stock',
  pharmacy: 'api::pharmacy.pharmacy',
  operation: 'api::stock-operation.stock-operation',
  transfer: 'api::stock-transfer.stock-transfer',
  venta: 'api::venta-pos.venta-pos',
  devolucion: 'api::devolucion-pos.devolucion-pos',
  compra: 'api::compra-pos.compra-pos',
  caja: 'api::caja-pos.caja-pos',
} as const;

const DISCARD_REASONS = ['expired', 'damaged', 'theft', 'other'];

export class StockError extends Error {
  status: number;
  code: string;
  details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

interface Lot {
  id: number;
  documentId: string;
  lotNumber: string | null;
  expirationDate: string | null;
  currentAmount: number;
  state: string;
  compraDocumentId: string | null;
  changed?: boolean;
}

interface Movement {
  productDocumentId: string;
  location: string;
  delta: number;
  before: number;
  after: number;
  lotDocumentId?: string;
  lotNumber?: string | null;
}

interface Warning {
  code: string;
  productDocumentId?: string;
  message: string;
  [k: string]: unknown;
}

interface Tx {
  trx: any;
  movements: Movement[];
  warnings: Warning[];
  touched: Map<string, { productDocumentId: string; location: Loc }>;
}

export const label = (loc: Loc) => loc ?? 'bodega';

/** "bodega", "" y null son la bodega; cualquier otra cosa es el documentId de una farmacia. */
export function parseLocation(raw: unknown): Loc {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  return s === '' || s === 'bodega' ? null : s;
}

/** Hoy en México. `new Date().toISOString()` es UTC: después de las 18:00 ya sería mañana. */
function todayMx(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Mexico_City',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

const FAR_FUTURE = '9999-12-31';
const fefo = (a: Lot, b: Lot) =>
  (a.expirationDate ?? FAR_FUTURE).localeCompare(b.expirationDate ?? FAR_FUTURE) || a.id - b.id;

function isSellable(lot: Lot, today: string) {
  return lot.state === 'activo' && lot.currentAmount > 0 && (lot.expirationDate ?? FAR_FUTURE) >= today;
}

const isUniqueViolation = (e: any) =>
  e?.code === '23505' || /unique/i.test(String(e?.message ?? '')) || /unique/i.test(String(e?.detail ?? ''));

const snake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

export default ({ strapi }: { strapi: any }) => {
  // ── Metadata: nombres reales de tablas y columnas ────────────────────────────────
  const meta = (uid: string) => strapi.db.metadata.get(uid);
  const table = (uid: string): string => meta(uid).tableName;
  const col = (uid: string, attr: string): string => meta(uid).attributes?.[attr]?.columnName || snake(attr);

  const pairKey = (productDocId: string, pharmacyDocId: string) => `${productDocId}__${pharmacyDocId}`;

  // ── Lecturas de documentos ────────────────────────────────────────────────────────
  async function findDoc(uid: string, documentId: string, populate: any) {
    const docs = strapi.documents(uid);
    return (
      (await docs.findOne({ documentId, status: 'published', populate })) ??
      (await docs.findOne({ documentId, status: 'draft', populate }))
    );
  }

  async function assertPharmacy(documentId: string) {
    const ph = await strapi.db
      .query(UID.pharmacy)
      .findOne({ where: { documentId }, select: ['id', 'documentId', 'nombre', 'estado'] });
    if (!ph) throw new StockError(404, 'PHARMACY_NOT_FOUND', `No existe la farmacia ${documentId}`);
    return ph;
  }

  // ── Stock por ubicación (siempre con la fila bloqueada) ───────────────────────────
  /** Bloquea las filas del producto (borrador y publicada) y devuelve el total. */
  async function lockTotal(tx: Tx, productDocId: string) {
    const t = table(UID.product);
    const sc = col(UID.product, 'stock_central');
    const dc = col(UID.product, 'documentId');
    const pc = col(UID.product, 'publishedAt');
    const rows = await tx
      .trx(t)
      .select('id', `${sc} as stock`, `${pc} as published`)
      .where(dc, productDocId)
      .orderBy('id')
      .forUpdate();
    if (!rows.length) throw new StockError(404, 'PRODUCT_NOT_FOUND', `No existe el producto ${productDocId}`);
    // La publicada manda; un producto que solo existe como borrador usa el borrador.
    const ref = rows.find((r: any) => r.published) ?? rows[0];
    return Number(ref.stock ?? 0);
  }

  async function lockPharmacyStock(tx: Tx, productDocId: string, pharmacyDocId: string) {
    const t = table(UID.pharmacyStock);
    const kc = col(UID.pharmacyStock, 'pairKey');
    const stc = col(UID.pharmacyStock, 'stock');
    const key = pairKey(productDocId, pharmacyDocId);
    const find = () => tx.trx(t).select('id', `${stc} as stock`).where(kc, key).forUpdate().first();

    let row = await find();
    if (!row) {
      await assertPharmacy(pharmacyDocId);
      // Se crea por el Document Service para que queden bien las relaciones; corre en la misma trx.
      await strapi.documents(UID.pharmacyStock).create({
        data: { product: productDocId, pharmacy: pharmacyDocId, pairKey: key, stock: 0 },
      });
      row = await find();
    }
    return { id: row.id as number, stock: Number(row.stock ?? 0) };
  }

  /** Σ stock de las farmacias del producto (filas bloqueadas). Se busca por el prefijo del pairKey. */
  async function sumPharmacies(tx: Tx, productDocId: string, lock = true) {
    const kc = col(UID.pharmacyStock, 'pairKey');
    const stc = col(UID.pharmacyStock, 'stock');
    let q = tx.trx(table(UID.pharmacyStock)).select(`${stc} as stock`).where(kc, 'like', `${productDocId}__%`).orderBy('id');
    if (lock) q = q.forUpdate();
    const rows = await q;
    return rows.reduce((s: number, r: any) => s + Number(r.stock ?? 0), 0);
  }

  /**
   * Lee el stock bloqueado de una ubicación, aplica `fn` y escribe el resultado. La diferencia
   * se aplica también al total, así que la bodega (total − farmacias) solo cambia cuando el
   * movimiento es en la bodega. Devuelve antes/después de la ubicación.
   */
  async function mutateStock(
    tx: Tx,
    productDocId: string,
    loc: Loc,
    fn: (before: number) => number
  ): Promise<{ before: number; after: number }> {
    const total = await lockTotal(tx, productDocId);
    let before: number;
    let after: number;
    if (loc === null) {
      before = total - (await sumPharmacies(tx, productDocId));
      after = fn(before);
    } else {
      const row = await lockPharmacyStock(tx, productDocId, loc);
      before = row.stock;
      after = fn(before);
      await tx
        .trx(table(UID.pharmacyStock))
        .where('id', row.id)
        .update({ [col(UID.pharmacyStock, 'stock')]: after });
    }
    const delta = after - before;
    if (delta !== 0) {
      await tx
        .trx(table(UID.product))
        .where(col(UID.product, 'documentId'), productDocId)
        .update({ [col(UID.product, 'stock_central')]: total + delta });
      tx.movements.push({ productDocumentId: productDocId, location: label(loc), delta, before, after });
    }
    tx.touched.set(`${productDocId}|${label(loc)}`, { productDocumentId: productDocId, location: loc });
    return { before, after };
  }

  // ── Lotes por ubicación ───────────────────────────────────────────────────────────
  async function lotsAt(tx: Tx, productDocId: string, loc: Loc): Promise<Lot[]> {
    const found = await strapi.db.query(UID.lot).findMany({
      where: {
        product: { documentId: productDocId },
        pharmacy: loc ? { documentId: loc } : { id: { $null: true } },
      },
      select: ['id', 'documentId', 'lotNumber', 'expirationDate', 'currentAmount', 'state'],
      populate: { compra: { select: ['documentId'] } },
    });
    const byId = new Map<number, any>();
    for (const l of found) byId.set(l.id, l);
    if (!byId.size) return [];

    // Bloquear y releer la cantidad: la del findMany pudo cambiar antes del lock.
    const ca = col(UID.lot, 'currentAmount');
    const st = col(UID.lot, 'state');
    const locked = await tx
      .trx(table(UID.lot))
      .select('id', `${ca} as amount`, `${st} as state`)
      .whereIn('id', [...byId.keys()])
      .orderBy('id')
      .forUpdate();

    return locked.map((r: any) => {
      const l = byId.get(r.id);
      return {
        id: r.id,
        documentId: l.documentId,
        lotNumber: l.lotNumber ?? null,
        expirationDate: l.expirationDate ?? null,
        currentAmount: Number(r.amount ?? 0),
        state: r.state ?? 'activo',
        compraDocumentId: l.compra?.documentId ?? null,
      };
    });
  }

  /**
   * Toma `qty` unidades de `lots` (en memoria): primero del lote preferido, luego FEFO entre
   * los vendibles. Nunca deja un lote negativo. Devuelve las porciones y lo que no alcanzó.
   */
  function consume(lots: Lot[], qty: number, preferredDocId: string | null, today: string) {
    const portions: { lot: Lot; qty: number }[] = [];
    let remaining = qty;
    const take = (lot: Lot, n: number) => {
      if (n <= 0) return;
      lot.currentAmount -= n;
      lot.changed = true;
      remaining -= n;
      portions.push({ lot, qty: n });
    };

    let preferredMissing = false;
    if (preferredDocId) {
      const lot = lots.find((l) => l.documentId === preferredDocId);
      if (lot && lot.state === 'activo') take(lot, Math.min(remaining, Math.max(0, lot.currentAmount)));
      else preferredMissing = true;
    }
    for (const lot of lots.filter((l) => isSellable(l, today)).sort(fefo)) {
      if (remaining <= 0) break;
      take(lot, Math.min(remaining, lot.currentAmount));
    }
    return { portions, remaining, preferredMissing };
  }

  /** Escribe los lotes marcados como cambiados. Pasa a `agotado` al llegar a 0 y revive si recibe. */
  async function writeLots(tx: Tx, productDocId: string, loc: Loc, lots: Lot[]) {
    const ca = col(UID.lot, 'currentAmount');
    const st = col(UID.lot, 'state');
    const ua = col(UID.lot, 'updatedAt');
    for (const lot of lots) {
      if (!lot.changed) continue;
      let state = lot.state;
      if (lot.currentAmount <= 0 && state === 'activo') state = 'agotado';
      if (lot.currentAmount > 0 && state === 'agotado') state = 'activo';
      await tx
        .trx(table(UID.lot))
        .where('id', lot.id)
        .update({ [ca]: lot.currentAmount, [st]: state, [ua]: new Date() });
      lot.state = state;
      lot.changed = false;
    }
    tx.touched.set(`${productDocId}|${label(loc)}`, { productDocumentId: productDocId, location: loc });
  }

  function recordLot(tx: Tx, productDocId: string, loc: Loc, lot: Lot, delta: number) {
    tx.movements.push({
      productDocumentId: productDocId,
      location: label(loc),
      delta,
      before: lot.currentAmount - delta,
      after: lot.currentAmount,
      lotDocumentId: lot.documentId,
      lotNumber: lot.lotNumber,
    });
  }

  // ── Niveles (lo que el POS aplica en lugar de calcular) ───────────────────────────
  async function readTotal(productDocId: string) {
    const rows = await strapi.db.query(UID.product).findMany({
      where: { documentId: productDocId },
      select: ['stock_central', 'publishedAt'],
    });
    const ref = rows.find((r: any) => r.publishedAt) ?? rows[0];
    return Number(ref?.stock_central ?? 0);
  }

  async function readLevel(productDocId: string, loc: Loc, trx?: any) {
    let stock = 0;
    const total = await readTotal(productDocId);
    if (loc === null) {
      // Dentro de una operación hay que leer con su trx: otra conexión vería lo anterior al commit.
      const knex = trx ?? strapi.db.connection;
      const rows = await knex(table(UID.pharmacyStock))
        .select(`${col(UID.pharmacyStock, 'stock')} as stock`)
        .where(col(UID.pharmacyStock, 'pairKey'), 'like', `${productDocId}__%`);
      stock = total - rows.reduce((s: number, r: any) => s + Number(r.stock ?? 0), 0);
    } else {
      const row = await strapi.db
        .query(UID.pharmacyStock)
        .findOne({ where: { pairKey: pairKey(productDocId, loc) }, select: ['stock'] });
      stock = Number(row?.stock ?? 0);
    }
    const lots = await strapi.db.query(UID.lot).findMany({
      where: {
        product: { documentId: productDocId },
        pharmacy: loc ? { documentId: loc } : { id: { $null: true } },
      },
      select: ['documentId', 'lotNumber', 'expirationDate', 'currentAmount', 'state'],
    });
    return { productDocumentId: productDocId, location: label(loc), stock, total, lots };
  }

  async function readLevels(touched: Iterable<{ productDocumentId: string; location: Loc }>, trx?: any) {
    const out = [];
    for (const t of touched) out.push(await readLevel(t.productDocumentId, t.location, trx));
    return out;
  }

  // ── Ejecutor de operaciones idempotentes ──────────────────────────────────────────
  interface OpInfo {
    opKey: string;
    kind: string;
    refType?: string;
    refDocumentId?: string;
    location?: string;
    user?: any;
    notes?: string;
  }

  async function duplicateResult(opKey: string) {
    const prev = await strapi.db.query(UID.operation).findOne({ where: { opKey } });
    if (!prev) return null;
    const seen = new Map<string, { productDocumentId: string; location: Loc }>();
    for (const m of (prev.movements ?? []) as Movement[]) {
      seen.set(`${m.productDocumentId}|${m.location}`, {
        productDocumentId: m.productDocumentId,
        location: parseLocation(m.location),
      });
    }
    return {
      ok: true,
      duplicate: true,
      operationId: prev.documentId,
      warnings: prev.warnings ?? [],
      levels: await readLevels(seen.values()),
    };
  }

  async function runOperation<T>(info: OpInfo, fn: (tx: Tx) => Promise<T>) {
    const dup = await duplicateResult(info.opKey);
    if (dup) return dup;

    try {
      return await strapi.db.transaction(async ({ trx }: any) => {
        // La fila va primero: una segunda petición con el mismo opKey choca contra el índice
        // único y espera a que esta termine, en vez de aplicar el movimiento dos veces.
        const op = await strapi.db.query(UID.operation).create({
          data: {
            opKey: info.opKey,
            kind: info.kind,
            refType: info.refType ?? null,
            refDocumentId: info.refDocumentId ?? null,
            location: info.location ?? null,
            notes: info.notes ?? null,
            user: info.user?.id ?? null,
            movements: [],
            warnings: [],
          },
        });

        const tx: Tx = { trx, movements: [], warnings: [], touched: new Map() };
        const result = await fn(tx);

        await strapi.db.query(UID.operation).update({
          where: { id: op.id },
          data: { movements: tx.movements, warnings: tx.warnings },
        });

        return {
          ok: true,
          duplicate: false,
          operationId: op.documentId,
          result,
          warnings: tx.warnings,
          levels: await readLevels(tx.touched.values(), trx),
        };
      });
    } catch (e) {
      if (isUniqueViolation(e)) {
        const again = await duplicateResult(info.opKey);
        if (again) return again;
      }
      throw e;
    }
  }

  // ── Operaciones ───────────────────────────────────────────────────────────────────

  /** Descuenta una venta ya registrada. Lee líneas y farmacia del servidor, no del cliente. */
  async function sale({ ventaDocumentId, user }: { ventaDocumentId: string; user?: any }) {
    if (!ventaDocumentId) throw new StockError(400, 'BAD_REQUEST', 'Falta ventaDocumentId');
    const venta = await findDoc(UID.venta, ventaDocumentId, {
      venta: { populate: { product: { fields: ['documentId', 'productName'] } } },
      pharmacies: { fields: ['documentId'] },
    });
    if (!venta) throw new StockError(404, 'VENTA_NOT_FOUND', `No existe la venta ${ventaDocumentId}`);

    // Sin farmacia (venta vieja o registrada fuera de una caja) se descuenta de la bodega: el
    // total baja igual, que es lo que cuadra la reconciliación.
    const loc: Loc = venta.pharmacies?.[0]?.documentId ?? null;

    const byProduct = new Map<string, { name: string; lines: { qty: number; lot: string | null }[] }>();
    for (const line of venta.venta ?? []) {
      const pid = line.product?.documentId;
      const qty = Number(line.quantity ?? 0);
      if (line.type === 'service' || !pid || qty <= 0) continue;
      const g = byProduct.get(pid) ?? { name: line.product.productName ?? line.productName, lines: [] };
      g.lines.push({ qty, lot: line.lotDocumentId || null });
      byProduct.set(pid, g);
    }

    return runOperation(
      { opKey: `sale:${ventaDocumentId}`, kind: 'sale', refType: 'venta-pos', refDocumentId: ventaDocumentId, location: label(loc), user },
      async (tx) => {
        const today = todayMx();
        if (!loc) tx.warnings.push({ code: 'NO_PHARMACY', message: 'La venta no tiene farmacia: se descontó de la bodega' });
        for (const [pid, g] of [...byProduct].sort(([a], [b]) => a.localeCompare(b))) {
          const total = g.lines.reduce((s, l) => s + l.qty, 0);
          const { after } = await mutateStock(tx, pid, loc, (b) => b - total);
          if (after < 0) {
            tx.warnings.push({
              code: 'NEGATIVE_STOCK',
              productDocumentId: pid,
              message: `${g.name}: el stock de ${label(loc)} quedó en ${after}`,
              stock: after,
            });
          }

          const lots = await lotsAt(tx, pid, loc);
          if (!lots.length) continue; // producto sin lotes: se vende solo por stock, como siempre
          let uncovered = 0;
          for (const line of g.lines) {
            const { portions, remaining, preferredMissing } = consume(lots, line.qty, line.lot, today);
            portions.forEach((p) => recordLot(tx, pid, loc, p.lot, -p.qty));
            uncovered += remaining;
            if (preferredMissing) {
              tx.warnings.push({
                code: 'LOT_NOT_AT_LOCATION',
                productDocumentId: pid,
                message: `${g.name}: el lote elegido no está disponible en ${label(loc)}; se tomó por caducidad`,
                lotDocumentId: line.lot,
              });
            }
          }
          if (uncovered > 0) {
            tx.warnings.push({
              code: 'LOTS_INSUFFICIENT',
              productDocumentId: pid,
              message: `${g.name}: ${uncovered} unidad(es) vendidas sin lote que las cubra`,
              quantity: uncovered,
            });
          }
          await writeLots(tx, pid, loc, lots);
        }
        return { products: byProduct.size };
      }
    );
  }

  /** Regresa al stock de la farmacia lo devuelto. No toca lotes (decisión vigente). */
  async function saleReturn({ devolucionDocumentId, user }: { devolucionDocumentId: string; user?: any }) {
    if (!devolucionDocumentId) throw new StockError(400, 'BAD_REQUEST', 'Falta devolucionDocumentId');
    const dev = await findDoc(UID.devolucion, devolucionDocumentId, {
      items: { populate: { product: { fields: ['documentId'] } } },
      pharmacies: { fields: ['documentId'] },
    });
    if (!dev) throw new StockError(404, 'DEVOLUCION_NOT_FOUND', `No existe la devolución ${devolucionDocumentId}`);

    // Sin farmacia, lo devuelto entra a la bodega.
    const loc: Loc = dev.pharmacies?.[0]?.documentId ?? null;

    const byProduct = new Map<string, number>();
    for (const item of dev.items ?? []) {
      const pid = item.product?.documentId;
      const qty = Number(item.quantity ?? 0);
      if (!pid || qty <= 0) continue;
      byProduct.set(pid, (byProduct.get(pid) ?? 0) + qty);
    }

    return runOperation(
      { opKey: `return:${devolucionDocumentId}`, kind: 'return', refType: 'devolucion-pos', refDocumentId: devolucionDocumentId, location: label(loc), user },
      async (tx) => {
        for (const [pid, qty] of [...byProduct].sort(([a], [b]) => a.localeCompare(b))) {
          await mutateStock(tx, pid, loc, (b) => b + qty);
        }
        return { products: byProduct.size };
      }
    );
  }

  /** Ingresa una compra al destino elegido y crea sus lotes ahí. */
  async function purchase({ compraDocumentId, user }: { compraDocumentId: string; user?: any }) {
    if (!compraDocumentId) throw new StockError(400, 'BAD_REQUEST', 'Falta compraDocumentId');
    const compra = await findDoc(UID.compra, compraDocumentId, {
      items: { populate: { product: { fields: ['documentId'] } } },
      destination_pharmacy: { fields: ['documentId'] },
    });
    if (!compra) throw new StockError(404, 'COMPRA_NOT_FOUND', `No existe la compra ${compraDocumentId}`);

    const loc: Loc = compra.destination_pharmacy?.documentId ?? null;

    const byProduct = new Map<string, { qty: number; lots: { number: string; qty: number; exp: string | null }[] }>();
    for (const item of compra.items ?? []) {
      const pid = item.product?.documentId;
      const qty = Number(item.quantity ?? 0);
      if (!pid || qty <= 0) continue;
      const g = byProduct.get(pid) ?? { qty: 0, lots: [] };
      g.qty += qty;
      const number = String(item.numeroLote ?? '').trim();
      if (number) g.lots.push({ number, qty, exp: item.fechaCaducidad || null });
      byProduct.set(pid, g);
    }

    return runOperation(
      { opKey: `purchase:${compraDocumentId}`, kind: 'purchase', refType: 'compra-pos', refDocumentId: compraDocumentId, location: label(loc), user },
      async (tx) => {
        let lotsCreated = 0;
        for (const [pid, g] of [...byProduct].sort(([a], [b]) => a.localeCompare(b))) {
          await mutateStock(tx, pid, loc, (b) => b + g.qty);
          for (const lot of g.lots) {
            const created = await strapi.documents(UID.lot).create({
              data: {
                product: pid,
                ...(loc ? { pharmacy: loc } : {}),
                compra: compraDocumentId,
                lotNumber: lot.number,
                ...(lot.exp ? { expirationDate: lot.exp } : {}),
                initialQuantity: lot.qty,
                currentAmount: lot.qty,
                state: 'activo',
              },
            });
            lotsCreated++;
            tx.movements.push({
              productDocumentId: pid,
              location: label(loc),
              delta: lot.qty,
              before: 0,
              after: lot.qty,
              lotDocumentId: created.documentId,
              lotNumber: lot.number,
            });
          }
        }
        return { products: byProduct.size, lotsCreated };
      }
    );
  }

  /** Traspaso inmediato entre ubicaciones, respetando lotes (los parte si es parcial). */
  async function transfer(input: {
    from: Loc;
    to: Loc;
    lines: { productDocumentId: string; quantity: number; lotDocumentId?: string | null }[];
    notes?: string;
    idemKey: string;
    user?: any;
  }) {
    const { from, to, notes, idemKey, user } = input;
    if (!idemKey) throw new StockError(400, 'BAD_REQUEST', 'Falta idemKey');
    if (from === to) throw new StockError(400, 'SAME_LOCATION', 'Origen y destino son la misma ubicación');
    const lines = (input.lines ?? []).map((l) => ({
      productDocumentId: String(l.productDocumentId ?? ''),
      quantity: Number(l.quantity),
      lotDocumentId: l.lotDocumentId || null,
    }));
    if (!lines.length) throw new StockError(400, 'BAD_REQUEST', 'El traspaso no tiene líneas');
    for (const l of lines) {
      if (!l.productDocumentId || !Number.isInteger(l.quantity) || l.quantity <= 0) {
        throw new StockError(400, 'BAD_REQUEST', 'Cada línea necesita producto y cantidad entera positiva');
      }
    }
    for (const loc of [from, to]) {
      if (loc) {
        const ph = await assertPharmacy(loc);
        if (ph.estado === 'inactivo') throw new StockError(409, 'PHARMACY_INACTIVE', `${ph.nombre} está inactiva`);
      }
    }

    const byProduct = new Map<string, typeof lines>();
    for (const l of lines) byProduct.set(l.productDocumentId, [...(byProduct.get(l.productDocumentId) ?? []), l]);

    return runOperation(
      { opKey: `transfer:${idemKey}`, kind: 'transfer', refType: 'stock-transfer', refDocumentId: idemKey, location: `${label(from)}→${label(to)}`, user, notes },
      async (tx) => {
        const today = todayMx();
        const now = new Date();
        let records = 0;

        for (const [pid, group] of [...byProduct].sort(([a], [b]) => a.localeCompare(b))) {
          const need = group.reduce((s, l) => s + l.quantity, 0);
          // Los traspasos no dejan negativos; solo la venta puede.
          await mutateStock(tx, pid, from, (b) => {
            if (b < need) {
              throw new StockError(409, 'INSUFFICIENT_STOCK', `Stock insuficiente en ${label(from)}: hay ${b}, se piden ${need}`, {
                productDocumentId: pid,
                available: b,
                requested: need,
              });
            }
            return b - need;
          });
          await mutateStock(tx, pid, to, (b) => b + need);

          const originLots = await lotsAt(tx, pid, from);
          const destLots = await lotsAt(tx, pid, to);

          for (const line of group) {
            const { portions, remaining } = consume(originLots, line.quantity, line.lotDocumentId, today);
            for (const p of portions) {
              recordLot(tx, pid, from, p.lot, -p.qty);

              // Mismo número y caducidad en destino = mismo lote físico: se suma ahí.
              let dest = destLots.find(
                (d) => d.state !== 'vencido' && d.lotNumber === p.lot.lotNumber && d.expirationDate === p.lot.expirationDate
              );
              if (dest) {
                dest.currentAmount += p.qty;
                dest.changed = true;
                recordLot(tx, pid, to, dest, p.qty);
              } else {
                const created = await strapi.documents(UID.lot).create({
                  data: {
                    product: pid,
                    ...(to ? { pharmacy: to } : {}),
                    ...(p.lot.compraDocumentId ? { compra: p.lot.compraDocumentId } : {}),
                    source_lot: p.lot.documentId,
                    lotNumber: p.lot.lotNumber,
                    ...(p.lot.expirationDate ? { expirationDate: p.lot.expirationDate } : {}),
                    initialQuantity: p.qty,
                    currentAmount: p.qty,
                    state: 'activo',
                  },
                });
                dest = {
                  id: created.id,
                  documentId: created.documentId,
                  lotNumber: p.lot.lotNumber,
                  expirationDate: p.lot.expirationDate,
                  currentAmount: p.qty,
                  state: 'activo',
                  compraDocumentId: p.lot.compraDocumentId,
                };
                destLots.push(dest);
                recordLot(tx, pid, to, dest, p.qty);
              }

              await strapi.documents(UID.transfer).create({
                data: {
                  product: pid,
                  ...(from ? { from_pharmacy: from } : {}),
                  ...(to ? { to_pharmacy: to } : {}),
                  quantity: p.qty,
                  from_lot: p.lot.documentId,
                  to_lot: dest.documentId,
                  batchId: idemKey,
                  transferred_at: now,
                  ...(user?.documentId ? { transferred_by: user.documentId } : {}),
                  ...(notes ? { notes } : {}),
                },
              });
              records++;
            }

            // Lo que los lotes no cubren viaja sin lote (el stock ya se movió arriba).
            if (remaining > 0) {
              await strapi.documents(UID.transfer).create({
                data: {
                  product: pid,
                  ...(from ? { from_pharmacy: from } : {}),
                  ...(to ? { to_pharmacy: to } : {}),
                  quantity: remaining,
                  batchId: idemKey,
                  transferred_at: now,
                  ...(user?.documentId ? { transferred_by: user.documentId } : {}),
                  ...(notes ? { notes } : {}),
                },
              });
              records++;
            }
          }

          await writeLots(tx, pid, from, originLots);
          await writeLots(tx, pid, to, destLots);
        }
        return { batchId: idemKey, records };
      }
    );
  }

  /** Ajuste manual: fija o suma el stock de una ubicación, o la cantidad de un lote. */
  async function adjust(input: {
    productDocumentId: string;
    location: Loc;
    mode: 'set' | 'delta';
    value: number;
    reason?: string;
    lotDocumentId?: string | null;
    /**
     * Solo con lote. `true` (por defecto): el lote y el stock de la ubicación se mueven juntos
     * (rotura, pérdida de ese lote). `false`: solo el lote, para cuadrar lotes contra el stock
     * sin tocar el total (lo que marca la reconciliación).
     */
    affectStock?: boolean;
    idemKey: string;
    user?: any;
  }) {
    const { productDocumentId: pid, mode, reason, lotDocumentId, idemKey, user } = input;
    const affectStock = input.affectStock !== false;
    const value = Number(input.value);
    if (!pid) throw new StockError(400, 'BAD_REQUEST', 'Falta productDocumentId');
    if (!idemKey) throw new StockError(400, 'BAD_REQUEST', 'Falta idemKey');
    if (mode !== 'set' && mode !== 'delta') throw new StockError(400, 'BAD_REQUEST', 'mode debe ser set o delta');
    if (!Number.isInteger(value)) throw new StockError(400, 'BAD_REQUEST', 'value debe ser entero');
    const loc = input.location;
    if (loc) await assertPharmacy(loc);

    return runOperation(
      { opKey: `adjust:${idemKey}`, kind: 'adjust', refType: lotDocumentId ? 'inventory-lot' : 'product', refDocumentId: lotDocumentId || pid, location: label(loc), user, notes: reason },
      async (tx) => {
        if (lotDocumentId) {
          // Mismo orden de bloqueo que la venta (producto → farmacias → lotes): sin esto, una
          // corrección y una venta simultáneas del mismo producto podrían interbloquearse.
          if (affectStock) {
            await lockTotal(tx, pid);
            if (loc) await lockPharmacyStock(tx, pid, loc);
            else await sumPharmacies(tx, pid);
          }
          const lots = await lotsAt(tx, pid, loc);
          const lot = lots.find((l) => l.documentId === lotDocumentId);
          if (!lot) throw new StockError(404, 'LOT_NOT_AT_LOCATION', `El lote no está en ${label(loc)}`);
          const next = mode === 'set' ? value : lot.currentAmount + value;
          if (next < 0) throw new StockError(400, 'NEGATIVE_LOT', 'Un lote no puede quedar negativo');
          const delta = next - lot.currentAmount;
          lot.currentAmount = next;
          lot.changed = true;
          recordLot(tx, pid, loc, lot, delta);
          await writeLots(tx, pid, loc, lots);
          let stock: number | undefined;
          if (affectStock && delta !== 0) ({ after: stock } = await mutateStock(tx, pid, loc, (b) => b + delta));
          return { lotDocumentId, currentAmount: next, stock };
        }
        const { after } = await mutateStock(tx, pid, loc, (b) => (mode === 'set' ? value : b + value));
        return { stock: after };
      }
    );
  }

  /**
   * Conteo físico de un producto en una ubicación ("Cuadrar"). Cada lote queda con lo contado
   * y el stock de la ubicación queda en la suma de sus lotes más lo contado sin lote. Así stock
   * y lotes coinciden siempre después de cuadrar; la diferencia contra lo que había se aplica
   * al total (es una corrección real). Todo en una transacción.
   */
  async function count(input: {
    productDocumentId: string;
    location: Loc;
    lots: { lotDocumentId: string; amount: number }[];
    unlotted: number;
    reason?: string;
    idemKey: string;
    user?: any;
  }) {
    const { productDocumentId: pid, idemKey, user } = input;
    const loc = input.location;
    const unlotted = Number(input.unlotted ?? 0);
    const counted = (input.lots ?? []).map((l) => ({ id: String(l.lotDocumentId ?? ''), amount: Number(l.amount) }));
    if (!pid) throw new StockError(400, 'BAD_REQUEST', 'Falta productDocumentId');
    if (!idemKey) throw new StockError(400, 'BAD_REQUEST', 'Falta idemKey');
    if (!Number.isInteger(unlotted) || unlotted < 0) throw new StockError(400, 'BAD_REQUEST', 'Las unidades sin lote deben ser un entero ≥ 0');
    for (const c of counted) {
      if (!c.id || !Number.isInteger(c.amount) || c.amount < 0) {
        throw new StockError(400, 'BAD_REQUEST', 'Cada lote contado necesita una cantidad entera ≥ 0');
      }
    }
    if (loc) await assertPharmacy(loc);

    return runOperation(
      { opKey: `count:${idemKey}`, kind: 'adjust', refType: 'count', refDocumentId: pid, location: label(loc), user, notes: input.reason || 'Conteo físico' },
      async (tx) => {
        // Orden de bloqueo de siempre: producto → farmacias → lotes.
        await lockTotal(tx, pid);
        if (loc) await lockPharmacyStock(tx, pid, loc);
        else await sumPharmacies(tx, pid);
        const lots = await lotsAt(tx, pid, loc);

        for (const c of counted) {
          const lot = lots.find((l) => l.documentId === c.id);
          if (!lot) throw new StockError(404, 'LOT_NOT_AT_LOCATION', `Un lote contado no está en ${label(loc)}`);
          const delta = c.amount - lot.currentAmount;
          if (delta === 0) continue;
          lot.currentAmount = c.amount;
          lot.changed = true;
          recordLot(tx, pid, loc, lot, delta);
        }
        await writeLots(tx, pid, loc, lots);

        // Lo que hay = lo que tienen los lotes vigentes (los no contados conservan su cantidad)
        // más lo contado sin lote. Los vencidos ya se dieron de baja y no cuentan.
        const inLots = lots.filter((l) => l.state !== 'vencido').reduce((s, l) => s + l.currentAmount, 0);
        const target = inLots + unlotted;
        const { before, after } = await mutateStock(tx, pid, loc, () => target);
        return { stock: after, previous: before, inLots, unlotted };
      }
    );
  }

  /** Merma: marca lotes completos como vencidos y descuenta su cantidad del stock de su ubicación. */
  async function discard(input: { lotDocumentIds: string[]; reason: string; idemKey?: string; user?: any }) {
    const ids = [...new Set((input.lotDocumentIds ?? []).map(String).filter(Boolean))].sort();
    if (!ids.length) throw new StockError(400, 'BAD_REQUEST', 'No hay lotes que desechar');
    if (!DISCARD_REASONS.includes(input.reason)) throw new StockError(400, 'BAD_REQUEST', 'Motivo de merma inválido');

    const found = await strapi.db.query(UID.lot).findMany({
      where: { documentId: { $in: ids } },
      select: ['documentId'],
      populate: { product: { select: ['documentId', 'productName'] }, pharmacy: { select: ['documentId'] } },
    });
    const groups = new Map<string, { pid: string; loc: Loc; lots: string[] }>();
    const failed: string[] = [];
    for (const l of found) {
      if (!l.product?.documentId) {
        failed.push(l.documentId);
        continue;
      }
      const loc: Loc = l.pharmacy?.documentId ?? null;
      const key = `${l.product.documentId}|${label(loc)}`;
      const g = groups.get(key) ?? { pid: l.product.documentId, loc, lots: [] };
      g.lots.push(l.documentId);
      groups.set(key, g);
    }
    for (const id of ids) if (!found.some((l: any) => l.documentId === id)) failed.push(id);

    const discardedBy = input.user?.username ?? 'desconocido';
    return runOperation(
      { opKey: `discard:${input.idemKey || ids.join(',')}`, kind: 'discard', refType: 'inventory-lot', location: 'varios', user: input.user, notes: input.reason },
      async (tx) => {
        const now = new Date();
        let discardedLots = 0;
        for (const g of [...groups.values()].sort((a, b) => a.pid.localeCompare(b.pid))) {
          const lots = await lotsAt(tx, g.pid, g.loc);
          let discarded = 0;
          for (const lot of lots.filter((l) => g.lots.includes(l.documentId))) {
            if (lot.state !== 'activo' || lot.currentAmount <= 0) {
              tx.warnings.push({ code: 'LOT_NOT_DISCARDABLE', productDocumentId: g.pid, message: `El lote ${lot.lotNumber ?? ''} ya no está activo`, lotDocumentId: lot.documentId });
              continue;
            }
            const qty = lot.currentAmount;
            await tx
              .trx(table(UID.lot))
              .where('id', lot.id)
              .update({
                [col(UID.lot, 'currentAmount')]: 0,
                [col(UID.lot, 'state')]: 'vencido',
                [col(UID.lot, 'discardedAt')]: now,
                [col(UID.lot, 'discardedBy')]: discardedBy,
                [col(UID.lot, 'discardedQuantity')]: qty,
                [col(UID.lot, 'discardReason')]: input.reason,
                [col(UID.lot, 'updatedAt')]: now,
              });
            lot.currentAmount = 0;
            recordLot(tx, g.pid, g.loc, lot, -qty);
            discarded += qty;
            discardedLots++;
          }
          // Resta exacta: son unidades que existían en los lotes y se dieron de baja. Así el
          // total baja lo mismo que la suma de lotes y la reconciliación no se descuadra.
          if (discarded > 0) await mutateStock(tx, g.pid, g.loc, (b) => b - discarded);
        }
        return { discardedLots, failed };
      }
    );
  }

  /**
   * Foto de la bodega por producto para "Pasar toda la bodega": bodega (total − farmacias),
   * stock actual en la farmacia destino y lotes sin farmacia. Sin bloqueos: solo decide qué
   * productos procesar; cada uno se vuelve a leer bloqueado dentro de la transacción.
   */
  async function bodegaSnapshot(to: string) {
    const rows = new Map<
      string,
      { productDocumentId: string; productName: string; bodega: number; toStock: number; lots: number; lotUnits: number }
    >();
    const products = await strapi.db.query(UID.product).findMany({
      select: ['documentId', 'productName', 'stock_central', 'publishedAt'],
    });
    for (const p of products) {
      const cur = rows.get(p.documentId);
      if (cur && !p.publishedAt) continue; // la publicada manda sobre el borrador
      rows.set(p.documentId, { productDocumentId: p.documentId, productName: p.productName, bodega: Number(p.stock_central ?? 0), toStock: 0, lots: 0, lotUnits: 0 });
    }
    const phRows = await strapi.db
      .connection(table(UID.pharmacyStock))
      .select(`${col(UID.pharmacyStock, 'pairKey')} as pk`, `${col(UID.pharmacyStock, 'stock')} as stock`);
    for (const r of phRows) {
      const [pid, ph] = String(r.pk ?? '').split('__');
      const row = rows.get(pid);
      if (!row) continue;
      row.bodega -= Number(r.stock ?? 0);
      if (ph === to) row.toStock = Number(r.stock ?? 0);
    }
    const lots = await strapi.db.query(UID.lot).findMany({
      where: { pharmacy: { id: { $null: true } } },
      select: ['currentAmount', 'state'],
      populate: { product: { select: ['documentId'] } },
    });
    for (const l of lots) {
      const row = rows.get(l.product?.documentId);
      if (!row) continue;
      row.lots++;
      if (l.state === 'activo') row.lotUnits += Number(l.currentAmount ?? 0);
    }
    return [...rows.values()];
  }

  /**
   * Pasa a una farmacia todo lo que hay en la bodega: el stock y **todos** sus lotes (cualquier
   * estado, porque físicamente estaban ahí). El total no cambia.
   *
   * Si la farmacia estaba en negativo, esas unidades se vendieron sin lote antes de que los lotes
   * llegaran: se descuentan de los lotes recién movidos (por caducidad), sin pasar de lo que los
   * lotes exceden al stock. Así no aparece un descuadre por cada producto ya vendido.
   *
   * Va por tandas (`limit` productos por transacción) para no pasar el tiempo límite de la
   * petición con miles de productos. No hace falta llave por producto: una segunda corrida
   * encuentra la bodega en 0 y no mueve nada. Con `dryRun` solo devuelve el resumen.
   */
  async function moveAll(input: { to: Loc; dryRun?: boolean; limit?: number; idemKey?: string; user?: any }) {
    const to = input.to;
    if (!to) throw new StockError(400, 'BAD_REQUEST', 'Elige la farmacia destino');
    const ph = await assertPharmacy(to);
    if (ph.estado === 'inactivo') throw new StockError(409, 'PHARMACY_INACTIVE', `${ph.nombre} está inactiva`);

    const snapshot = await bodegaSnapshot(to);
    const pending = snapshot
      .filter((r) => r.bodega > 0 || r.lots > 0)
      .sort((a, b) => a.productDocumentId.localeCompare(b.productDocumentId));
    const negatives = snapshot.filter((r) => r.bodega < 0);
    const summary = {
      pharmacy: { documentId: ph.documentId, nombre: ph.nombre },
      products: pending.length,
      units: pending.reduce((s, r) => s + Math.max(0, r.bodega), 0),
      lots: pending.reduce((s, r) => s + r.lots, 0),
      soldUnlotted: pending.reduce((s, r) => s + Math.max(0, -r.toStock), 0),
      negativeBodega: negatives.length,
      negativeSamples: negatives.slice(0, 20).map((r) => ({ productDocumentId: r.productDocumentId, productName: r.productName, bodega: r.bodega })),
    };
    if (input.dryRun) return { ok: true, dryRun: true, ...summary };

    if (!input.idemKey) throw new StockError(400, 'BAD_REQUEST', 'Falta idemKey');
    const limit = Math.min(Math.max(Number(input.limit) || 100, 1), 300);
    const batch = pending.slice(0, limit);

    const res: any = await runOperation(
      { opKey: `move-all:${input.idemKey}`, kind: 'migration', refType: 'pharmacy', refDocumentId: to, location: `bodega→${label(to)}`, user: input.user, notes: 'Pasar toda la bodega a farmacia' },
      async (tx) => {
        const today = todayMx();
        let units = 0;
        let lotsMoved = 0;
        let soldApplied = 0;
        for (const item of batch) {
          const pid = item.productDocumentId;
          // Bodega bloqueada → sale todo lo positivo; un negativo no se mueve (se reporta).
          let amount = 0;
          await mutateStock(tx, pid, null, (b) => {
            amount = Math.max(0, b);
            return b - amount;
          });
          const { before: toBefore, after: toAfter } = await mutateStock(tx, pid, to, (b) => b + amount);
          units += amount;

          const moved = await lotsAt(tx, pid, null);
          const there = await lotsAt(tx, pid, to);
          for (const lot of moved) {
            await strapi.db.query(UID.lot).update({ where: { id: lot.id }, data: { pharmacy: ph.id } });
            if (lot.currentAmount > 0) {
              recordLot(tx, pid, null, { ...lot, currentAmount: 0 }, -lot.currentAmount);
              recordLot(tx, pid, to, lot, lot.currentAmount);
            }
            lotsMoved++;
          }

          const all = [...there, ...moved];
          const inLots = all.filter((l) => l.state === 'activo').reduce((s, l) => s + l.currentAmount, 0);
          const sold = Math.min(Math.max(0, -toBefore), Math.max(0, inLots - toAfter));
          if (sold > 0) {
            const { portions } = consume(all, sold, null, today);
            portions.forEach((p) => recordLot(tx, pid, to, p.lot, -p.qty));
            await writeLots(tx, pid, to, all);
            soldApplied += portions.reduce((s, p) => s + p.qty, 0);
          }
          if (item.bodega < 0) {
            tx.warnings.push({ code: 'NEGATIVE_BODEGA', productDocumentId: pid, message: `${item.productName}: la bodega estaba en ${item.bodega}; no se movió stock`, stock: item.bodega });
          }
        }
        // Con cientos de productos, releer cada nivel para la respuesta es caro y nadie lo usa.
        tx.touched.clear();
        return { products: batch.length, units, lotsMoved, soldApplied };
      }
    );
    return { ...res, remaining: res.duplicate ? pending.length : pending.length - batch.length };
  }

  /** Niveles de una ubicación para las pantallas de administración y reconciliación. */
  async function levels({ pharmacy }: { pharmacy: Loc }) {
    const loc = pharmacy;
    let minDefault = 5;
    const rows = new Map<string, { productDocumentId: string; productName: string; stock: number; minStock: number | null; lotsSum: number; lotsCount: number }>();

    if (loc === null) {
      const products = await strapi.db.query(UID.product).findMany({
        select: ['documentId', 'productName', 'stock_central', 'publishedAt'],
      });
      for (const p of products) {
        const cur = rows.get(p.documentId);
        // La fila publicada manda sobre el borrador.
        if (cur && !p.publishedAt) continue;
        rows.set(p.documentId, { productDocumentId: p.documentId, productName: p.productName, stock: Number(p.stock_central ?? 0), minStock: null, lotsSum: 0, lotsCount: 0 });
      }
      // La bodega es lo que queda del total después de las farmacias.
      const phRows = await strapi.db
        .connection(table(UID.pharmacyStock))
        .select(`${col(UID.pharmacyStock, 'pairKey')} as pk`, `${col(UID.pharmacyStock, 'stock')} as stock`);
      for (const r of phRows) {
        const pid = String(r.pk ?? '').split('__')[0];
        const row = rows.get(pid);
        if (row) row.stock -= Number(r.stock ?? 0);
      }
    } else {
      const ph = await assertPharmacy(loc);
      const full = await strapi.db.query(UID.pharmacy).findOne({ where: { id: ph.id }, select: ['min_stock_default'] });
      minDefault = Number(full?.min_stock_default ?? 5);
      const stocks = await strapi.db.query(UID.pharmacyStock).findMany({
        where: { pharmacy: { documentId: loc } },
        select: ['stock', 'min_stock'],
        populate: { product: { select: ['documentId', 'productName'] } },
      });
      for (const s of stocks) {
        if (!s.product?.documentId) continue;
        rows.set(s.product.documentId, {
          productDocumentId: s.product.documentId,
          productName: s.product.productName,
          stock: Number(s.stock ?? 0),
          minStock: s.min_stock ?? null,
          lotsSum: 0,
          lotsCount: 0,
        });
      }
    }

    const lots = await strapi.db.query(UID.lot).findMany({
      where: { state: 'activo', pharmacy: loc ? { documentId: loc } : { id: { $null: true } } },
      select: ['currentAmount'],
      populate: { product: { select: ['documentId', 'productName'] } },
    });
    for (const l of lots) {
      const pid = l.product?.documentId;
      if (!pid) continue;
      const r = rows.get(pid) ?? { productDocumentId: pid, productName: l.product.productName, stock: 0, minStock: null, lotsSum: 0, lotsCount: 0 };
      r.lotsSum += Number(l.currentAmount ?? 0);
      r.lotsCount++;
      rows.set(pid, r);
    }

    return { location: label(loc), minStockDefault: minDefault, items: [...rows.values()] };
  }

  return {
    sale,
    saleReturn,
    purchase,
    transfer,
    adjust,
    count,
    discard,
    moveAll,
    levels,
  };
};
