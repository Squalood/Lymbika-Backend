#!/usr/bin/env node
/**
 * Comprueba y repara la coherencia entre la tabla `files` y el bucket.
 *
 * Verifica, para cada fila, que exista el objeto que el provider de S3 va a
 * pedir (hash + ext) y las cinco variantes _w<ancho>.webp que construye el
 * loader del frontend. Con --fix genera y sube lo que falte.
 *
 * Sirve para dos cosas: validar la migración de una vez, y reparar después las
 * imágenes que se hayan subido mientras el hook de src/index.ts no estaba
 * desplegado.
 *
 * Los posters de video sólo se generan corriendo esto en local, donde hay
 * ffmpeg; en Render no está instalado. Que falte un poster no rompe nada: el
 * navegador simplemente no muestra una imagen previa.
 *
 * Uso:
 *   node scripts/sync-new-media.js                  # sólo informa
 *   node scripts/sync-new-media.js --fix            # genera lo que falta
 *   node scripts/sync-new-media.js --fix --limit 5
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

require('dotenv').config();
const { Client } = require('pg');
const { PutObjectCommand } = require('@aws-sdk/client-s3');
const {
  WIDTHS, REDIMENSIONABLE, variantKey, posterKey, keyFromFile,
  makeClient, existe, descargar, ensureVariants,
} = require('../lib/media-variants.js');

const args = process.argv.slice(2);
const FIX = args.includes('--fix');
const LIMIT = (() => {
  const i = args.indexOf('--limit');
  return i >= 0 ? parseInt(args[i + 1], 10) : null;
})();

const BUCKET = process.env.AWS_BUCKET;
const s3 = makeClient();

const hayFfmpeg = () => {
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; }
};

async function generarPoster(key) {
  const buf = await descargar(s3, BUCKET, key);
  const tmp = path.join(os.tmpdir(), 'poster-' + Date.now());
  const entrada = tmp + path.extname(key);
  const salida = tmp + '.webp';
  fs.writeFileSync(entrada, buf);
  try {
    for (const segundo of [1, 0]) {
      try {
        execFileSync('ffmpeg', ['-y', '-v', 'error', '-ss', String(segundo), '-i', entrada,
          '-frames:v', '1', '-vf', "scale='min(1280,iw)':-2", '-c:v', 'libwebp', '-quality', '78', salida],
          { stdio: ['ignore', 'ignore', 'pipe'] });
        break;
      } catch (e) { if (segundo === 0) throw e; }
    }
    const webp = fs.readFileSync(salida);
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET, Key: posterKey(key), Body: webp,
      ContentType: 'image/webp', CacheControl: 'public, max-age=31536000, immutable',
    }));
    return webp.byteLength;
  } finally {
    for (const f of [entrada, salida]) { try { fs.unlinkSync(f); } catch {} }
  }
}

(async () => {
  for (const v of ['AWS_BUCKET', 'AWS_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY']) {
    if (!process.env[v]) throw new Error(`Falta ${v} en .env`);
  }

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
    `select id, name, hash, ext, mime from files order by id ${LIMIT ? `limit ${LIMIT}` : ''}`,
  );
  await client.end();

  console.log(`${FIX ? 'REPARANDO' : 'REVISANDO'} ${rows.length} filas\n`);

  const ffmpeg = hayFfmpeg();
  const problemas = { originalAusente: [], variantesAusentes: [], posterAusente: [] };
  let arregladas = 0, posters = 0, revisadas = 0;

  for (const row of rows) {
    const key = keyFromFile(row);

    if (!(await existe(s3, BUCKET, key))) {
      problemas.originalAusente.push(`id=${row.id} ${key}`);
      continue;
    }

    if (REDIMENSIONABLE.test(row.mime || '')) {
      const faltan = [];
      for (const w of WIDTHS) if (!(await existe(s3, BUCKET, variantKey(key, w)))) faltan.push(w);
      if (faltan.length) {
        problemas.variantesAusentes.push(`id=${row.id} ${key} (faltan w${faltan.join(', w')})`);
        if (FIX) {
          const r = await ensureVariants({ key, mime: row.mime, s3, bucket: BUCKET });
          arregladas += r.generadas;
        }
      }
    } else if (/^video\//.test(row.mime || '')) {
      if (!(await existe(s3, BUCKET, posterKey(key)))) {
        problemas.posterAusente.push(`id=${row.id} ${key}`);
        if (FIX && ffmpeg) { await generarPoster(key); posters++; }
      }
    }

    revisadas++;
    if (revisadas % 250 === 0) process.stdout.write(`\r${revisadas}/${rows.length}`);
  }

  console.log(`\n\nrevisadas: ${revisadas}`);
  for (const [nombre, lista] of Object.entries(problemas)) {
    console.log(`${nombre}: ${lista.length}`);
    for (const l of lista.slice(0, 5)) console.log('   ' + l);
    if (lista.length > 5) console.log(`   … y ${lista.length - 5} más`);
  }
  if (FIX) {
    console.log(`\nvariantes generadas: ${arregladas}  posters generados: ${posters}`);
    if (!ffmpeg && problemas.posterAusente.length) console.log('AVISO: sin ffmpeg no se generaron posters.');
  } else if (Object.values(problemas).some((l) => l.length)) {
    console.log('\nCorré con --fix para generar lo que falta.');
  } else {
    console.log('\nTodo coherente: cada fila tiene su objeto y sus variantes.');
  }
})().catch((e) => { console.error(e); process.exit(1); });
