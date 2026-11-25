#!/usr/bin/env node
/**
 * Pre-llenado de la ficha clínica con IA (Claude). Ver docs/ficha-clinica-productos.md §4 y §5.5.
 *
 * Propone datos; no escribe nada en la tienda por su cuenta. El flujo es:
 *
 *   1. productos   Lee el catálogo (API pública) y pide a Claude, producto por producto, tipo,
 *                  composición, forma, vía, contenido, fracción, edad mínima e indicaciones.
 *   2. catalogos   Con lo anterior, propone la información clínica de cada principio activo
 *                  nuevo y unifica las indicaciones (sinónimos, señales de alarma, especialidad).
 *   3. csv         Arma tres CSV para revisar en Excel: productos.csv (formato del import del
 *                  POS), principios-activos.csv e indicaciones.csv.
 *   4. aplicar-catalogos   Crea en Strapi los principios activos e indicaciones de los CSV ya
 *                  revisados. Sin --confirmar solo muestra lo que haría.
 *   5. Importar productos.csv con el botón "Importar CSV" del POS (revisa antes de guardar).
 *
 * Reglas que no se rompen (también en el encabezado de src/api/product/utils/derivar-ficha.ts):
 * - Solo se llenan campos vacíos. Nada capturado a mano se sobrescribe.
 * - Nunca se toca una ficha `revisada` (producto, principio activo ni indicación).
 * - Todo lo generado queda con `fuenteInfo = ia` y `estadoFicha = pendiente`.
 * - La IA no propone posología ni registro sanitario: tienen que salir del prospecto/empaque.
 * - Si hoy un producto está marcado con receta y la IA propone fracción V/VI (venta libre), no se
 *   llena la fracción: eso liberaría la venta en línea sin que nadie lo revise.
 *
 * Los pasos 1 y 2 cuestan dinero (API de Anthropic) y guardan su avance en scripts/prellenado/,
 * así que se pueden interrumpir y retomar sin pagar dos veces lo ya hecho.
 *
 * Variables (.env): ANTHROPIC_API_KEY (pasos 1-2), LYMBIKA_API_URL (default: producción),
 * LYMBIKA_API_TOKEN (solo paso 4: token Custom con find/create/update de principio-activo e
 * indicacion; nunca en una variable NEXT_PUBLIC).
 *
 * Uso:
 *   node scripts/prellenar-fichas.js productos --ids id1,id2      # productos específicos
 *   node scripts/prellenar-fichas.js productos --buscar loratadina --limite 5
 *   node scripts/prellenar-fichas.js productos --limite 50          # los siguientes 50 sin proponer
 *   node scripts/prellenar-fichas.js productos --con-stock --tipo "Dolor y Fiebre,Gripe y Tos" --estimar
 *       --con-stock: solo activos con stock · --tipo: por la clasificación anterior (campo `tipo`)
 *       --estimar: dice cuántos productos y cuánto costaría, sin llamar a la IA
 *   node scripts/prellenar-fichas.js catalogos
 *   node scripts/prellenar-fichas.js csv
 *   node scripts/prellenar-fichas.js aplicar-catalogos [--confirmar]
 */

const fs = require('fs');
const path = require('path');
require('dotenv').config();
const AnthropicModule = require('@anthropic-ai/sdk');

const Anthropic = AnthropicModule.default ?? AnthropicModule;

// ── Configuración ────────────────────────────────────────────────────────────

const API_URL = (process.env.LYMBIKA_API_URL || 'https://lymbika-backend.onrender.com').replace(/\/$/, '');
const DIR = path.join(__dirname, 'prellenado');
const ARCH = {
  productos: path.join(DIR, 'productos.jsonl'),
  principios: path.join(DIR, 'principios.jsonl'),
  indicaciones: path.join(DIR, 'indicaciones.json'),
};
const MODEL = 'claude-opus-5-5';
// Precio de lista de Claude Opus 5.5 (USD por millón de tokens) para estimar el gasto.
const PRECIO = { entrada: 4, salida: 20 };

// Los valores válidos salen de los schemas, así la IA nunca propone algo que el import rechace.
const SRC = path.join(__dirname, '..', 'src');
const leerSchema = (rel) => JSON.parse(fs.readFileSync(path.join(SRC, rel), 'utf-8')).attributes;
const PRODUCTO = leerSchema('api/product/content-types/product/schema.json');
const COMPOSICION = leerSchema('components/producto/composicion.json');
const PRINCIPIO = leerSchema('api/principio-activo/content-types/principio-activo/schema.json');

const FRACCIONES_CON_RECETA = new Set(['I', 'II', 'III', 'IV']);

// ── Utilidades ───────────────────────────────────────────────────────────────

/** Igual que en el import: sin mayúsculas, acentos ni espacios. */
const clave = (v) => String(v ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[\s_\-.]+/g, '');

function args() {
  const [, , comando, ...resto] = process.argv;
  const opciones = {};
  for (let i = 0; i < resto.length; i++) {
    if (!resto[i].startsWith('--')) continue;
    const nombre = resto[i].slice(2);
    const valor = resto[i + 1] && !resto[i + 1].startsWith('--') ? resto[++i] : true;
    opciones[nombre] = valor;
  }
  return { comando, opciones };
}

function leerJsonl(archivo) {
  if (!fs.existsSync(archivo)) return [];
  return fs.readFileSync(archivo, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

const agregarJsonl = (archivo, obj) => fs.appendFileSync(archivo, JSON.stringify(obj) + '\n');

async function api(ruta, { metodo = 'GET', cuerpo, token } = {}) {
  const res = await fetch(`${API_URL}/api${ruta}`, {
    method: metodo,
    headers: {
      ...(cuerpo ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${metodo} ${ruta}: ${res.status} ${json?.error?.message ?? ''}`);
  return json;
}

/** Trae todas las páginas de una colección pública. `query` sin pagination. */
async function traerTodo(coleccion, query) {
  const todos = [];
  for (let pagina = 1; ; pagina++) {
    const r = await api(`/${coleccion}?${query}&pagination[pageSize]=200&pagination[page]=${pagina}`);
    todos.push(...r.data);
    if (pagina >= r.meta.pagination.pageCount) return todos;
  }
}

const q = (obj) => Object.entries(obj).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');

async function traerProductos() {
  const campos = ['productName', 'sal', 'conReceta', 'drug_type', 'tipo', 'active', 'stock_central', 'estadoFicha', 'tipoProducto',
    'formaFarmaceutica', 'viaAdministracion', 'contenidoCantidad', 'contenidoUnidad', 'fraccion',
    'edadMinimaMeses', 'requiereRefrigeracion', 'sinAzucar'];
  const query = q({
    ...Object.fromEntries(campos.map((c, i) => [`fields[${i}]`, c])),
    'populate[category][fields][0]': 'categoryName',
    'populate[laboratorio][fields][0]': 'name',
    'populate[composicion][populate][principioActivo][fields][0]': 'nombre',
    'populate[indicaciones][fields][0]': 'nombre',
    sort: 'id:asc',
  });
  return traerTodo('products', query);
}

const traerPrincipios = () => traerTodo('principios-activos', q({ sort: 'id:asc' }));
const traerIndicaciones = () => traerTodo('indicaciones', q({ 'populate[especialidades][fields][0]': 'serviceName', sort: 'id:asc' }));
const traerEspecialidades = () => traerTodo('services', q({ 'fields[0]': 'serviceName' }));

/**
 * Corre `fn` sobre `items` con `n` en paralelo. `fn` recibe además una etiqueta de progreso
 * ("[45/128 · 35% · ~3 min]") para que quien corre el script sepa cuánto falta.
 */
async function enParalelo(items, n, fn) {
  let i = 0;
  let hechos = 0;
  const inicio = Date.now();
  const progreso = () => {
    hechos++;
    const restante = ((Date.now() - inicio) / hechos) * (items.length - hechos) / 60000;
    const pct = Math.round((hechos / items.length) * 100);
    return `[${hechos}/${items.length} · ${pct}%${hechos < items.length ? ` · ~${Math.max(1, Math.round(restante))} min` : ''}]`;
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await fn(items[i++], progreso);
  }));
}

// ── Claude ───────────────────────────────────────────────────────────────────

let cliente;
const gasto = { llamadas: 0, entrada: 0, salida: 0 };

const nulo = (schema) => ({ anyOf: [schema, { type: 'null' }] });
const enumDe = (attr) => ({ type: 'string', enum: attr.enum });
const objeto = (properties) => ({
  type: 'object', additionalProperties: false, required: Object.keys(properties), properties,
});
const CONFIANZA = {
  confianza: { type: 'string', enum: ['alta', 'media', 'baja'] },
  notas: { type: 'string', description: 'Dudas, discrepancias entre nombre y sal, o qué revisar. Vacío si nada.' },
};

/**
 * Una llamada con salida estructurada (JSON validado contra `schema`). Con fallbacks del
 * servidor: si el modelo declina por política, la API reintenta en otro modelo en la misma
 * llamada. Se usa streaming porque la unificación de indicaciones puede dar una salida larga.
 */
async function pedir({ system, usuario, schema, maxTokens = 16000 }) {
  cliente ??= new Anthropic();
  const stream = cliente.beta.messages.stream({
    model: MODEL,
    max_tokens: maxTokens,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'medium', format: { type: 'json_schema', schema } },
    system,
    messages: [{ role: 'user', content: usuario }],
  });
  const r = await stream.finalMessage();
  gasto.llamadas++;
  gasto.entrada += r.usage.input_tokens + (r.usage.cache_creation_input_tokens ?? 0) + (r.usage.cache_read_input_tokens ?? 0);
  gasto.salida += r.usage.output_tokens;

  if (r.stop_reason === 'refusal') throw new Error(`el modelo declinó (${r.stop_details?.category ?? 'sin categoría'})`);
  if (r.stop_reason === 'max_tokens') throw new Error('la respuesta se cortó por max_tokens');
  const texto = r.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return JSON.parse(texto);
}

function resumenGasto() {
  const usd = (gasto.entrada * PRECIO.entrada + gasto.salida * PRECIO.salida) / 1e6;
  return `${gasto.llamadas} llamadas · ${gasto.entrada.toLocaleString()} tokens de entrada · ` +
    `${gasto.salida.toLocaleString()} de salida · ~US$${usd.toFixed(2)}`;
}

// ── Paso 1: productos ────────────────────────────────────────────────────────

const SCHEMA_PRODUCTO = objeto({
  tipoProducto: enumDe(PRODUCTO.tipoProducto),
  composicion: {
    type: 'array',
    items: objeto({
      principioActivo: { type: 'string' },
      cantidad: nulo({ type: 'number' }),
      unidad: nulo(enumDe(COMPOSICION.unidad)),
      porCantidad: nulo({ type: 'number' }),
      porUnidad: nulo(enumDe(COMPOSICION.porUnidad)),
    }),
  },
  formaFarmaceutica: nulo(enumDe(PRODUCTO.formaFarmaceutica)),
  viaAdministracion: nulo(enumDe(PRODUCTO.viaAdministracion)),
  contenidoCantidad: nulo({ type: 'number' }),
  contenidoUnidad: nulo(enumDe(PRODUCTO.contenidoUnidad)),
  fraccion: nulo(enumDe(PRODUCTO.fraccion)),
  edadMinimaMeses: nulo({ type: 'integer' }),
  indicaciones: { type: 'array', items: { type: 'string' } },
  requiereRefrigeracion: { type: 'boolean' },
  sinAzucar: nulo({ type: 'boolean' }),
  ...CONFIANZA,
});

function systemProductos(indicacionesExistentes) {
  return `Eres farmacéutico en México y llenas la ficha estructurada de productos de una farmacia en línea (Lymbika). Te paso los datos actuales de UN producto; están capturados a mano y a menudo son inconsistentes: el campo "sal" puede traer ingredientes de cosméticos, descripciones de dispositivos o dosis equivocadas.

Devuelve la ficha del producto con estos criterios:
- tipoProducto: medicamento (registro sanitario de medicamento), suplemento (vitaminas, proteína, electrolitos, probióticos), dermocosmetico (cremas, protectores solares, cuidado de piel/cabello), dispositivoMedico (jeringas, agujas, condones, pruebas, material de curación, aparatos), higienePersonal (pasta dental, toallitas, talco), otro.
- composicion: solo principios activos de medicamentos y suplementos (uno por renglón). Nombre genérico (DCI) en español con mayúscula inicial y la sal cuando forma parte del nombre habitual ("Naproxeno sódico", "Paracetamol", nunca "acetaminofén"). Cantidad por unidad de dosis (tableta, cápsula) o concentración con "por" en líquidos y cremas ("250 mg por 5 ml", "1 porcentaje"). Vacía para cosméticos, dispositivos e higiene, y si no puedes identificar los activos.
- Si el nombre comercial y "sal" no coinciden, usa lo que corresponde a la presentación comercializada en México y explícalo en notas.
- contenidoCantidad/contenidoUnidad: lo que trae el empaque ("caja c/20 tabletas" = 20 tabletas; "frasco c/120ml" = 120 ml).
- fraccion: fracción de venta COFEPRIS (Ley General de Salud, art. 226) solo para medicamentos; null en lo demás. I–III psicotrópicos/estupefacientes, IV requiere receta (antibióticos incluidos), V sin receta solo en farmacias, VI sin receta en cualquier establecimiento. Si dudas entre dos, elige la más restrictiva y pon confianza baja.
- edadMinimaMeses: edad mínima de uso de ESTA presentación según el prospecto (12 años = 144). null si no aplica o no lo sabes.
- indicaciones: 1 a 3 padecimientos o usos principales, en español, nombre corto con mayúscula inicial ("Rinitis alérgica", "Dolor e inflamación", "Anticoncepción", "Hidratación de la piel"). Si alguno equivale a una indicación existente, usa EXACTAMENTE ese nombre.
- requiereRefrigeracion: true solo si requiere cadena de frío (insulinas, algunas vacunas).
- sinAzucar: true/false solo si es relevante (jarabes, suplementos) y lo sabes; null en lo demás.
- No inventes: si no sabes un dato, null y explícalo en notas. confianza: alta si conoces el producto, media si lo deduces del nombre, baja si hay dudas importantes.

Indicaciones existentes: ${indicacionesExistentes.length ? indicacionesExistentes.join('; ') : '(ninguna todavía)'}`;
}

// No se le pasa `conReceta`: hoy está mal en muchos medicamentos con receta, y en las pruebas
// la IA lo tomaba como evidencia para proponer venta libre. La fracción la juzga por sí misma.
function entradaProducto(p) {
  return JSON.stringify({
    nombre: p.productName?.trim(),
    sal: p.sal,
    categoria: p.category?.categoryName ?? null,
    clasificacionAnterior: p.tipo?.trim() ?? null,
    laboratorio: p.laboratorio?.name ?? null,
    genericoOMarca: p.drug_type ?? null,
  }, null, 2);
}

async function pasoProductos(op) {
  fs.mkdirSync(DIR, { recursive: true });
  const hechos = new Set(leerJsonl(ARCH.productos).map((x) => x.documentId));
  const [productos, indicaciones] = await Promise.all([traerProductos(), traerIndicaciones()]);

  let pendientes = productos.filter((p) => p.estadoFicha !== 'revisada' && !hechos.has(p.documentId));
  if (op.ids) {
    const ids = new Set(String(op.ids).split(','));
    pendientes = pendientes.filter((p) => ids.has(p.documentId));
  }
  if (op.buscar) {
    const b = clave(op.buscar);
    pendientes = pendientes.filter((p) => clave(p.productName).includes(b) || clave(p.sal).includes(b));
  }
  // Para no gastar en lo que nadie va a comprar ni el bot va a recomendar.
  if (op['con-stock']) pendientes = pendientes.filter((p) => p.active !== false && Number(p.stock_central) > 0);
  if (op.tipo) {
    const tipos = new Set(String(op.tipo).split(',').map(clave));
    pendientes = pendientes.filter((p) => tipos.has(clave(p.tipo)));
  }
  if (op.limite) pendientes = pendientes.slice(0, Number(op.limite));

  console.log(`Catálogo: ${productos.length} · ya propuestos: ${hechos.size} · a proponer ahora: ${pendientes.length}`);
  if (op.estimar) {
    // Medido en la prueba de noviembre de 2026: ~US$0.03 por producto y ~US$0.03 por principio
    // activo nuevo (aprox. uno nuevo por cada 1.5 productos al principio; baja conforme crece
    // el catálogo de principios).
    const porTipo = {};
    for (const p of pendientes) porTipo[p.tipo?.trim() || '(sin clasificación)'] = (porTipo[p.tipo?.trim() || '(sin clasificación)'] ?? 0) + 1;
    for (const [t, n] of Object.entries(porTipo).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${t}`);
    const productosUsd = pendientes.length * 0.03;
    const principiosUsd = (pendientes.length / 1.5) * 0.03;
    console.log(`Estimado: ~US$${productosUsd.toFixed(0)} (productos) + ~US$${principiosUsd.toFixed(0)} como máximo (principios activos, paso "catalogos"). No se llamó a la IA.`);
    return;
  }
  const system = systemProductos(indicaciones.map((i) => i.nombre));
  let fallidos = 0;

  await enParalelo(pendientes, Number(op.concurrencia ?? 4), async (p, progreso) => {
    try {
      const propuesta = await pedir({ system, usuario: entradaProducto(p), schema: SCHEMA_PRODUCTO });
      agregarJsonl(ARCH.productos, { documentId: p.documentId, productName: p.productName?.trim(), propuesta });
      console.log(`  ${progreso()} ✓ ${p.productName?.trim()} (confianza ${propuesta.confianza})`);
    } catch (e) {
      fallidos++;
      console.log(`  ${progreso()} ✗ ${p.productName?.trim()}: ${e.message}`);
    }
  });
  console.log(`Listo. ${fallidos ? `${fallidos} fallaron (vuelve a correr el paso para reintentarlos). ` : ''}${resumenGasto()}`);
}

// ── Paso 2: principios activos e indicaciones ────────────────────────────────

const SCHEMA_PRINCIPIO = objeto({
  nombre: { type: 'string' },
  sinonimos: { type: 'string' },
  codigoAtc: nulo({ type: 'string' }),
  embarazo: enumDe(PRINCIPIO.embarazo),
  lactancia: enumDe(PRINCIPIO.lactancia),
  causaSomnolencia: { type: 'boolean' },
  esAntibiotico: { type: 'boolean' },
  contraindicaciones: { type: 'string' },
  advertencias: { type: 'string' },
  interacciones: { type: 'string' },
  efectosAdversos: { type: 'string' },
  ...CONFIANZA,
});

const SYSTEM_PRINCIPIO = `Eres farmacéutico en México. Llenas la ficha de UN principio activo para una farmacia en línea; la leerán clientes y un asistente que recomienda productos de venta libre, y la revisará un farmacéutico antes de publicarse.

- nombre: el nombre genérico (DCI) en español con mayúscula inicial. Si el que te paso tiene una errata o es un sinónimo, corrígelo y explícalo en notas. NO quites la sal si viene en el nombre ("Naproxeno sódico", "Levocetirizina diclorhidrato"): la dosis de los productos se expresa en esa sal y quitarla cambiaría su significado.
- sinonimos: otros nombres con que se le conoce, separados por coma ("acetaminofén"). Vacío si no hay.
- codigoAtc: código ATC de la OMS; null si no tiene o no lo sabes con certeza.
- embarazo / lactancia: compatible, precaucion, contraindicado o sinDatos, según la evidencia y los prospectos habituales en México. Ante la duda, la opción más prudente.
- causaSomnolencia: true si produce somnolencia de forma relevante a dosis habituales.
- esAntibiotico: true para antibacterianos sistémicos o tópicos (en México requieren retener la receta).
- contraindicaciones, advertencias, interacciones, efectosAdversos: lo esencial en 1 o 2 oraciones claras para un cliente, sin dosis. Para vitaminas, minerales o sustancias sin datos relevantes, dilo en una frase corta.
- confianza: alta si es un fármaco bien documentado; baja si hay dudas. No inventes.`;

const SYSTEM_INDICACIONES = `Eres farmacéutico en México. Te paso las indicaciones (padecimientos o usos) que se propusieron para los productos de una farmacia en línea, con cuántos productos usan cada una, más las que ya existen y las especialidades médicas de la clínica.

1. Unifica las que son lo mismo (variantes, sinónimos, plurales) en un solo nombre corto en español con mayúscula inicial. Si una equivale a una indicación existente, usa EXACTAMENTE el nombre existente y marca existente = true. Pon en "alias" todos los nombres propuestos que se unifican en ella (exactamente como te los pasé).
2. Para cada indicación nueva llena:
   - sinonimos: cómo lo dice un cliente, separado por comas ("estornudos, mocos, comezón de nariz"). Es lo que usará la búsqueda por síntoma.
   - descripcion: una oración.
   - senalesAlarma: cuándo NO automedicarse y acudir al médico o a urgencias (1 o 2 oraciones). Vacío si no aplica (p. ej. "Hidratación de la piel").
   - especialidades: de la lista que te paso, a cuáles derivar si hace falta consulta; vacía si ninguna aplica.
   Para las existentes deja esos campos vacíos: no se tocan.
Cada nombre propuesto debe aparecer en el alias de exactamente una indicación.`;

async function pasoCatalogos(op) {
  const propuestas = leerJsonl(ARCH.productos);
  if (!propuestas.length) return console.log('Primero corre el paso "productos".');
  const [principios, indicaciones, especialidades] = await Promise.all([traerPrincipios(), traerIndicaciones(), traerEspecialidades()]);

  // Principios activos: los que no existen todavía (o existen con campos vacíos y sin revisar).
  const existentes = new Map(principios.map((p) => [clave(p.nombre), p]));
  const hechos = new Set(leerJsonl(ARCH.principios).map((x) => clave(x.solicitado)));
  const usos = new Map();
  for (const { productName, propuesta } of propuestas) {
    for (const c of propuesta.composicion) {
      const k = clave(c.principioActivo);
      if (!usos.has(k)) usos.set(k, { nombre: c.principioActivo, productos: [] });
      usos.get(k).productos.push(productName);
    }
  }
  const camposClinicos = ['sinonimos', 'codigoAtc', 'embarazo', 'lactancia', 'causaSomnolencia', 'esAntibiotico',
    'contraindicaciones', 'advertencias', 'interacciones', 'efectosAdversos'];
  const porPedir = [...usos.entries()]
    .filter(([k]) => !hechos.has(k))
    .filter(([k]) => {
      const e = existentes.get(k);
      return !e || (e.estadoFicha !== 'revisada' && camposClinicos.some((c) => e[c] === null || e[c] === ''));
    })
    .map(([, v]) => v);

  console.log(`Principios activos: ${usos.size} en las propuestas · ${porPedir.length} por llenar`);
  await enParalelo(porPedir, Number(op.concurrencia ?? 4), async (u, progreso) => {
    try {
      const ficha = await pedir({
        system: SYSTEM_PRINCIPIO,
        usuario: `Principio activo: ${u.nombre}\nProductos que lo contienen: ${u.productos.slice(0, 5).join('; ')}`,
        schema: SCHEMA_PRINCIPIO,
      });
      agregarJsonl(ARCH.principios, { solicitado: u.nombre, ficha });
      console.log(`  ${progreso()} ✓ ${ficha.nombre} (confianza ${ficha.confianza})`);
    } catch (e) {
      console.log(`  ${progreso()} ✗ ${u.nombre}: ${e.message}`);
    }
  });

  // Indicaciones: una sola pasada que unifica nombres y llena las nuevas.
  const conteo = new Map();
  for (const { propuesta } of propuestas) {
    for (const i of propuesta.indicaciones) conteo.set(i, (conteo.get(i) ?? 0) + 1);
  }
  const nombresServicios = [...new Set(especialidades.map((s) => s.serviceName.trim()))];
  const SCHEMA_INDICACIONES = objeto({
    indicaciones: {
      type: 'array',
      items: objeto({
        nombre: { type: 'string' },
        existente: { type: 'boolean' },
        alias: { type: 'array', items: { type: 'string' } },
        sinonimos: { type: 'string' },
        descripcion: { type: 'string' },
        senalesAlarma: { type: 'string' },
        especialidades: { type: 'array', items: { type: 'string', enum: nombresServicios } },
      }),
    },
  });
  console.log(`Indicaciones: ${conteo.size} nombres propuestos · unificando…`);
  const r = await pedir({
    system: SYSTEM_INDICACIONES,
    usuario: JSON.stringify({
      propuestas: [...conteo].map(([nombre, productos]) => ({ nombre, productos })),
      existentes: indicaciones.map((i) => i.nombre),
      especialidades: nombresServicios,
    }, null, 2),
    schema: SCHEMA_INDICACIONES,
    maxTokens: 64000,
  });
  fs.writeFileSync(ARCH.indicaciones, JSON.stringify(r.indicaciones, null, 2));
  const nuevas = r.indicaciones.filter((i) => !i.existente).length;
  console.log(`  ✓ ${r.indicaciones.length} indicaciones (${nuevas} nuevas)`);
  console.log(`Listo. ${resumenGasto()}`);
}

// ── Paso 3: CSV para revisar ─────────────────────────────────────────────────

const escapar = (v) => {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",;\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function escribirCsv(archivo, columnas, filas) {
  const lineas = [columnas.join(','), ...filas.map((f) => columnas.map((c) => escapar(f[c])).join(','))];
  // BOM para que Excel lea los acentos.
  fs.writeFileSync(archivo, '﻿' + lineas.join('\r\n'));
}

const vacio = (v) => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);

function renglon(c, nombre) {
  const n = (x) => (x === null || x === undefined ? '' : String(Number(x)));
  const cant = c.cantidad === null ? '' : c.unidad === 'porcentaje' ? `${n(c.cantidad)}%` : `${n(c.cantidad)} ${c.unidad ?? ''}`.trim();
  const por = c.porUnidad ? ` / ${[n(c.porCantidad), c.porUnidad].filter(Boolean).join(' ')}` : '';
  return [nombre, cant].filter(Boolean).join(' ') + (cant ? por : '');
}

// Confianza mínima para aplicar la fracción propuesta (decidido con Adrian, nov-2026): con
// `baja` no se pone fracción, así el producto conserva su conReceta actual hasta que alguien lo
// revise. Aplicar una fracción I–IV deja el producto sin poder comprarse en línea.
const NIVEL_CONFIANZA = { baja: 0, media: 1, alta: 2 };

async function pasoCsv(op = {}) {
  const fraccionMin = NIVEL_CONFIANZA[op['fraccion-min'] ?? 'media'];
  if (fraccionMin === undefined) throw new Error('--fraccion-min debe ser alta, media o baja');
  const propuestas = leerJsonl(ARCH.productos);
  if (!propuestas.length) return console.log('Primero corre el paso "productos".');
  const fichasPrincipio = leerJsonl(ARCH.principios);
  const unificadas = fs.existsSync(ARCH.indicaciones) ? JSON.parse(fs.readFileSync(ARCH.indicaciones, 'utf-8')) : [];

  // Estado actual: se vuelve a leer justo ahora para no pisar lo capturado desde la propuesta.
  const [productos, principios, indicaciones] = await Promise.all([traerProductos(), traerPrincipios(), traerIndicaciones()]);
  const actual = new Map(productos.map((p) => [p.documentId, p]));

  const nombrePrincipio = new Map(); // clave(solicitado) → nombre corregido por la IA
  for (const { solicitado, ficha } of fichasPrincipio) nombrePrincipio.set(clave(solicitado), ficha.nombre);
  const nombreIndicacion = new Map(); // clave(alias) → nombre unificado
  for (const i of unificadas) for (const a of [i.nombre, ...i.alias]) nombreIndicacion.set(clave(a), i.nombre);

  // productos.csv
  const camposSimples = ['tipoProducto', 'formaFarmaceutica', 'viaAdministracion', 'contenidoCantidad', 'contenidoUnidad',
    'fraccion', 'edadMinimaMeses', 'requiereRefrigeracion', 'sinAzucar'];
  const filasProductos = [];
  const avisos = [];
  for (const { documentId, propuesta } of propuestas) {
    const p = actual.get(documentId);
    if (!p || p.estadoFicha === 'revisada') continue;
    const fila = { documentId, productName: p.productName?.trim(), ia_confianza: propuesta.confianza, ia_notas: propuesta.notas };
    for (const c of camposSimples) if (vacio(p[c]) && !vacio(propuesta[c])) fila[c] = propuesta[c];

    if (fila.fraccion && NIVEL_CONFIANZA[propuesta.confianza] < fraccionMin) {
      delete fila.fraccion;
      fila.ia_notas = `[Fracción ${propuesta.fraccion} NO aplicada por confianza ${propuesta.confianza}; decídela al revisar.] ${fila.ia_notas}`;
    }
    if (fila.fraccion && p.conReceta && !FRACCIONES_CON_RECETA.has(fila.fraccion)) {
      delete fila.fraccion;
      fila.ia_notas = `[Fracción ${propuesta.fraccion} NO aplicada: hoy está marcado con receta; decídelo a mano.] ${fila.ia_notas}`;
      avisos.push(`${fila.productName}: la IA propone venta libre (${propuesta.fraccion}) pero hoy está con receta`);
    }
    if (vacio(p.composicion) && propuesta.composicion.length) {
      // `cantidad` es decimal(10,2) en la BD: los probióticos (2,000 millones de UFC) no caben y
      // la fila entera fallaba al importar. Se omite la cantidad y se deja anotado.
      const MAX_DECIMAL = 99999999;
      const renglones = propuesta.composicion.map((c) => {
        if (Number(c.cantidad) > MAX_DECIMAL || Number(c.porCantidad) > MAX_DECIMAL) {
          fila.ia_notas = `[Cantidad de ${c.principioActivo} (${c.cantidad} ${c.unidad}) no capturada: excede el campo.] ${fila.ia_notas}`;
          c = { ...c, cantidad: null, unidad: null, porCantidad: null, porUnidad: null };
        }
        return renglon(c, nombrePrincipio.get(clave(c.principioActivo)) ?? c.principioActivo);
      });
      fila.composicion = renglones.join('; ');
    }
    if (vacio(p.indicaciones) && propuesta.indicaciones.length) {
      fila.indicaciones = [...new Set(propuesta.indicaciones.map((i) => nombreIndicacion.get(clave(i)) ?? i))].join('; ');
    }
    const cambia = Object.keys(fila).some((k) => !['documentId', 'productName', 'ia_confianza', 'ia_notas'].includes(k));
    if (!cambia) continue;
    if (vacio(p.estadoFicha)) fila.estadoFicha = 'pendiente';
    fila.fuenteInfo = 'ia';
    fila.status = 'published';
    filasProductos.push(fila);
  }
  escribirCsv(path.join(DIR, 'productos.csv'),
    ['documentId', 'productName', ...camposSimples.slice(0, 5), 'composicion', 'fraccion', 'edadMinimaMeses', 'indicaciones',
      'requiereRefrigeracion', 'sinAzucar', 'fuenteInfo', 'estadoFicha', 'status', 'ia_confianza', 'ia_notas'],
    filasProductos);

  // principios-activos.csv: nuevos completos; existentes sin revisar, solo sus campos vacíos.
  const principiosPorClave = new Map(principios.map((p) => [clave(p.nombre), p]));
  const camposPrincipio = ['sinonimos', 'codigoAtc', 'embarazo', 'lactancia', 'causaSomnolencia', 'esAntibiotico',
    'contraindicaciones', 'advertencias', 'interacciones', 'efectosAdversos'];
  const filasPrincipios = [];
  const vistos = new Set();
  for (const { ficha } of fichasPrincipio) {
    const k = clave(ficha.nombre);
    if (vistos.has(k)) continue;
    vistos.add(k);
    const e = principiosPorClave.get(k);
    if (e?.estadoFicha === 'revisada') continue;
    const fila = { documentId: e?.documentId ?? '', nombre: e?.nombre ?? ficha.nombre, ia_confianza: ficha.confianza, ia_notas: ficha.notas };
    for (const c of camposPrincipio) if (!e || vacio(e[c])) fila[c] = ficha[c];
    if (!e || vacio(e.fuenteInfo)) fila.fuenteInfo = 'ia';
    filasPrincipios.push(fila);
  }
  escribirCsv(path.join(DIR, 'principios-activos.csv'),
    ['documentId', 'nombre', ...camposPrincipio, 'fuenteInfo', 'ia_confianza', 'ia_notas'], filasPrincipios);

  // indicaciones.csv: solo las nuevas (las existentes no se tocan).
  const indicacionesPorClave = new Map(indicaciones.map((i) => [clave(i.nombre), i]));
  const filasIndicaciones = unificadas
    .filter((i) => !indicacionesPorClave.has(clave(i.nombre)))
    .map((i) => ({ ...i, especialidades: i.especialidades.join('; '), alias: i.alias.join('; '), fuenteInfo: 'ia' }));
  escribirCsv(path.join(DIR, 'indicaciones.csv'),
    ['nombre', 'sinonimos', 'descripcion', 'senalesAlarma', 'especialidades', 'fuenteInfo', 'alias'], filasIndicaciones);

  console.log(`CSV en ${DIR}:`);
  console.log(`  productos.csv           ${filasProductos.length} productos`);
  console.log(`  principios-activos.csv  ${filasPrincipios.length} principios activos`);
  console.log(`  indicaciones.csv        ${filasIndicaciones.length} indicaciones nuevas`);
  for (const a of avisos) console.log(`  ⚠ ${a}`);
  console.log('Revísalos en Excel, corre "aplicar-catalogos" y luego importa productos.csv desde el POS.');
}

// ── Paso 4: crear principios activos e indicaciones revisados ────────────────

/** Mismo criterio que el import del backend: comillas, saltos de línea dentro de celdas, "," o ";". */
function leerCsv(archivo) {
  const src = fs.readFileSync(archivo, 'utf-8').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const encabezado = src.slice(0, src.indexOf('\n'));
  const sep = (encabezado.match(/;/g)?.length ?? 0) > (encabezado.match(/,/g)?.length ?? 0) ? ';' : ',';
  const filas = [];
  let fila = [];
  let celda = '';
  let comillas = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (comillas) {
      if (c === '"' && src[i + 1] === '"') { celda += '"'; i++; } else if (c === '"') comillas = false; else celda += c;
    } else if (c === '"') comillas = true;
    else if (c === sep) { fila.push(celda); celda = ''; }
    else if (c === '\n') { fila.push(celda); filas.push(fila); fila = []; celda = ''; }
    else celda += c;
  }
  if (celda !== '' || fila.length) { fila.push(celda); filas.push(fila); }
  const utiles = filas.filter((f) => f.some((v) => v.trim()));
  const h = utiles[0].map((x) => x.trim());
  return utiles.slice(1).map((v) => Object.fromEntries(h.map((k, i) => [k, (v[i] ?? '').trim()])));
}

function valor(attr, texto) {
  if (texto === '') return undefined;
  if (attr.type === 'boolean') {
    const v = clave(texto);
    if (['true', 'verdadero', 'si', '1'].includes(v)) return true;
    if (['false', 'falso', 'no', '0'].includes(v)) return false;
    throw new Error(`"${texto}" no es verdadero/falso`);
  }
  if (attr.type === 'enumeration') {
    const e = attr.enum.find((o) => clave(o) === clave(texto));
    if (!e) throw new Error(`"${texto}" no es válido (${attr.enum.join(', ')})`);
    return e;
  }
  return texto;
}

async function pasoAplicar(op) {
  const confirmar = Boolean(op.confirmar);
  const token = process.env.LYMBIKA_API_TOKEN;
  if (confirmar && !token) throw new Error('Falta LYMBIKA_API_TOKEN en .env');
  const archivoP = path.join(DIR, 'principios-activos.csv');
  const archivoI = path.join(DIR, 'indicaciones.csv');
  const [principios, indicaciones, especialidades] = await Promise.all([traerPrincipios(), traerIndicaciones(), traerEspecialidades()]);
  console.log(confirmar ? `Aplicando en ${API_URL}` : `Simulación contra ${API_URL} (agrega --confirmar para escribir)`);

  const plan = [];
  const preparar = (coleccion, existentes, attrs, filas, extra) => {
    const porClave = new Map(existentes.map((x) => [clave(x.nombre), x]));
    for (const fila of filas) {
      try {
        const e = (fila.documentId && existentes.find((x) => x.documentId === fila.documentId)) || porClave.get(clave(fila.nombre));
        if (e?.estadoFicha === 'revisada') { plan.push({ texto: `= ${fila.nombre}: revisada, no se toca` }); continue; }
        const data = {};
        for (const [campo, texto] of Object.entries(fila)) {
          if (!attrs[campo] || ['nombre', 'slug'].includes(campo) || attrs[campo].type === 'relation') continue;
          const v = valor(attrs[campo], texto);
          // Regla: solo campos vacíos de lo que ya existe.
          if (v !== undefined && (!e || vacio(e[campo]))) data[campo] = v;
        }
        Object.assign(data, extra?.(fila, e) ?? {});
        if (!e) data.nombre = fila.nombre;
        if (!e) data.estadoFicha = 'pendiente';
        if (!Object.keys(data).length) { plan.push({ texto: `= ${fila.nombre}: nada que llenar` }); continue; }
        plan.push({
          texto: `${e ? '~ actualizar' : '+ crear'} ${coleccion} "${fila.nombre}" (${Object.keys(data).join(', ')})`,
          ejecutar: () => e
            ? api(`/${coleccion}/${e.documentId}`, { metodo: 'PUT', cuerpo: { data }, token })
            : api(`/${coleccion}`, { metodo: 'POST', cuerpo: { data }, token }),
        });
      } catch (err) {
        plan.push({ texto: `✗ ${fila.nombre}: ${err.message}` });
      }
    }
  };

  if (fs.existsSync(archivoP)) preparar('principios-activos', principios, PRINCIPIO, leerCsv(archivoP));
  if (fs.existsSync(archivoI)) {
    const attrsI = leerSchema('api/indicacion/content-types/indicacion/schema.json');
    const servicio = new Map(especialidades.map((s) => [clave(s.serviceName), s.documentId]));
    preparar('indicaciones', indicaciones, attrsI, leerCsv(archivoI), (fila, e) => {
      if (e && !vacio(e.especialidades)) return {};
      const ids = fila.especialidades.split(/[;\n]/).map((s) => s.trim()).filter(Boolean).map((s) => {
        const id = servicio.get(clave(s));
        if (!id) throw new Error(`especialidad "${s}" no existe`);
        return id;
      });
      return ids.length ? { especialidades: { connect: ids } } : {};
    });
  }

  for (const paso of plan) {
    console.log(`  ${paso.texto}`);
    if (confirmar && paso.ejecutar) {
      try { await paso.ejecutar(); } catch (err) { console.log(`    ✗ ${err.message}`); }
    }
  }
  if (!confirmar) console.log('Nada se escribió.');
}

// ── Paso 5: importar productos.csv ───────────────────────────────────────────

/**
 * Lo mismo que el botón "Importar CSV" del POS, con el token del .env (necesita además el
 * permiso export.importProducts). Sin --confirmar solo simula (dryRun del backend).
 */
async function pasoImportar(op) {
  const confirmar = Boolean(op.confirmar);
  const token = process.env.LYMBIKA_API_TOKEN;
  if (!token) throw new Error('Falta LYMBIKA_API_TOKEN en .env');
  // --archivo para reimportar un CSV corregido a mano (por ejemplo, solo las filas que fallaron).
  const archivo = op.archivo ? path.resolve(String(op.archivo)) : path.join(DIR, 'productos.csv');
  if (!fs.existsSync(archivo)) throw new Error(op.archivo ? `No existe ${archivo}` : 'Primero corre el paso "csv".');

  // En bloques: con todo el archivo en una sola llamada, Render tarda varios segundos por
  // producto y el fetch de Node se rinde a los 5 minutos (en la parte 1 cortó en 43 de 136,
  // aunque el servidor siguió). Bloques chicos terminan rápido y dan progreso. Repetir un
  // bloque es seguro: vuelve a escribir los mismos valores.
  const filas = leerCsv(archivo);
  const columnas = Object.keys(filas[0] ?? {});
  const TAM = Number(op.bloque ?? 20);
  const total = { updated: 0, created: 0, published: 0, errors: [], warnings: new Set() };
  console.log(confirmar ? `Importando ${filas.length} filas en ${API_URL}…` : `Simulación contra ${API_URL} (agrega --confirmar para escribir)`);

  for (let i = 0; i < filas.length; i += TAM) {
    const bloque = filas.slice(i, i + TAM);
    const csv = [columnas.join(','), ...bloque.map((f) => columnas.map((c) => escapar(f[c])).join(','))].join('\r\n');
    const form = new FormData();
    form.append('file', new Blob([csv], { type: 'text/csv;charset=utf-8' }), 'productos.csv');
    const res = await fetch(`${API_URL}/api/export/products/import${confirmar ? '' : '?dryRun=true'}`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form,
    });
    const r = await res.json().catch(() => null);
    if (res.status === 403) throw new Error('El token no tiene el permiso export.importProducts');
    if (!res.ok) throw new Error(`Import (filas ${i + 1}–${i + bloque.length}): ${res.status} ${r?.error?.message ?? ''}`);
    total.updated += r.updated; total.created += r.created; total.published += r.published;
    // El backend numera las filas dentro del bloque; se traduce a la fila del archivo completo.
    total.errors.push(...r.errors.map((e) => e.replace(/^Fila (\d+)/, (_, n) => `Fila ${Number(n) + i}`)));
    r.warnings.forEach((w) => total.warnings.add(w));
    const hechas = Math.min(i + TAM, filas.length);
    if (confirmar) console.log(`  [${hechas}/${filas.length} · ${Math.round((hechas / filas.length) * 100)}%]`);
  }
  console.log(`  ${confirmar ? 'Actualizados' : 'Se actualizarán'}: ${total.updated} · nuevos: ${total.created} · publicados: ${total.published} · filas con error: ${total.errors.length}`);
  for (const w of total.warnings) console.log(`  ⚠ ${w}`);
  for (const e of total.errors) console.log(`  ✗ ${e}`);
}

// ── Main ─────────────────────────────────────────────────────────────────────

(async () => {
  const { comando, opciones } = args();
  const pasos = {
    productos: pasoProductos, catalogos: pasoCatalogos, csv: pasoCsv,
    'aplicar-catalogos': pasoAplicar, 'importar-productos': pasoImportar,
  };
  if (!pasos[comando]) {
    console.log('Uso: node scripts/prellenar-fichas.js <productos|catalogos|csv|aplicar-catalogos|importar-productos> [opciones]');
    process.exit(1);
  }
  try {
    await pasos[comando](opciones);
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) console.error('ANTHROPIC_API_KEY inválida o ausente en .env');
    else if (e instanceof Anthropic.RateLimitError) console.error('Límite de uso de la API alcanzado; espera y vuelve a correr el paso.');
    else if (e instanceof Anthropic.APIError) console.error(`Error de la API de Anthropic ${e.status}: ${e.message}`);
    else console.error(e.message);
    process.exit(1);
  }
})();
