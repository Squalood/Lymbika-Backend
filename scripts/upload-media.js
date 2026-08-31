#!/usr/bin/env node
/**
 * Sube a S3 el árbol de .migracion-media/ según el plan consolidado.
 *
 * Reanudable: lista el bucket una vez y salta lo que ya está, en lugar de
 * preguntar objeto por objeto (serían 20.000 peticiones extra).
 *
 * Los nombres llevan el hash que puso Cloudinary, así que el contenido de una
 * clave nunca cambia: se sube con Cache-Control inmutable de un año para que
 * CloudFront y los navegadores no revaliden nunca.
 *
 * Uso:
 *   node scripts/upload-media.js --dry-run
 *   node scripts/upload-media.js --limit 50
 *   node scripts/upload-media.js
 */

const fs = require('fs');
const path = require('path');

require('dotenv').config();
const { S3Client, ListObjectsV2Command, PutObjectCommand } = require('@aws-sdk/client-s3');
const { cargar } = require('./media-plan.js');

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const LIMIT = (() => {
  const i = args.indexOf('--limit');
  return i >= 0 ? parseInt(args[i + 1], 10) : null;
})();
const CONCURRENCY = 12;
const CACHE = 'public, max-age=31536000, immutable';

const TIPOS = {
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.heic': 'image/heic',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
};

const BUCKET = process.env.AWS_BUCKET;
const mb = (b) => (b / 1048576).toFixed(1) + ' MB';

const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

/** Inventario del bucket, paginado, para poder reanudar. */
async function yaSubido() {
  const claves = new Set();
  let token;
  do {
    const r = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, ContinuationToken: token, MaxKeys: 1000 }));
    for (const o of r.Contents || []) if (o.Size > 0) claves.add(o.Key);
    token = r.NextContinuationToken;
    process.stdout.write(`\rinventariando el bucket: ${claves.size}`);
  } while (token);
  process.stdout.write('\n');
  return claves;
}

(async () => {
  for (const v of ['AWS_BUCKET', 'AWS_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY']) {
    if (!process.env[v]) throw new Error(`Falta ${v} en .env`);
  }

  const plan = cargar();
  const existentes = DRY ? new Set() : await yaSubido();

  let pendientes = [...plan.claves].filter((k) => !existentes.has(k)).sort();
  if (LIMIT) pendientes = pendientes.slice(0, LIMIT);

  const totalBytes = pendientes.reduce((t, k) => t + fs.statSync(path.join(plan.dir, k)).size, 0);
  const sinTipo = new Set(pendientes.map((k) => path.extname(k).toLowerCase()).filter((e) => !TIPOS[e]));

  console.log(`\nplan: ${plan.claves.size} claves | ya en el bucket: ${existentes.size} | a subir: ${pendientes.length} (${mb(totalBytes)})`);
  if (sinTipo.size) console.log(`AVISO: extensiones sin content-type definido: ${[...sinTipo].join(', ')}`);

  if (DRY || pendientes.length === 0) {
    console.log(DRY ? '\nDRY-RUN: nada se subió.' : '\nNada pendiente, el bucket ya está completo.');
    return;
  }

  let ok = 0, fail = 0, subido = 0, cursor = 0;
  const errores = [];

  async function worker() {
    while (cursor < pendientes.length) {
      const key = pendientes[cursor++];
      const file = path.join(plan.dir, key);
      try {
        const body = fs.readFileSync(file);
        await s3.send(new PutObjectCommand({
          Bucket: BUCKET,
          Key: key,
          Body: body,
          ContentType: TIPOS[path.extname(key).toLowerCase()] || 'application/octet-stream',
          CacheControl: CACHE,
        }));
        subido += body.byteLength;
        ok++;
      } catch (err) {
        fail++;
        if (errores.length < 10) errores.push(`${key}: ${err.name} ${err.message.slice(0, 60)}`);
      }
      if ((ok + fail) % 250 === 0) {
        process.stdout.write(`\r${ok + fail}/${pendientes.length}  subido ${mb(subido)}  fallos ${fail}`);
      }
    }
  }

  const t0 = Date.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const seg = ((Date.now() - t0) / 1000).toFixed(0);

  console.log(`\n\nsubidos: ${ok}  fallidos: ${fail}  en ${seg}s  (${mb(subido)})`);
  for (const e of errores) console.log('  ' + e);
  if (fail) console.log('\nVolvé a correr el script: sólo reintenta lo que falta.');
})().catch((e) => { console.error(e); process.exit(1); });
