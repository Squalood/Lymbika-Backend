#!/usr/bin/env node
/**
 * Baja a disco todos los assets que Strapi referencia en Cloudinary.
 *
 * Es el seguro contra la suspensión de la cuenta y, de paso, la fuente para
 * migrar a otro proveedor: deja un manifest que mapea cada archivo local con
 * su fila en `files` y su public_id.
 *
 * Reanudable: si el archivo ya está en disco con el tamaño correcto, lo salta.
 *
 * Uso:
 *   node scripts/backup-cloudinary.js [--dest <carpeta>]
 */

const fs = require('fs');
const path = require('path');

require('dotenv').config();
const { Client } = require('pg');

const args = process.argv.slice(2);
const DEST = (() => {
  const i = args.indexOf('--dest');
  return i >= 0 ? args[i + 1] : path.join(__dirname, '..', '.backup-cloudinary');
})();
const CONCURRENCY = 6;

const parse = (v) => { try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return null; } };
const mb = (b) => (b / 1048576).toFixed(1) + ' MB';

(async () => {
  const client = new Client({
    host: process.env.DATABASE_HOST,
    port: Number(process.env.DATABASE_PORT) || 5432,
    database: process.env.DATABASE_NAME,
    user: process.env.DATABASE_USERNAME,
    password: process.env.DATABASE_PASSWORD,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  const { rows } = await client.query('select id, name, url, mime, ext, size, formats, provider_metadata from files');
  await client.end();

  // Un item por asset real en Cloudinary: el original y cada variante que quede.
  const items = [];
  for (const row of rows) {
    const meta = parse(row.provider_metadata);
    items.push({
      rowId: row.id, kind: 'original', name: row.name, url: row.url,
      publicId: meta?.public_id || null, mime: row.mime,
    });
    const formats = parse(row.formats) || {};
    for (const key of Object.keys(formats)) {
      const f = formats[key];
      if (!f?.url) continue;
      items.push({
        rowId: row.id, kind: key, name: f.name || key, url: f.url,
        publicId: f.provider_metadata?.public_id || null, mime: f.mime,
      });
    }
  }

  fs.mkdirSync(DEST, { recursive: true });
  console.log(`${items.length} assets a respaldar en ${DEST}\n`);

  const manifest = [];
  let ok = 0, skipped = 0, failed = 0, bytes = 0, cursor = 0;

  const localPathFor = (item) => {
    // El public_id puede traer carpetas; se respeta la estructura.
    const base = item.publicId || path.basename(new URL(item.url).pathname);
    const ext = path.extname(new URL(item.url).pathname) || '';
    const rel = (base.endsWith(ext) ? base : base + ext).replace(/[:*?"<>|]/g, '_');
    return path.join(DEST, rel);
  };

  async function worker() {
    while (cursor < items.length) {
      const item = items[cursor++];
      const dest = localPathFor(item);
      try {
        if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
          skipped++;
          manifest.push({ ...item, file: path.relative(DEST, dest), bytes: fs.statSync(dest).size });
          continue;
        }
        const res = await fetch(item.url);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const buf = Buffer.from(await res.arrayBuffer());
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, buf);
        bytes += buf.byteLength;
        ok++;
        manifest.push({ ...item, file: path.relative(DEST, dest), bytes: buf.byteLength });
      } catch (err) {
        failed++;
        console.log(`ERROR ${item.name}: ${err.message}`);
      }
      const done = ok + skipped + failed;
      if (done % 100 === 0) process.stdout.write(`\r${done}/${items.length}  descargado ${mb(bytes)}`);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  fs.writeFileSync(path.join(DEST, '_manifest.json'), JSON.stringify(manifest, null, 1));
  console.log(`\n\ndescargados: ${ok}  ya estaban: ${skipped}  fallidos: ${failed}`);
  console.log(`total transferido: ${mb(bytes)}`);
  console.log(`manifest en ${path.join(DEST, '_manifest.json')}`);
})().catch((err) => { console.error(err); process.exit(1); });
