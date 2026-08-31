#!/usr/bin/env node
/**
 * Borra las variantes small/medium/large que Strapi sube a Cloudinary y que nadie consume.
 *
 * El frontend siempre pide `image.url` y deja que Cloudinary redimensione al vuelo
 * (ver lib/cloudinary-loader.ts), así que esas tres variantes son peso muerto: 1,148 MB
 * de los 1,191 MB que ocupan los `formats`.
 *
 * Conserva SIEMPRE `thumbnail`: es lo único que se usa, para las miniaturas de la
 * Media Library del admin (@strapi/upload -> createAssetUrl.mjs).
 *
 * Para que no se vuelvan a generar en cada subida nueva:
 *   admin -> Settings -> Media Library -> "Responsive friendly upload" = OFF
 * Ese toggle no afecta al thumbnail, que se genera aparte (image-manipulation.js:161).
 *
 * Uso:
 *   node scripts/purge-image-variants.js                    # dry-run
 *   node scripts/purge-image-variants.js --limit 20 --apply # lote de prueba
 *   node scripts/purge-image-variants.js --apply            # todo
 *   node scripts/purge-image-variants.js --rollback scripts/purge-image-variants.rollback.json --apply
 */

const fs = require('fs');
const path = require('path');

require('dotenv').config();
const { Client } = require('pg');
const cloudinary = require('cloudinary').v2;

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

const KEEP = 'thumbnail';
const DELETE_BATCH = 100; // tope de public_ids por llamada a delete_resources
const ROLLBACK_PATH = path.join(__dirname, 'purge-image-variants.rollback.json');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_NAME,
  api_key: process.env.CLOUDINARY_KEY,
  api_secret: process.env.CLOUDINARY_SECRET,
});

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

const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
const mb = (kbytes) => (kbytes / 1024).toFixed(1) + ' MB';

async function runPurge() {
  const client = db();
  await client.connect();

  const { rows } = await client.query(
    `select id, name, formats from files
      where formats is not null and provider = 'cloudinary'
      order by id
      ${LIMIT ? `limit ${LIMIT}` : ''}`,
  );

  console.log(`${APPLY ? 'APLICANDO' : 'DRY-RUN'} sobre ${rows.length} archivos con variantes\n`);

  const rollback = [];
  const publicIds = [];
  const updates = [];
  let freedKb = 0;
  let keptKb = 0;

  for (const row of rows) {
    let formats;
    try {
      formats = parse(row.formats);
    } catch {
      console.log(`SKIP  ${row.name} (formats ilegible)`);
      continue;
    }
    if (!formats) continue;

    const doomed = Object.keys(formats).filter((k) => k !== KEEP);
    if (doomed.length === 0) continue;

    const kept = {};
    if (formats[KEEP]) {
      kept[KEEP] = formats[KEEP];
      keptKb += formats[KEEP].size || 0;
    }

    for (const key of doomed) {
      freedKb += formats[key]?.size || 0;
      const id = formats[key]?.provider_metadata?.public_id;
      if (id) publicIds.push(id);
    }

    rollback.push({ id: row.id, formats: JSON.stringify(formats) });
    updates.push({ id: row.id, formats: Object.keys(kept).length ? JSON.stringify(kept) : null });
  }

  console.log(`variantes a borrar : ${publicIds.length} assets  ${mb(freedKb)}`);
  console.log(`thumbnails que quedan: ${mb(keptKb)}`);

  if (!APPLY) {
    console.log('\nNada se modificó. Volvé a correr con --apply para aplicarlo.');
    await client.end();
    return;
  }

  // El rollback se escribe ANTES de tocar nada.
  let previous = [];
  if (fs.existsSync(ROLLBACK_PATH)) {
    try {
      previous = JSON.parse(fs.readFileSync(ROLLBACK_PATH, 'utf-8'));
    } catch {
      const stash = ROLLBACK_PATH + '.corrupto-' + Date.now();
      fs.renameSync(ROLLBACK_PATH, stash);
      console.log('AVISO: el rollback anterior estaba ilegible, lo mande a ' + stash);
    }
  }
  const merged = [...previous.filter((e) => !rollback.some((r) => r.id === e.id)), ...rollback];
  fs.writeFileSync(ROLLBACK_PATH, JSON.stringify(merged, null, 1));
  console.log(`\nRollback guardado en ${ROLLBACK_PATH} (${merged.length} filas)`);

  // Primero la BD: así ninguna fila queda apuntando a un asset ya borrado.
  for (const u of updates) {
    await client.query('update files set formats = $1, updated_at = now() where id = $2', [u.formats, u.id]);
  }
  console.log(`${updates.length} filas actualizadas (formats reducido a ${KEEP})`);

  // Después Cloudinary. Si algo falla aquí sólo quedan huérfanos: se puede repetir.
  let deleted = 0;
  for (let i = 0; i < publicIds.length; i += DELETE_BATCH) {
    const batch = publicIds.slice(i, i + DELETE_BATCH);
    try {
      const res = await cloudinary.api.delete_resources(batch, { resource_type: 'image', invalidate: true });
      deleted += Object.values(res.deleted || {}).filter((s) => s === 'deleted').length;
      process.stdout.write(`\rborrando en Cloudinary: ${Math.min(i + DELETE_BATCH, publicIds.length)}/${publicIds.length}`);
    } catch (err) {
      console.log(`\nERROR en lote ${i}-${i + batch.length}: ${err.message}`);
    }
  }

  console.log(`\n\n${deleted} assets borrados de Cloudinary. Storage liberado: ~${mb(freedKb)}`);
  await client.end();
}

async function runRollback() {
  const entries = JSON.parse(fs.readFileSync(ROLLBACK_FILE, 'utf-8'));
  console.log(`${APPLY ? 'APLICANDO' : 'DRY-RUN'} rollback de ${entries.length} filas`);
  console.log('OJO: esto restaura la columna formats, pero los assets ya borrados de');
  console.log('Cloudinary NO vuelven. Las URLs de small/medium/large quedarían muertas.');
  if (!APPLY) {
    console.log('\nNada se modificó. Agregá --apply para restaurar.');
    return;
  }
  const client = db();
  await client.connect();
  for (const e of entries) {
    await client.query('update files set formats = $1, updated_at = now() where id = $2', [e.formats, e.id]);
  }
  console.log(`${entries.length} filas restauradas.`);
  await client.end();
}

(ROLLBACK_FILE ? runRollback() : runPurge()).catch((err) => {
  console.error(err);
  process.exit(1);
});
