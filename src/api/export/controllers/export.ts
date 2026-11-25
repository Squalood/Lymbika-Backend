import { renglonDeSal } from '../../product/utils/derivar-ficha';

/**
 * Export / import de productos en CSV (se abre y se guarda con Excel).
 *
 * Reglas del import (`POST /export/products/import`):
 * - Columna ausente o celda vacía = no se cambia ese campo. Así un CSV con solo
 *   `documentId,price` actualiza precios sin tocar nada más. Para borrar un valor se
 *   escribe `-`.
 * - Cada fila se valida completa antes de escribir: si algo no se reconoce (categoría,
 *   principio activo, valor de una lista), la fila entera se salta y se reporta. No hay
 *   filas a medias.
 * - `?dryRun=true` valida todo y devuelve el mismo reporte sin escribir nada.
 * - `stock_central` se exporta como referencia pero **no se importa**: el stock solo se
 *   mueve con compras, ajustes y conteos del POS (/pos-stock), que mantienen cuadradas
 *   la bodega y las farmacias.
 * - `sal` y `conReceta` se derivan de `composicion` y `fraccion` cuando el producto tiene
 *   ficha (ver product/utils/derivar-ficha.ts); en ese caso el valor del CSV se recalcula.
 * - `status = published` publica el producto después de actualizarlo; `draft` o vacío
 *   solo actualiza el borrador (no despublica).
 *
 * Formatos de las columnas de la ficha:
 * - `composicion`: renglones separados por `;` → "Paracetamol 250 mg / 5 ml; Cafeína 65 mg".
 *   El principio activo se busca por nombre o sinónimo y tiene que existir en el admin,
 *   salvo con `?crearFaltantes=true` (ver prepararFaltantes).
 * - `indicaciones`: nombres separados por `;`, tienen que existir (o `?crearFaltantes=true`).
 *
 * `GET /export/products/:documentId/prompt` arma el prompt para llenar la ficha de UN
 * producto con ChatGPT/Claude y regresar un CSV de una fila (ver fichaPrompt).
 * - Listas (forma, vía, fracción…): se acepta el valor sin importar mayúsculas, acentos
 *   ni espacios ("Solución oral" = `solucionOral`).
 */

const UID = 'api::product.product';

// ── Columnas ─────────────────────────────────────────────────────────────────

const CSV_FIELDS = [
  'documentId', 'productName', 'sku', 'barCode',
  'price', 'priceMember', 'priceInpatient', 'stock_central',
  'active', 'isFeatured', 'conReceta',
  'drug_type', 'sal', 'category', 'laboratorio', 'status',
  // Ficha clínica (docs/ficha-clinica-productos.md)
  'tipoProducto', 'composicion', 'formaFarmaceutica', 'viaAdministracion',
  'contenidoCantidad', 'contenidoUnidad', 'fraccion', 'edadMinimaMeses', 'indicaciones',
  'posologia', 'advertenciasAdicionales', 'registroSanitario',
  'requiereRefrigeracion', 'sinAzucar', 'fuenteInfo', 'estadoFicha', 'revisadoPor', 'fechaRevision',
];

// Columnas con tratamiento propio en el import; el resto se lee según el tipo del schema.
const SOLO_EXPORT = new Set(['stock_central']);
const ESPECIALES = new Set(['documentId', 'status', 'category', 'laboratorio', 'composicion', 'indicaciones']);

const BORRAR = '-';

// Excel solo detecta UTF-8 (acentos) si el archivo empieza con BOM.
const BOM = '﻿';

// ── CSV ──────────────────────────────────────────────────────────────────────

function escapeCsv(val: unknown): string {
  if (val === null || val === undefined) return '';
  const str = String(val);
  // ";" también va entre comillas: composición e indicaciones lo usan dentro del valor, y
  // así el archivo sigue siendo válido si un Excel con separador ";" lo vuelve a guardar.
  if (/[",;\r\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

/**
 * Parser de CSV carácter por carácter. Tiene que respetar saltos de línea dentro de
 * comillas: `sal` y `posologia` los traen, y partir por renglones primero corría las
 * columnas de todo lo que seguía. Acepta "," o ";" como separador.
 */
function parseCSV(text: string): Record<string, string>[] {
  const filas: string[][] = [];
  let fila: string[] = [];
  let celda = '';
  let enComillas = false;
  // Excel escribe \r\n también dentro de las celdas; se guardan como \n.
  const src = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  // Excel separa con ";" cuando la configuración regional de Windows usa coma decimal
  // (España, por ejemplo). El encabezado no lleva comillas, así que basta contar ahí.
  const encabezado = src.slice(0, src.indexOf('\n') === -1 ? undefined : src.indexOf('\n'));
  const sep = (encabezado.match(/;/g)?.length ?? 0) > (encabezado.match(/,/g)?.length ?? 0) ? ';' : ',';

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (enComillas) {
      if (c === '"' && src[i + 1] === '"') { celda += '"'; i++; }
      else if (c === '"') enComillas = false;
      else celda += c;
    } else if (c === '"') enComillas = true;
    else if (c === sep) { fila.push(celda); celda = ''; }
    else if (c === '\n') {
      fila.push(celda); filas.push(fila); fila = []; celda = '';
    } else celda += c;
  }
  if (celda !== '' || fila.length) { fila.push(celda); filas.push(fila); }

  const utiles = filas.filter((f) => f.some((v) => v.trim() !== ''));
  if (utiles.length < 2) return [];
  const headers = utiles[0].map((h) => h.trim());
  return utiles.slice(1).map((valores) =>
    Object.fromEntries(headers.map((h, i) => [h, (valores[i] ?? '').trim()]))
  );
}

// ── Normalización y parsers ──────────────────────────────────────────────────

/** Para comparar sin mayúsculas, acentos ni espacios: "Solución oral" → "solucionoral". */
function clave(val: string): string {
  return val.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[\s_\-.]+/g, '');
}

function parseDecimal(val: string): number | null {
  const n = Number(val.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

// Acepta true/false en inglés, VERDADERO/FALSO de Excel en español y sí/no.
function parseBool(val: string): boolean | null {
  const v = clave(val);
  if (['true', 'verdadero', 'si', '1'].includes(v)) return true;
  if (['false', 'falso', 'no', '0'].includes(v)) return false;
  return null;
}

// AAAA-MM-DD o DD/MM/AAAA (como lo guarda Excel en es-MX).
function parseFecha(val: string): string | null {
  let m = val.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  let [a, mes, d] = m ? [m[1], m[2], m[3]] : [];
  if (!m) {
    m = val.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (m) [d, mes, a] = [m[1], m[2], m[3]];
  }
  if (!m) return null;
  const iso = `${a}-${mes.padStart(2, '0')}-${d.padStart(2, '0')}`;
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

// Sinónimos en español para valores de listas existentes.
const ALIAS_ENUM: Record<string, Record<string, string>> = {
  drug_type: { generico: 'generic', marca: 'branded', brand: 'branded' },
};

function parseEnum(campo: string, val: string, opciones: string[]): string | null {
  const k = clave(val);
  return opciones.find((o) => clave(o) === k) ?? ALIAS_ENUM[campo]?.[k] ?? null;
}

// ── Composición ──────────────────────────────────────────────────────────────

const UNIDADES: Record<string, string> = {
  mg: 'mg', g: 'g', mcg: 'mcg', µg: 'mcg', ug: 'mcg', ui: 'UI', meq: 'mEq', ufc: 'UFC',
  ml: 'ml', '%': 'porcentaje', porcentaje: 'porcentaje',
};
const UNIDADES_POR: Record<string, string> = { ml: 'ml', g: 'g', dosis: 'dosis', gota: 'gota', gotas: 'gota' };

// "Paracetamol 250 mg / 5 ml", "Óxido de zinc 1.5%", "Vitamina B12 1000 mcg", "Omega 3".
const RENGLON = /^(.*?)\s+(\d+(?:[.,]\d+)?)\s*(mg|g|mcg|µg|ug|ui|meq|ufc|ml|%|porcentaje)\s*(?:\/\s*(\d+(?:[.,]\d+)?)?\s*(ml|g|dosis|gotas?))?$/i;

/** Renglones de una celda de composición, con el nombre ya separado de la dosis. */
function renglonesDeComposicion(val: string) {
  return val.split(/[;\n]/).map((p) => p.trim()).filter(Boolean).map((parte) => {
    const m = parte.match(RENGLON);
    return { m, nombre: m ? m[1].trim() : parte };
  });
}

const nombresDeIndicaciones = (val: string) => val.split(/[;\n]/).map((n) => n.trim()).filter(Boolean);

function parseComposicion(val: string, principios: Map<string, string>, errores: string[]) {
  const renglones = [];
  for (const { m, nombre } of renglonesDeComposicion(val)) {
    const documentId = principios.get(clave(nombre));
    if (!documentId) {
      errores.push(`principio activo "${nombre}" no existe (créalo en el admin o agrégalo como sinónimo)`);
      continue;
    }
    renglones.push({
      principioActivo: documentId,
      cantidad: m ? parseDecimal(m[2]) : null,
      unidad: m ? UNIDADES[m[3].toLowerCase()] : null,
      porCantidad: m?.[4] ? parseDecimal(m[4]) : null,
      porUnidad: m?.[5] ? UNIDADES_POR[m[5].toLowerCase()] : null,
    });
  }
  return renglones;
}

// ── Catálogos para resolver nombres ──────────────────────────────────────────

async function cargarCatalogos() {
  const [categorias, laboratorios, principios, indicaciones, productos] = await Promise.all([
    strapi.documents('api::category.category').findMany({ fields: ['categoryName'], status: 'draft' }),
    strapi.documents('api::laboratorio.laboratorio').findMany({ fields: ['name'], status: 'draft' }),
    strapi.documents('api::principio-activo.principio-activo').findMany({ fields: ['nombre', 'sinonimos'] }),
    strapi.documents('api::indicacion.indicacion').findMany({ fields: ['nombre'] }),
    strapi.documents(UID).findMany({ fields: ['documentId'], status: 'draft' }),
  ]);

  const porNombre = (items: any[], campo: string) =>
    new Map(items.filter((i) => i[campo]).map((i) => [clave(i[campo]), i.documentId]));

  // Los principios activos también se encuentran por sinónimo ("acetaminofén" → Paracetamol).
  // El nombre gana si choca con el sinónimo de otro.
  const mapaPrincipios = new Map<string, string>();
  for (const p of principios as any[]) {
    for (const s of (p.sinonimos ?? '').split(/[,;\n]/).map((x: string) => x.trim()).filter(Boolean)) {
      if (!mapaPrincipios.has(clave(s))) mapaPrincipios.set(clave(s), p.documentId);
    }
  }
  for (const p of principios as any[]) mapaPrincipios.set(clave(p.nombre), p.documentId);

  return {
    categorias: porNombre(categorias, 'categoryName'),
    laboratorios: porNombre(laboratorios, 'name'),
    principios: mapaPrincipios,
    indicaciones: porNombre(indicaciones, 'nombre'),
    productos: new Set((productos as any[]).map((p) => p.documentId)),
  };
}

// ── Principios activos e indicaciones que faltan ─────────────────────────────

/** "Óxido de zinc" → "oxido-de-zinc". Los creados por API no reciben el uid que pone el admin. */
const slugDe = (nombre: string) =>
  nombre.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/**
 * Con `?crearFaltantes=true`, los principios activos e indicaciones que el CSV nombra y no
 * existen se crean solo con el nombre (`estadoFicha = pendiente`; la información clínica se
 * llena después). Pensado para dar de alta productos nuevos uno por uno.
 *
 * Se hace antes de procesar las filas para que todas los encuentren. En simulación no se crea
 * nada: se registran con un id provisional y se reporta qué se crearía, para que un error de
 * dedo ("Loratdina") se vea antes de confirmar.
 */
async function prepararFaltantes(rows: Record<string, string>[], catalogos: any, dryRun: boolean) {
  const faltan = { principios: new Map<string, string>(), indicaciones: new Map<string, string>() };
  // Si el mismo nombre viene escrito de dos formas ("Picazón" / "picazon"), se crea con la
  // primera, que suele ser la bien escrita.
  const anotar = (mapa: Map<string, string>, existentes: Map<string, string>, nombre: string) => {
    const k = clave(nombre);
    if (!existentes.has(k) && !mapa.has(k)) mapa.set(k, nombre);
  };
  for (const row of rows) {
    if (row.composicion && row.composicion !== BORRAR) {
      for (const { nombre } of renglonesDeComposicion(row.composicion)) anotar(faltan.principios, catalogos.principios, nombre);
    }
    if (row.indicaciones && row.indicaciones !== BORRAR) {
      for (const nombre of nombresDeIndicaciones(row.indicaciones)) anotar(faltan.indicaciones, catalogos.indicaciones, nombre);
    }
  }

  const crear = async (uid: string, mapa: Map<string, string>, k: string, nombre: string) => {
    if (dryRun) return mapa.set(k, `nuevo:${k}`);
    const doc = await strapi.documents(uid as any).create({ data: { nombre, slug: slugDe(nombre) } as any });
    mapa.set(k, doc.documentId);
  };
  for (const [k, nombre] of faltan.principios) await crear('api::principio-activo.principio-activo', catalogos.principios, k, nombre);
  for (const [k, nombre] of faltan.indicaciones) await crear('api::indicacion.indicacion', catalogos.indicaciones, k, nombre);

  return { principiosActivos: [...faltan.principios.values()], indicaciones: [...faltan.indicaciones.values()] };
}

// ── Fila → data ──────────────────────────────────────────────────────────────

function datosDeFila(row: Record<string, string>, catalogos: any, attrs: any) {
  const data: Record<string, unknown> = {};
  const errores: string[] = [];

  for (const [campo, valor] of Object.entries(row)) {
    if (valor === '' || SOLO_EXPORT.has(campo) || ESPECIALES.has(campo) || !attrs[campo]) continue;
    const attr = attrs[campo];

    if (valor === BORRAR) {
      if (campo === 'productName') errores.push('productName no se puede borrar');
      else data[campo] = null;
      continue;
    }

    switch (attr.type) {
      case 'string':
      case 'text':
        data[campo] = valor;
        break;
      case 'decimal': {
        const n = parseDecimal(valor);
        if (n === null) errores.push(`${campo}: "${valor}" no es un número`);
        else data[campo] = n;
        break;
      }
      case 'integer': {
        if (!/^\d+$/.test(valor)) errores.push(`${campo}: "${valor}" no es un entero`);
        else data[campo] = parseInt(valor, 10);
        break;
      }
      case 'boolean': {
        const b = parseBool(valor);
        if (b === null) errores.push(`${campo}: "${valor}" no es verdadero/falso`);
        else data[campo] = b;
        break;
      }
      case 'enumeration': {
        const e = parseEnum(campo, valor, attr.enum);
        if (e === null) errores.push(`${campo}: "${valor}" no es válido (opciones: ${attr.enum.join(', ')})`);
        else data[campo] = e;
        break;
      }
      case 'date': {
        const f = parseFecha(valor);
        if (f === null) errores.push(`${campo}: "${valor}" no es fecha (AAAA-MM-DD o DD/MM/AAAA)`);
        else data[campo] = f;
        break;
      }
      default:
        errores.push(`${campo}: no se puede importar`);
    }
  }

  // Relaciones por nombre
  const relaciones: [string, Map<string, string>, string][] = [
    ['category', catalogos.categorias, 'categoría'],
    ['laboratorio', catalogos.laboratorios, 'laboratorio'],
  ];
  for (const [campo, mapa, etiqueta] of relaciones) {
    const valor = row[campo];
    if (!valor) continue;
    if (valor === BORRAR) { data[campo] = { set: [] }; continue; }
    const documentId = mapa.get(clave(valor));
    if (documentId) data[campo] = documentId;
    else errores.push(`${etiqueta} "${valor}" no existe`);
  }

  if (row.composicion) {
    data.composicion = row.composicion === BORRAR
      ? []
      : parseComposicion(row.composicion, catalogos.principios, errores);
  }

  if (row.indicaciones) {
    if (row.indicaciones === BORRAR) data.indicaciones = { set: [] };
    else {
      const ids = [];
      for (const nombre of nombresDeIndicaciones(row.indicaciones)) {
        const documentId = catalogos.indicaciones.get(clave(nombre));
        if (documentId) ids.push(documentId);
        else errores.push(`indicación "${nombre}" no existe`);
      }
      data.indicaciones = ids;
    }
  }

  return { data, errores };
}

// ── Prompt de ficha (alta de un producto con ChatGPT/Claude) ─────────────────

// Columnas que pide el prompt, en el orden del CSV que debe devolver la IA.
const COLUMNAS_PROMPT = [
  'documentId', 'tipoProducto', 'composicion', 'formaFarmaceutica', 'viaAdministracion',
  'contenidoCantidad', 'contenidoUnidad', 'fraccion', 'edadMinimaMeses', 'indicaciones', 'posologia',
  'advertenciasAdicionales', 'registroSanitario', 'requiereRefrigeracion', 'sinAzucar',
  'fuenteInfo', 'estadoFicha', 'status',
];

const vacio = (v: unknown) => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);

/**
 * Texto para pegar en ChatGPT/Claude (con fotos del empaque, idealmente) que regresa la ficha
 * de UN producto como CSV de una fila, listo para el botón "Importar CSV" del POS. Los valores
 * permitidos salen del schema y los nombres de principios activos/indicaciones de la BD, así
 * el prompt nunca queda desactualizado.
 */
function armarPrompt(p: any, attrs: any, comp: any, principios: string[], indicaciones: string[]) {
  const opciones = (a: any) => a.enum.join(', ');
  const valorActual = (c: string) => {
    if (c === 'composicion') return (p.composicion ?? []).map(renglonDeSal).filter(Boolean).join('; ');
    if (c === 'indicaciones') return (p.indicaciones ?? []).map((i: any) => i.nombre).join('; ');
    return p[c];
  };
  const capturados = COLUMNAS_PROMPT
    .filter((c) => !['documentId', 'fuenteInfo', 'estadoFicha', 'status'].includes(c) && !vacio(valorActual(c)))
    .map((c) => `- ${c}: ${valorActual(c)}`);

  return `Eres farmacéutico en México y vas a llenar la ficha de UN producto de la farmacia en línea Lymbika. Responde SOLO con un bloque de código CSV (encabezado + una fila), sin texto fuera del bloque.
${p.estadoFicha === 'revisada' ? '\nATENCIÓN: esta ficha ya fue revisada por un farmacéutico. Solo llena lo que falte.\n' : ''}
## Producto
- documentId: ${p.documentId}
- Nombre: ${p.productName?.trim()}
- Sustancia capturada a mano (puede tener errores): ${p.sal?.trim() || '(vacío)'}
- Categoría: ${p.category?.categoryName ?? '(sin categoría)'}
- Laboratorio: ${p.laboratorio?.name ?? '(sin laboratorio)'}

## Fuente de información
Si te adjunté fotos del empaque o del instructivo, son la fuente principal: copia de ahí dosis, contenido, edad, registro sanitario y si dice "requiere receta". Pon fuenteInfo = empaque (o ipp si usaste el instructivo). Sin fotos, usa lo que sepas del producto y pon fuenteInfo = ia. No inventes: si no sabes un dato, deja la celda vacía.
${capturados.length ? `\n## Ya capturado (deja esas celdas VACÍAS para no cambiarlas)\n${capturados.join('\n')}\n` : ''}
## Columnas, en este orden
${COLUMNAS_PROMPT.join(',')}

- documentId: copia exactamente ${p.documentId}
- tipoProducto: uno de ${opciones(attrs.tipoProducto)}. (medicamento: tiene registro de medicamento; suplemento: vitaminas, proteína, electrolitos, probióticos; dermocosmetico: cremas, protector solar; dispositivoMedico: jeringas, condones, pruebas, material de curación; higienePersonal: pasta dental, toallitas)
- composicion: solo principios activos de medicamentos y suplementos, separados por "; ". Formato "Nombre cantidad unidad", y en líquidos o cremas "Nombre cantidad unidad / cantidad unidad" (ej. "Paracetamol 250 mg / 5 ml; Clorfenamina 2 mg"). Unidades: ${opciones(comp.unidad).replace('porcentaje', '%')}; después de "/": ${opciones(comp.porUnidad)}. Nombre genérico en español con su sal si la lleva ("Naproxeno sódico"). Si la cantidad pasa de 99,999,999 (probióticos en UFC), escribe solo el nombre. Vacía en cosméticos, dispositivos e higiene.
- formaFarmaceutica: uno de ${opciones(attrs.formaFarmaceutica)}
- viaAdministracion: uno de ${opciones(attrs.viaAdministracion)}
- contenidoCantidad y contenidoUnidad: lo que trae el empaque ("caja con 20 tabletas" = 20 y tabletas). Unidad: uno de ${opciones(attrs.contenidoUnidad)}
- fraccion: fracción COFEPRIS, solo medicamentos: ${opciones(attrs.fraccion)}. I–III controlados, IV con receta (antibióticos incluidos), V sin receta solo en farmacias, VI sin receta en cualquier tienda. Si el empaque dice "su venta requiere receta médica" es IV o menor. Si dudas, deja la celda vacía.
- edadMinimaMeses: edad mínima de uso de ESTA presentación, en meses (12 años = 144). Vacía si no aplica o no lo sabes.
- indicaciones: 1 a 3 padecimientos o usos, separados por "; ". Usa EXACTAMENTE un nombre de la lista de abajo si alguno corresponde; si ninguno, uno nuevo corto en español con mayúscula inicial.
- posologia y registroSanitario: SOLO si los lees en el empaque o el instructivo; si no, vacíos.
- advertenciasAdicionales: solo algo propio de este producto (un excipiente como tartrazina o azúcar), si no, vacía.
- requiereRefrigeracion y sinAzucar: true o false; vacío si no aplica.
- fuenteInfo: empaque, ipp o ia (ver arriba).
- estadoFicha: ${p.estadoFicha === 'revisada' ? 'déjalo vacío (la ficha ya está revisada)' : 'pendiente'}
- status: published

CSV: separado por comas. Si una celda tiene comas, punto y coma o saltos de línea, enciérrala entre comillas dobles.

## Principios activos que ya existen (usa estos nombres exactos cuando correspondan)
${principios.join('; ') || '(ninguno)'}

## Indicaciones que ya existen
${indicaciones.join('; ') || '(ninguna)'}
`;
}

// ── Controller ───────────────────────────────────────────────────────────────

export default {
  // GET /api/export/products
  async exportProducts(ctx: any) {
    const [products, publishedProducts] = await Promise.all([
      strapi.documents(UID).findMany({
        populate: {
          category: true,
          laboratorio: true,
          composicion: { populate: { principioActivo: { fields: ['nombre'] } } },
          indicaciones: { fields: ['nombre'] },
        },
        status: 'draft',
      }),
      strapi.documents(UID).findMany({ fields: ['documentId'], status: 'published' }),
    ]);

    const publicados = new Set(publishedProducts.map((p: any) => p.documentId));

    const filas = products.map((p: any) =>
      CSV_FIELDS.map((campo) => {
        switch (campo) {
          case 'category': return escapeCsv(p.category?.categoryName);
          case 'laboratorio': return escapeCsv(p.laboratorio?.name);
          case 'status': return publicados.has(p.documentId) ? 'published' : 'draft';
          case 'composicion': return escapeCsv((p.composicion ?? []).map(renglonDeSal).filter(Boolean).join('; '));
          case 'indicaciones': return escapeCsv((p.indicaciones ?? []).map((i: any) => i.nombre).join('; '));
          default: return escapeCsv(p[campo]);
        }
      }).join(',')
    );

    ctx.set('Content-Type', 'text/csv; charset=utf-8');
    ctx.set('Content-Disposition', 'attachment; filename="productos.csv"');
    ctx.body = BOM + [CSV_FIELDS.join(','), ...filas].join('\r\n');
  },

  // POST /api/export/products/import[?dryRun=true]
  // Acepta multipart/form-data con campo "file" (archivo .csv)
  // o JSON con campo "csv" (string con el contenido del CSV).
  async importProducts(ctx: any) {
    let csvContent = '';

    const file = ctx.request.files?.file;
    if (file) {
      const fs = require('fs');
      csvContent = fs.readFileSync(file.filepath ?? file.path, 'utf-8');
    } else {
      const { csv } = ctx.request.body as { csv?: string };
      if (!csv || typeof csv !== 'string') {
        return ctx.badRequest('Envía un archivo CSV en el campo "file" o un JSON con el campo "csv"');
      }
      csvContent = csv;
    }

    const rows = parseCSV(csvContent);
    if (rows.length === 0) {
      return ctx.badRequest('El CSV está vacío o no tiene filas válidas');
    }

    const dryRun = String(ctx.query?.dryRun ?? '') === 'true';
    const attrs = strapi.contentType(UID).attributes as any;
    const catalogos = await cargarCatalogos();
    const results = { created: 0, updated: 0, published: 0, errors: [] as string[], warnings: [] as string[] };
    const newCatalogEntries = String(ctx.query?.crearFaltantes ?? '') === 'true'
      ? await prepararFaltantes(rows, catalogos, dryRun)
      : { principiosActivos: [] as string[], indicaciones: [] as string[] };

    const columnas = Object.keys(rows[0]);
    const desconocidas = columnas.filter((c) => !attrs[c] && !ESPECIALES.has(c) && !SOLO_EXPORT.has(c));
    if (desconocidas.length) results.warnings.push(`Columnas desconocidas, se ignoraron: ${desconocidas.join(', ')}`);
    if (columnas.includes('stock_central')) {
      results.warnings.push('stock_central no se importa: el stock se mueve con compras, ajustes y conteos del POS');
    }

    for (const [i, row] of rows.entries()) {
      // +2: la fila 1 es el encabezado y Excel numera desde 1.
      const etiqueta = `Fila ${i + 2} (${row.productName || row.documentId || 'sin nombre'})`;
      const { data, errores } = datosDeFila(row, catalogos, attrs);

      if (row.documentId && !catalogos.productos.has(row.documentId)) {
        errores.push(`documentId "${row.documentId}" no existe`);
      }
      if (!row.documentId && !data.productName) errores.push('producto nuevo sin productName');
      if (row.status && !['published', 'draft'].includes(row.status)) {
        errores.push(`status "${row.status}" no es válido (published o draft)`);
      }
      if (errores.length) {
        results.errors.push(`${etiqueta}: ${errores.join('; ')}`);
        continue;
      }

      const publicar = row.status === 'published';
      if (dryRun) {
        if (row.documentId) results.updated++; else results.created++;
        if (publicar) results.published++;
        continue;
      }

      try {
        let documentId = row.documentId;
        if (documentId) {
          await strapi.documents(UID).update({ documentId, data: data as any });
          results.updated++;
        } else {
          documentId = (await strapi.documents(UID).create({ data: data as any })).documentId;
          results.created++;
        }
        if (publicar) {
          await strapi.documents(UID).publish({ documentId });
          results.published++;
        }
      } catch (err: any) {
        results.errors.push(`${etiqueta}: ${err.message}`);
      }
    }

    ctx.body = {
      message: dryRun ? 'Simulación completada: no se escribió nada' : 'Importación completada',
      dryRun,
      ...results,
      // En simulación: los que se crearían. Al importar: los que se crearon.
      newCatalogEntries,
    };
  },

  // GET /api/export/products/:documentId/prompt
  async fichaPrompt(ctx: any) {
    const { documentId } = ctx.params;
    const [producto, principios, indicaciones] = await Promise.all([
      // El borrador: es lo último que se capturó, aunque no esté publicado.
      strapi.documents(UID).findOne({
        documentId,
        status: 'draft',
        populate: {
          category: { fields: ['categoryName'] },
          laboratorio: { fields: ['name'] },
          composicion: { populate: { principioActivo: { fields: ['nombre'] } } },
          indicaciones: { fields: ['nombre'] },
        },
      }),
      strapi.documents('api::principio-activo.principio-activo').findMany({ fields: ['nombre'], sort: 'nombre:asc' }),
      strapi.documents('api::indicacion.indicacion').findMany({ fields: ['nombre'], sort: 'nombre:asc' }),
    ]);
    if (!producto) return ctx.notFound('Producto no encontrado');

    ctx.set('Content-Type', 'text/plain; charset=utf-8');
    ctx.body = armarPrompt(
      producto,
      strapi.contentType(UID).attributes,
      strapi.components['producto.composicion'].attributes,
      (principios as any[]).map((x) => x.nombre),
      (indicaciones as any[]).map((x) => x.nombre),
    );
  },

  // POST /api/export/products/reset-stock
  async resetStock(ctx: any) {
    const count = await strapi.db.query(UID).updateMany({
      where: {},
      data: { stock_central: 0 },
    });

    ctx.body = {
      message: `Stock reseteado a 0`,
      updated: count.count,
    };
  },
};
