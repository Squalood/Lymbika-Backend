#!/usr/bin/env node
/**
 * Convierte a WebP los PNG originales de la Media Library (Cloudinary + tabla `files`).
 *
 * No es destructivo: sube el WebP con un public_id nuevo (`<original>_webp`) y repunta
 * la fila de `files`. El PNG original queda intacto en Cloudinary, así que el rollback
 * es sólo restaurar las columnas de la BD (ver --rollback).
 *
 * Truco de ahorro: la fuente que se descarga NO es el PNG original, es la transformación
 * `f_webp,q_auto` que Cloudinary genera. Se transfiere ~15% de los bytes, lo que importa
 * cuando la cuota de bandwidth de la cuenta es justo el recurso agotado.
 *
 * Uso:
 *   node scripts/png-to-webp.js                    # dry-run (no toca nada)
 *   node scripts/png-to-webp.js --limit 5 --apply  # aplica sólo a 5, para probar
 *   node scripts/png-to-webp.js --apply            # aplica a todos
 *   node scripts/png-to-webp.js --rollback scripts/png-to-webp.rollback.json --apply
 *
 * Deja `formats` (las variantes thumbnail/small/medium/large) sin tocar: siguen siendo
 * PNG válidos y nada del frontend los consume.
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
const CONCURRENCY = 4;
const ROLLBACK_PATH = path.join(__dirname, 'png-to-webp.rollback.json');

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

const kb = (bytes) => Math.round((bytes / 1024) * 100) / 100;
const mb = (bytes) => (bytes / 1048576).toFixed(2) + ' MB';

/** URL de la versión WebP que Cloudinary genera al vuelo desde el PNG. */
function webpSourceUrl(url) {
  return url.replace('/upload/', '/upload/f_webp,q_auto/');
}

async function convertOne(row) {
  const meta = typeof row.provider_metadata === 'string'
    ? JSON.parse(row.provider_metadata)
    : row.provider_metadata;
  const publicId = meta && meta.public_id;
  if (!publicId) throw new Error('sin public_id en provider_metadata');

  const res = await fetch(webpSourceUrl(row.url));
  if (!res.ok) throw new Error(`descarga HTTP ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());

  const originalBytes = Number(row.size) * 1024;
  if (buffer.byteLength >= originalBytes) {
    return { skipped: `el WebP (${mb(buffer.byteLength)}) no es más chico que el PNG (${mb(originalBytes)})` };
  }

  const newPublicId = `${publicId}_webp`;

  if (!APPLY) {
    return { originalBytes, newBytes: buffer.byteLength, newPublicId, dryRun: true };
  }

  const uploaded = await new Promise((resolve, reject) => {
    cloudinary.uploader
      .upload_stream(
        { public_id: newPublicId, resource_type: 'image', format: 'webp', overwrite: true, invalidate: true },
        (err, result) => (err ? reject(err) : resolve(result)),
      )
      .end(buffer);
  });

  return {
    originalBytes,
    newBytes: buffer.byteLength,
    newPublicId,
    update: {
      url: uploaded.secure_url,
      ext: '.webp',
      mime: 'image/webp',
      size: kb(uploaded.bytes || buffer.byteLength),
      hash: `${row.hash}_webp`,
      provider_metadata: JSON.stringify({ public_id: uploaded.public_id, resource_type: 'image' }),
    },
  };
}

async function runConversion() {
  const client = db();
  await client.connect();

  const { rows } = await client.query(
    `select id, name, hash, ext, mime, size, url, provider_metadata
       from files
      where mime = 'image/png' and provider = 'cloudinary'
      order by size desc
      ${LIMIT ? `limit ${LIMIT}` : ''}`,
  );

  console.log(`${APPLY ? 'APLICANDO' : 'DRY-RUN'} sobre ${rows.length} PNG\n`);

  const rollback = [];
  let done = 0, failed = 0, skipped = 0, before = 0, after = 0;
  let cursor = 0;

  async function worker() {
    while (cursor < rows.length) {
      const row = rows[cursor++];
      const label = String(row.name).slice(0, 40).padEnd(41);
      try {
        const out = await convertOne(row);

        if (out.skipped) {
          skipped++;
          console.log(`SKIP  ${label} ${out.skipped}`);
          continue;
        }

        before += out.originalBytes;
        after += out.newBytes;
        const pct = (100 - (out.newBytes / out.originalBytes) * 100).toFixed(1);

        if (out.dryRun) {
          console.log(`DRY   ${label} ${mb(out.originalBytes).padStart(9)} -> ${mb(out.newBytes).padStart(9)}  -${pct}%`);
        } else {
          rollback.push({
            id: row.id,
            url: row.url, ext: row.ext, mime: row.mime, size: row.size, hash: row.hash,
            provider_metadata: typeof row.provider_metadata === 'string'
              ? row.provider_metadata
              : JSON.stringify(row.provider_metadata),
          });
          const u = out.update;
          await client.query(
            `update files set url=$1, ext=$2, mime=$3, size=$4, hash=$5, provider_metadata=$6, updated_at=now() where id=$7`,
            [u.url, u.ext, u.mime, u.size, u.hash, u.provider_metadata, row.id],
          );
          console.log(`OK    ${label} ${mb(out.originalBytes).padStart(9)} -> ${mb(out.newBytes).padStart(9)}  -${pct}%`);
        }
        done++;
      } catch (err) {
        failed++;
        console.log(`ERROR ${label} ${err.message}`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  if (APPLY && rollback.length) {
    // Se acumula con lo que haya de corridas anteriores: si esto se aplica por lotes
    // (--limit), sobrescribir el archivo dejaría los lotes previos sin rollback.
    let previous = [];
    if (fs.existsSync(ROLLBACK_PATH)) {
      try {
        previous = JSON.parse(fs.readFileSync(ROLLBACK_PATH, 'utf-8'));
      } catch {
        const stash = ROLLBACK_PATH + '.corrupto-' + Date.now();
        fs.renameSync(ROLLBACK_PATH, stash);
        console.log('\nAVISO: el rollback anterior estaba ilegible, lo mande a ' + stash);
      }
    }
    const merged = [...previous.filter((e) => !rollback.some((r) => r.id === e.id)), ...rollback];
    fs.writeFileSync(ROLLBACK_PATH, JSON.stringify(merged, null, 1));
    console.log('\nRollback guardado en ' + ROLLBACK_PATH + ' (' + merged.length + ' filas acumuladas)');
  }

  console.log(`\nconvertidos: ${done}  saltados: ${skipped}  errores: ${failed}`);
  console.log(`storage: ${mb(before)} -> ${mb(after)}   ahorro: ${mb(before - after)}`);
  if (!APPLY) console.log('\nNada se modificó. Volvé a correr con --apply para aplicarlo.');

  await client.end();
}

async function runRollback() {
  const entries = JSON.parse(fs.readFileSync(ROLLBACK_FILE, 'utf-8'));
  console.log(`${APPLY ? 'APLICANDO' : 'DRY-RUN'} rollback de ${entries.length} filas`);
  if (!APPLY) {
    console.log('Nada se modificó. Agregá --apply para restaurar.');
    return;
  }
  const client = db();
  await client.connect();
  for (const e of entries) {
    await client.query(
      `update files set url=$1, ext=$2, mime=$3, size=$4, hash=$5, provider_metadata=$6, updated_at=now() where id=$7`,
      [e.url, e.ext, e.mime, e.size, e.hash, e.provider_metadata, e.id],
    );
  }
  console.log(`${entries.length} filas restauradas. Los assets .webp siguen en Cloudinary (borralos a mano si no los querés).`);
  await client.end();
}

(ROLLBACK_FILE ? runRollback() : runConversion()).catch((err) => {
  console.error(err);
  process.exit(1);
});
