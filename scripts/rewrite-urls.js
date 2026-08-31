#!/usr/bin/env node
/**
 * Reescribe la tabla `files` para que apunte a CloudFront en vez de Cloudinary.
 *
 * Por cada fila: url, provider, provider_metadata, y en los archivos que el
 * rescate convirtió (HEIC y el .MOV) también ext, mime, size y dimensiones.
 * En `formats` sólo se reescribe la url del thumbnail, que es lo único que se
 * consume: las variantes _w<ancho>.webp no se registran ahí porque el loader
 * del frontend las construye por convención, y añadirlas engordaría cada
 * respuesta de la API.
 *
 * provider_metadata queda en null: el provider de S3 deriva la clave del
 * objeto de hash+ext, no de ahí. Por eso es imprescindible que ext coincida
 * con la extensión real subida, o los borrados desde el admin no encontrarían
 * el archivo.
 *
 * Uso:
 *   node scripts/rewrite-urls.js                 # dry-run
 *   node scripts/rewrite-urls.js --limit 5 --apply
 *   node scripts/rewrite-urls.js --apply
 *   node scripts/rewrite-urls.js --rollback scripts/rewrite-urls.rollback.json --apply
 */

const fs = require('fs');
const path = require('path');

require('dotenv').config();
const { Client } = require('pg');
const sharp = require('sharp');
const { cargar } = require('./media-plan.js');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const LIMIT = (() => {
  const i = args.indexOf('--limit');
  return i >= 0 ? parseInt(args[i + 1], 10) : null;
})();
const ROLLBACK_FILE = (() => {
  const i = args.indexOf('--rollback');
  return i >= 0 ? args[i + 1] : null;
})();

const CDN = (process.env.AWS_CDN_URL || '').replace(/\/+$/, '');
const ROLLBACK_PATH = path.join(__dirname, 'rewrite-urls.rollback.json');
const parse = (v) => { try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return null; } };
const kb = (bytes) => Math.round((bytes / 1024) * 100) / 100;

function db() {
  return new Client({
    host: process.env.DATABASE_HOST,
    port: Number(process.env.DATABASE_PORT) || 5432,
    database: process.env.DATABASE_NAME,
    user: process.env.DATABASE_USERNAME,
    password: process.env.DATABASE_PASSWORD,
    ssl: { rejectUnauthorized: false },
  });
}

const COLUMNAS = ['url', 'provider', 'provider_metadata', 'ext', 'mime', 'size', 'width', 'height', 'formats'];

// Cloudinary normalizó extensiones al entregar (.jpeg -> .jpg) y en algunos
// casos cambió el formato, así que ext y mime de la fila no siempre describen
// el archivo real. Se derivan de la clave del objeto, que es la verdad: el
// provider de S3 borra por hash+ext, y si no coincide deja huérfanos.
const MIME_POR_EXT = {
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.pdf': 'application/pdf',
  '.html': 'text/html',
};
const REDIMENSIONABLE = /^image\/(png|jpe?g|webp|avif|tiff)$/;

async function runRewrite() {
  if (!CDN) throw new Error('Falta AWS_CDN_URL en .env');

  const plan = cargar();
  const thumbPorFila = new Map(plan.thumbnails.map((t) => [t.rowId, t]));

  const client = db();
  await client.connect();
  const { rows } = await client.query(
    `select id, name, url, provider, provider_metadata, ext, mime, size, width, height, formats
       from files order by id ${LIMIT ? `limit ${LIMIT}` : ''}`,
  );

  console.log(`${APPLY ? 'APLICANDO' : 'DRY-RUN'} sobre ${rows.length} filas\n`);

  const rollback = [];
  let hechas = 0, saltadas = 0, convertidas = 0;

  for (const row of rows) {
    const item = plan.principales.get(row.id);
    if (!item) {
      saltadas++;
      console.log(`SKIP  id=${row.id} ${row.name}: sin item en el plan`);
      continue;
    }

    const archivo = path.join(plan.dir, item.originalKey);
    const extReal = path.extname(item.originalKey).toLowerCase();
    const mimeReal = MIME_POR_EXT[extReal] || row.mime;

    const nuevo = {
      url: `${CDN}/${item.originalKey}`,
      provider: 'aws-s3',
      provider_metadata: null,
      ext: extReal,
      mime: mimeReal,
      size: kb(fs.statSync(archivo).size),
      width: row.width,
      height: row.height,
      formats: row.formats,
    };

    // Las dimensiones se leen del archivo subido y no se heredan: varias
    // imágenes cambiaron de formato o quedaron capadas al rescatarlas.
    if (REDIMENSIONABLE.test(mimeReal)) {
      try {
        const meta = await sharp(fs.readFileSync(archivo)).metadata();
        if (meta.width) nuevo.width = meta.width;
        if (meta.height) nuevo.height = meta.height;
      } catch {
        /* se conservan las de la fila */
      }
    }

    if (row.ext !== extReal || row.mime !== mimeReal) convertidas++;

    // Sólo se conserva el thumbnail dentro de formats, con su url nueva.
    const formats = parse(row.formats);
    const thumb = thumbPorFila.get(row.id);
    if (formats && formats.thumbnail && thumb) {
      nuevo.formats = JSON.stringify({
        thumbnail: { ...formats.thumbnail, url: `${CDN}/${thumb.originalKey}`, provider_metadata: undefined },
      });
    } else if (formats && Object.keys(formats).length === 0) {
      nuevo.formats = JSON.stringify({});
    } else if (!thumb) {
      nuevo.formats = null;
    }

    if (!APPLY) {
      if (hechas < 6) {
        console.log(`${row.name.slice(0, 34).padEnd(35)} -> ${nuevo.url.replace(CDN, '…')}`);
        if (row.ext !== nuevo.ext || row.mime !== nuevo.mime) console.log(`   ${row.ext} ${row.mime} ${row.size}KB -> ${nuevo.ext} ${nuevo.mime} ${nuevo.size}KB  ${nuevo.width}x${nuevo.height}`);
      }
      hechas++;
      continue;
    }

    rollback.push({
      id: row.id,
      ...Object.fromEntries(COLUMNAS.map((c) => [
        c,
        c === 'provider_metadata' || c === 'formats'
          ? (row[c] === null ? null : (typeof row[c] === 'string' ? row[c] : JSON.stringify(row[c])))
          : row[c],
      ])),
    });

    await client.query(
      `update files set url=$1, provider=$2, provider_metadata=$3, ext=$4, mime=$5,
              size=$6, width=$7, height=$8, formats=$9, updated_at=now() where id=$10`,
      [nuevo.url, nuevo.provider, nuevo.provider_metadata, nuevo.ext, nuevo.mime,
        nuevo.size, nuevo.width, nuevo.height, nuevo.formats, row.id],
    );
    hechas++;
    if (hechas % 250 === 0) process.stdout.write(`\r${hechas}/${rows.length}`);
  }

  if (APPLY && rollback.length) {
    let previo = [];
    if (fs.existsSync(ROLLBACK_PATH)) {
      try { previo = JSON.parse(fs.readFileSync(ROLLBACK_PATH, 'utf-8')); } catch { previo = []; }
    }
    const merged = [...previo.filter((e) => !rollback.some((r) => r.id === e.id)), ...rollback];
    fs.writeFileSync(ROLLBACK_PATH, JSON.stringify(merged, null, 1));
    console.log(`\nRollback guardado en ${ROLLBACK_PATH} (${merged.length} filas)`);
  }

  console.log(`\nreescritas: ${hechas}  saltadas: ${saltadas}  con ext/mime realineado: ${convertidas}`);
  if (!APPLY) console.log('\nNada se modificó. Volvé a correr con --apply.');
  await client.end();
}

async function runRollback() {
  const entries = JSON.parse(fs.readFileSync(ROLLBACK_FILE, 'utf-8'));
  console.log(`${APPLY ? 'APLICANDO' : 'DRY-RUN'} rollback de ${entries.length} filas`);
  if (!APPLY) { console.log('Agregá --apply para restaurar.'); return; }
  const client = db();
  await client.connect();
  for (const e of entries) {
    await client.query(
      `update files set url=$1, provider=$2, provider_metadata=$3, ext=$4, mime=$5,
              size=$6, width=$7, height=$8, formats=$9, updated_at=now() where id=$10`,
      [e.url, e.provider, e.provider_metadata, e.ext, e.mime, e.size, e.width, e.height, e.formats, e.id],
    );
  }
  console.log(`${entries.length} filas restauradas.`);
  await client.end();
}

(ROLLBACK_FILE ? runRollback() : runRewrite()).catch((e) => { console.error(e); process.exit(1); });
