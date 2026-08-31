#!/usr/bin/env node
/**
 * Lista los assets que existen en Cloudinary pero que ya nadie referencia en Strapi.
 *
 * Aparecen sobre todo por borrados desde el admin que no limpiaron el asset remoto,
 * y por variantes de archivos que se eliminaron después.
 *
 * SOLO LECTURA: no borra nada. Escribe el inventario en scripts/orphans.json.
 *
 * Uso:
 *   node scripts/find-orphans.js
 */

const fs = require('fs');
const path = require('path');

require('dotenv').config();
const { Client } = require('pg');
const cloudinary = require('cloudinary').v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_NAME,
  api_key: process.env.CLOUDINARY_KEY,
  api_secret: process.env.CLOUDINARY_SECRET,
});

const OUT = path.join(__dirname, 'orphans.json');
const parse = (v) => { try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return null; } };
const mb = (bytes) => (bytes / 1048576).toFixed(1) + ' MB';

/** Todos los public_id que Strapi conoce: los originales y los de cada variante. */
async function referencedByStrapi() {
  const client = new Client({
    host: process.env.DATABASE_HOST,
    port: Number(process.env.DATABASE_PORT) || 5432,
    database: process.env.DATABASE_NAME,
    user: process.env.DATABASE_USERNAME,
    password: process.env.DATABASE_PASSWORD,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  const { rows } = await client.query('select provider_metadata, formats from files');
  await client.end();

  const ids = new Set();
  for (const row of rows) {
    const meta = parse(row.provider_metadata);
    if (meta?.public_id) ids.add(meta.public_id);

    const formats = parse(row.formats) || {};
    for (const key of Object.keys(formats)) {
      const id = formats[key]?.provider_metadata?.public_id;
      if (id) ids.add(id);
    }
  }
  return ids;
}

/** Inventario completo de la cuenta, paginando la Search API. */
async function everythingInCloudinary() {
  const assets = [];
  for (const type of ['image', 'video', 'raw']) {
    let cursor;
    do {
      const query = cloudinary.search
        .expression(`resource_type:${type}`)
        .with_field('context')
        .max_results(500);
      if (cursor) query.next_cursor(cursor);

      const res = await query.execute();
      for (const r of res.resources || []) {
        assets.push({ public_id: r.public_id, type, bytes: r.bytes || 0, created_at: r.created_at, format: r.format });
      }
      cursor = res.next_cursor;
      process.stdout.write(`\rinventariando ${type}: ${assets.length}`);
    } while (cursor);
  }
  process.stdout.write('\n');
  return assets;
}

(async () => {
  const referenced = await referencedByStrapi();
  console.log(`Strapi referencia ${referenced.size} public_id\n`);

  const assets = await everythingInCloudinary();
  console.log(`Cloudinary tiene ${assets.length} assets\n`);

  const orphans = assets.filter((a) => !referenced.has(a.public_id));
  const bytes = orphans.reduce((sum, a) => sum + a.bytes, 0);

  const byPrefix = {};
  for (const o of orphans) {
    const m = o.public_id.match(/^(large_|medium_|small_|thumbnail_)/);
    const key = m ? m[1] : '(sin prefijo de variante)';
    byPrefix[key] = byPrefix[key] || { n: 0, bytes: 0 };
    byPrefix[key].n++;
    byPrefix[key].bytes += o.bytes;
  }

  console.log(`HUERFANOS: ${orphans.length} assets  ${mb(bytes)}\n`);
  for (const [k, v] of Object.entries(byPrefix).sort((a, b) => b[1].bytes - a[1].bytes)) {
    console.log(`  ${k.padEnd(28)} ${String(v.n).padStart(5)}  ${mb(v.bytes).padStart(9)}`);
  }

  const biggest = [...orphans].sort((a, b) => b.bytes - a.bytes).slice(0, 10);
  console.log('\nLos 10 mas pesados:');
  for (const o of biggest) {
    console.log(`  ${mb(o.bytes).padStart(9)}  ${o.created_at?.slice(0, 10)}  ${o.public_id}`);
  }

  fs.writeFileSync(OUT, JSON.stringify(orphans, null, 1));
  console.log(`\nInventario completo en ${OUT}`);
})().catch((err) => { console.error(err); process.exit(1); });
