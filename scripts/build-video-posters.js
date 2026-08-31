#!/usr/bin/env node
/**
 * Genera un poster por video con ffmpeg local.
 *
 * Cloudinary producía el frame al vuelo con so_0,f_jpg. S3 no transforma nada,
 * así que el poster tiene que existir como objeto. Sin él, el hero de las
 * landings queda en negro hasta que el video termina de descargar.
 *
 * Se extrae a 1 segundo y no en el frame 0: muchos videos abren con un fundido
 * desde negro y el primer frame sería un rectángulo oscuro inútil.
 *
 * Clave del objeto: <clave del video sin extensión>_poster.webp, para que el
 * frontend la derive igual que las variantes _w<ancho>.webp.
 *
 * Uso:
 *   node scripts/build-video-posters.js [--limit N]
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { cargar } = require('./media-plan.js');

const WIDTH = 1280;
const QUALITY = 78;
const OUT_PLAN = '_plan-posters.json';

const args = process.argv.slice(2);
const LIMIT = (() => {
  const i = args.indexOf('--limit');
  return i >= 0 ? parseInt(args[i + 1], 10) : null;
})();

const posterKey = (videoKey) => videoKey.replace(/\.[^./]+$/, '') + '_poster.webp';
const kb = (b) => (b / 1024).toFixed(0) + ' KB';

function extraer(input, output, segundo) {
  execFileSync('ffmpeg', [
    '-y', '-v', 'error',
    '-ss', String(segundo),
    '-i', input,
    '-frames:v', '1',
    '-vf', `scale='min(${WIDTH},iw)':-2`,
    '-c:v', 'libwebp', '-quality', String(QUALITY),
    output,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
}

(async () => {
  const plan = cargar();

  const videos = [...plan.principales.values()].filter(
    (it) => it.kind === 'video' || /\.(mp4|mov|webm|m4v)$/i.test(it.originalKey),
  );
  const todo = LIMIT ? videos.slice(0, LIMIT) : videos;

  console.log(`${todo.length} videos\n`);

  const items = [];
  let ok = 0, fail = 0, bytes = 0;

  for (const item of todo) {
    const input = path.join(plan.dir, item.originalKey);
    const key = posterKey(item.originalKey);
    const output = path.join(plan.dir, key);

    if (fs.existsSync(output) && fs.statSync(output).size > 0) {
      items.push({ rowId: item.rowId, videoKey: item.originalKey, posterKey: key });
      bytes += fs.statSync(output).size;
      ok++;
      continue;
    }

    try {
      fs.mkdirSync(path.dirname(output), { recursive: true });
      try {
        extraer(input, output, 1);
      } catch {
        // Video de menos de un segundo: se cae al primer frame.
        extraer(input, output, 0);
      }
      if (!fs.existsSync(output) || fs.statSync(output).size === 0) throw new Error('salida vacía');

      const size = fs.statSync(output).size;
      bytes += size;
      items.push({ rowId: item.rowId, videoKey: item.originalKey, posterKey: key });
      ok++;
      console.log(`OK  ${kb(size).padStart(7)}  ${item.originalKey.slice(0, 52)}`);
    } catch (err) {
      fail++;
      console.log(`ERROR ${item.originalKey.slice(0, 44)}: ${String(err.message).slice(0, 60)}`);
    }
  }

  fs.writeFileSync(path.join(plan.dir, OUT_PLAN), JSON.stringify({ width: WIDTH, quality: QUALITY, items }, null, 1));
  console.log(`\nposters: ${ok}  fallidos: ${fail}  peso total: ${(bytes / 1048576).toFixed(2)} MB`);
  console.log(`plan en ${path.join(plan.dir, OUT_PLAN)}`);
})().catch((e) => { console.error(e); process.exit(1); });
