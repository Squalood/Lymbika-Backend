/**
 * Campos derivados de la ficha clínica del producto.
 *
 * `sal` y `conReceta` son anteriores a la ficha estructurada y los siguen leyendo la
 * búsqueda y la tarjeta del frontend, la búsqueda del POS y el CSV. En vez de migrar a
 * todos esos consumidores, se calculan a partir de la ficha cuando hay datos:
 *
 * - `sal`       ← `composicion` ("Naproxeno sódico 275 mg, Paracetamol 300 mg"). Solo si
 *                 hay al menos un renglón con principio activo; si no, el texto capturado a
 *                 mano se respeta (cosméticos y dispositivos describen ahí sus ingredientes).
 * - `conReceta` ← `fraccion` COFEPRIS: I–IV requieren receta, V–VI son de venta libre.
 *                 Solo si la fracción está capturada.
 *
 * Así la migración es gradual: un producto sin ficha se comporta exactamente como antes.
 *
 * Se calcula por fila (borrador y publicada por separado), porque cada una tiene su propia
 * composición, y se escribe por SQL sobre el `id`, igual que `stock_central`: pasar por el
 * Document Service volvería a disparar este middleware y re-publicaría el borrador.
 *
 * Regla para el pre-llenado con IA (scripts/prellenar-fichas.js): solo llena campos vacíos de
 * fichas sin revisar, marca `fuenteInfo = ia` y nunca toca una ficha `revisada`.
 *
 * Nunca lanza: un `sal` desactualizado se corrige al volver a guardar el producto, pero
 * tumbar el guardado no.
 */

const UID = 'api::product.product';

// Acciones del Document Service que pueden cambiar la composición o la fracción de una fila.
// `clone` no hace falta: copia la fila de origen con sus derivados ya calculados.
const ACCIONES = new Set(['create', 'update', 'publish', 'discardDraft']);

const FRACCIONES_CON_RECETA = new Set(['I', 'II', 'III', 'IV']);

const ETIQUETA_UNIDAD: Record<string, string> = { porcentaje: '%' };

// ── Cálculo ──────────────────────────────────────────────────────────────────

function numero(valor: unknown): string | null {
  if (valor === null || valor === undefined || valor === '') return null;
  const n = Number(valor);
  // String(Number(x)) quita los ceros de sobra que trae el decimal ("10.000" → "10").
  return Number.isFinite(n) ? String(n) : null;
}

function cantidadConUnidad(cantidad: unknown, unidad: string | null): string {
  const n = numero(cantidad);
  if (!n) return unidad ? (ETIQUETA_UNIDAD[unidad] ?? unidad) : '';
  if (!unidad) return n;
  const etiqueta = ETIQUETA_UNIDAD[unidad];
  return etiqueta ? `${n}${etiqueta}` : `${n} ${unidad}`;
}

/** "Paracetamol 250 mg / 5 ml". Lo usa también el export CSV, que lo vuelve a leer al importar. */
export function renglonDeSal(renglon: any): string | null {
  const nombre = renglon?.principioActivo?.nombre?.trim();
  if (!nombre) return null;
  const dosis = cantidadConUnidad(renglon.cantidad, renglon.unidad ?? null);
  const por = renglon.porUnidad ? cantidadConUnidad(renglon.porCantidad, renglon.porUnidad) : '';
  return [nombre, dosis, por && `/ ${por}`].filter(Boolean).join(' ');
}

/** Devuelve solo los campos que hay que cambiar en la fila (vacío si nada cambia). */
function derivar(fila: any): Record<string, unknown> {
  const cambios: Record<string, unknown> = {};

  const renglones = (fila.composicion ?? []).map(renglonDeSal).filter(Boolean);
  if (renglones.length) {
    const sal = renglones.join(', ');
    if (sal !== fila.sal) cambios.sal = sal;
  }

  if (fila.fraccion) {
    const conReceta = FRACCIONES_CON_RECETA.has(fila.fraccion);
    if (conReceta !== fila.conReceta) cambios.conReceta = conReceta;
  }

  return cambios;
}

// ── Escritura ────────────────────────────────────────────────────────────────

async function actualizarDerivados(strapi: any, documentId: string) {
  const meta = strapi.db.metadata.get(UID);

  // Reutiliza la transacción del llamador si la hay: escribir por fuera esperaría el
  // candado que esa misma transacción tiene sobre la fila.
  await strapi.db.transaction(async ({ trx }) => {
    const filas = await strapi.db.query(UID).findMany({
      where: { documentId },
      select: ['id', 'sal', 'conReceta', 'fraccion'],
      populate: { composicion: { populate: { principioActivo: { select: ['nombre'] } } } },
    });

    for (const fila of filas) {
      const cambios = derivar(fila);
      if (!Object.keys(cambios).length) continue;

      const columnas = Object.fromEntries(
        Object.entries(cambios).map(([campo, valor]) => [meta.attributes[campo].columnName, valor])
      );
      await strapi.db.connection(meta.tableName).transacting(trx).where('id', fila.id).update(columnas);
    }
  });
}

// ── Middleware ───────────────────────────────────────────────────────────────

export function registrarDerivadosDeFicha(strapi: any) {
  strapi.documents.use(async (ctx, next) => {
    const resultado = await next();
    if (ctx.uid !== UID || !ACCIONES.has(ctx.action)) return resultado;

    const documentId = (ctx.params as any)?.documentId ?? (resultado as any)?.documentId;
    if (!documentId) return resultado;

    try {
      await actualizarDerivados(strapi, documentId);
    } catch (error) {
      strapi.log.error(`[product] no se pudieron derivar sal/conReceta de ${documentId}: ${error.message}`);
    }
    return resultado;
  });
}
