/**
 * Plan de migración consolidado: fusiona lo que generó build-variants.js con lo
 * que rescató rescue-unconvertible.js, dando prioridad al rescate.
 *
 * Importa porque los HEIC salen en los dos: build-variants copió el .heic tal
 * cual (sharp no lo lee) y el rescate bajó de Cloudinary un .webp navegable.
 * Gana el rescate, y el .heic no se sube: queda sólo en el respaldo local.
 *
 * Cada fila de `files` aporta un item PRINCIPAL (el archivo que va en la
 * columna url) y, si la tiene, un THUMBNAIL, que vive dentro de formats. Los
 * dos comparten rowId, así que la fusión se hace sólo entre principales: si se
 * indexara todo por rowId, el thumbnail desplazaría a la imagen y se perderían
 * sus variantes.
 *
 * Lo usan por igual el script de subida y el de reescritura de la base, para
 * que ninguno pueda apuntar a algo que el otro no subió.
 */

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', '.migracion-media');
const ES_PRINCIPAL = (kind) => kind !== 'thumbnail';

function cargar() {
  const base = require(path.join(DIR, '_plan.json'));
  const rescate = require(path.join(DIR, '_plan-rescate.json'));

  const principales = new Map();
  const thumbnails = [];

  for (const item of base.items) {
    if (ES_PRINCIPAL(item.kind)) principales.set(item.rowId, { ...item, origen: 'variantes' });
    else thumbnails.push({ ...item, origen: 'variantes' });
  }

  const sustituidos = new Map();
  for (const item of rescate.items) {
    const anterior = principales.get(item.rowId);
    if (anterior) sustituidos.set(item.rowId, anterior);
    principales.set(item.rowId, { ...item, origen: 'rescate' });
  }

  // Los posters de video son objetos aparte: S3 no extrae frames, así que el
  // <clave>_poster.webp tiene que existir subido igual que las variantes.
  let posters = [];
  const rutaPosters = path.join(DIR, '_plan-posters.json');
  if (fs.existsSync(rutaPosters)) {
    posters = JSON.parse(fs.readFileSync(rutaPosters, 'utf-8')).items || [];
  }
  const posterPorFila = new Map(posters.map((p) => [p.rowId, p]));

  const items = [...principales.values(), ...thumbnails];

  const claves = new Set();
  for (const it of items) {
    claves.add(it.originalKey);
    for (const v of it.variants) claves.add(v.key);
  }
  for (const p of posters) claves.add(p.posterKey);

  // Lo que quedó fuera al fusionar: los .heic y sus copias, ya sustituidos.
  const descartadas = new Set();
  for (const viejo of sustituidos.values()) {
    if (!claves.has(viejo.originalKey)) descartadas.add(viejo.originalKey);
    for (const v of viejo.variants) if (!claves.has(v.key)) descartadas.add(v.key);
  }

  return { dir: DIR, widths: base.widths, principales, thumbnails, posters, posterPorFila, items, claves, descartadas };
}

module.exports = { cargar, DIR };
