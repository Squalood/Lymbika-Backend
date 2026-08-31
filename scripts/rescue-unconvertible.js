#!/usr/bin/env node
/**
 * Rescata, usando las transformaciones de Cloudinary, todo lo que sharp local no
 * sabe convertir: HEIC (fotos de iPhone) y QuickTime .MOV.
 *
 * URGENTE Y NO REPETIBLE: es el único paso de la migración que necesita que la
 * cuenta de Cloudinary siga activa. Los HEIC hoy se ven en el sitio sólo porque
 * f_auto los convierte al vuelo; sin ese rescate quedarían 383 referencias
 * rotas en clinic, doctor, medical-service y compra-pos.
 *
 * Escribe en .migracion-media/ con el mismo esquema de nombres que
 * build-variants.js, para que el loader del frontend no distinga el origen.
 *
 * Uso:
 *   node scripts/rescue-unconvertible.js [--limit N]
 */

const fs = require('fs');
const path = require('path');

require('dotenv').config();
const { Client } = require('pg');

const OUT = path.join(__dirname, '..', '.migracion-media');
const WIDTHS = [128, 384, 640, 1080, 1920];
const FULL_WIDTH = 2400; // tope para el "original" convertido
const CONCURRENCY = 4;

const args = process.argv.slice(2);
const LIMIT = (() => {
  const i = args.indexOf('--limit');
  return i >= 0 ? parseInt(args[i + 1], 10) : null;
})();

const kb = (b) => (b / 1024).toFixed(0) + ' KB';
const transform = (url, t) => url.replace('/upload/', '/upload/' + t + '/');
const swapExt = (p, ext) => p.replace(/\.[^./]+$/, '.' + ext);

/** Clave en el bucket, derivada del public_id igual que en el backup. */
const keyFrom = (url) => {
  const p = new URL(url).pathname.split('/upload/')[1] || '';
  return p.replace(/^v\d+\//, '');
};

async function get(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return Buffer.from(await r.arrayBuffer());
}

/** true si el objeto ya se descargo en una corrida anterior. */
const yaEsta = (key) => {
  const dest = path.join(OUT, key);
  return fs.existsSync(dest) && fs.statSync(dest).size > 0;
};

const write = (key, buf) => {
  const dest = path.join(OUT, key);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
  return buf.byteLength;
};

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
  const { rows } = await client.query(
    `select id, name, url, mime, ext, size from files
      where lower(ext) = '.heic' or mime like '%heic%' or mime like '%quicktime%'
         or url ilike '%.heic' or url ilike '%.mov'
      order by size desc
      ${LIMIT ? `limit ${LIMIT}` : ''}`,
  );
  await client.end();

  console.log(`${rows.length} archivos a rescatar\n`);
  fs.mkdirSync(OUT, { recursive: true });

  const plan = [];
  let ok = 0, fail = 0, bytes = 0, cursor = 0;

  async function worker() {
    while (cursor < rows.length) {
      const row = rows[cursor++];
      const baseKey = keyFrom(row.url);
      try {
        if (/quicktime/.test(row.mime)) {
          const key = swapExt(baseKey, 'mp4');
          if (!yaEsta(key)) {
            bytes += write(key, await get(transform(row.url, 'vc_auto,q_auto:eco,w_1280,c_limit,ac_none')));
          }
          const buf = { byteLength: fs.statSync(path.join(OUT, key)).size };
          plan.push({ rowId: row.id, kind: 'video', originalKey: key, mime: 'video/mp4', ext: '.mp4', variants: [] });
          console.log(`OK video ${row.name}  ${kb(Number(row.size) * 1024)} -> ${kb(buf.byteLength)}`);
        } else {
          const key = swapExt(baseKey, 'webp');
          let fullBytes = 0;
          if (yaEsta(key)) {
            fullBytes = fs.statSync(path.join(OUT, key)).size;
          } else {
            fullBytes = write(key, await get(transform(row.url, `f_webp,q_auto,w_${FULL_WIDTH},c_limit`)));
            bytes += fullBytes;
          }

          const variants = [];
          for (const width of WIDTHS) {
            const vKey = swapExt(baseKey, '').replace(/\.$/, '') + '_w' + width + '.webp';
            let vBytes;
            if (yaEsta(vKey)) {
              vBytes = fs.statSync(path.join(OUT, vKey)).size;
            } else {
              vBytes = write(vKey, await get(transform(row.url, `f_webp,q_auto,w_${width},c_limit`)));
              bytes += vBytes;
            }
            variants.push({ width, key: vKey, bytes: vBytes });
          }
          plan.push({ rowId: row.id, kind: 'image', originalKey: key, mime: 'image/webp', ext: '.webp', variants });
          console.log(`OK imagen ${row.name.slice(0, 28).padEnd(29)} ${kb(Number(row.size) * 1024).padStart(9)} -> ${kb(fullBytes).padStart(8)} + ${variants.length} variantes`);
        }
        ok++;
      } catch (err) {
        fail++;
        console.log(`ERROR ${row.name}: ${err.message}`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  fs.writeFileSync(path.join(OUT, '_plan-rescate.json'), JSON.stringify({ widths: WIDTHS, items: plan }, null, 1));
  console.log(`\nrescatados: ${ok}  fallidos: ${fail}`);
  console.log(`descargado de Cloudinary: ${(bytes / 1048576).toFixed(1)} MB`);
  console.log(`plan en ${path.join(OUT, '_plan-rescate.json')}`);
})().catch((e) => { console.error(e); process.exit(1); });
