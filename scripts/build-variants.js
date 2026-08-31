#!/usr/bin/env node
/**
 * Genera las variantes WebP de cada imagen a partir de .backup-cloudinary/.
 *
 * Independiente del proveedor de destino: prepara el árbol de archivos que se
 * subirá tal cual a S3, R2 o B2. Sustituye la transformación al vuelo de
 * Cloudinary, que ninguno de esos servicios hace por sí solo.
 *
 * Los anchos son exactamente los que pedirá next/image (deviceSizes +
 * imageSizes), así que cada URL que construya el loader existe como archivo.
 * Se generan todos los anchos aunque el original sea más chico: con
 * withoutEnlargement el archivo sale del tamaño original, lo que gasta unos
 * KB de más pero garantiza que nunca haya un 404.
 *
 * Uso:
 *   node scripts/build-variants.js            # todo
 *   node scripts/build-variants.js --limit 20 # prueba
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const SRC = path.join(__dirname, '..', '.backup-cloudinary');
const OUT = path.join(__dirname, '..', '.migracion-media');
const WIDTHS = [128, 384, 640, 1080, 1920];
const QUALITY = 78;
const CONCURRENCY = 4;
const RESIZABLE = /^image\/(png|jpe?g|webp|avif|tiff)$/;

const args = process.argv.slice(2);
const LIMIT = (() => {
  const i = args.indexOf('--limit');
  return i >= 0 ? parseInt(args[i + 1], 10) : null;
})();

const manifest = JSON.parse(fs.readFileSync(path.join(SRC, '_manifest.json'), 'utf-8'));
const mb = (b) => (b / 1048576).toFixed(1) + ' MB';

/** Clave del objeto en el bucket: se conserva la ruta del public_id de Cloudinary. */
const keyFor = (item) => item.file.split(path.sep).join('/');
const variantKey = (key, width) => key.replace(/\.[^.]+$/, '') + '_w' + width + '.webp';

(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  const originals = manifest.filter((m) => m.kind === 'original');
  const thumbs = manifest.filter((m) => m.kind !== 'original');
  const resizable = originals.filter((m) => RESIZABLE.test(m.mime || ''));
  const asIs = [...originals.filter((m) => !RESIZABLE.test(m.mime || '')), ...thumbs];

  const todo = LIMIT ? resizable.slice(0, LIMIT) : resizable;
  console.log(`${todo.length} imágenes a variar en ${WIDTHS.length} anchos`);
  console.log(`${asIs.length} archivos se copian sin tocar (video, pdf, svg, heic, thumbnails)\n`);

  const out = [];
  let hechas = 0, fallidas = 0, bytes = 0, cursor = 0;

  const copiar = (item) => {
    const key = keyFor(item);
    const dest = path.join(OUT, key);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (!fs.existsSync(dest)) fs.copyFileSync(path.join(SRC, item.file), dest);
    return { key, bytes: fs.statSync(dest).size };
  };

  async function worker() {
    while (cursor < todo.length) {
      const item = todo[cursor++];
      const key = keyFor(item);
      const input = path.join(SRC, item.file);
      try {
        // Se pasa el contenido, no la ruta: libvips no abre rutas que superan el
        // MAX_PATH de Windows (260 chars) y varios nombres de Cloudinary llegan a 190.
        const buf = fs.readFileSync(input);
        const meta = await sharp(buf).metadata();
        const variants = [];

        for (const width of WIDTHS) {
          const vKey = variantKey(key, width);
          const dest = path.join(OUT, vKey);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          if (!fs.existsSync(dest)) {
            const webp = await sharp(buf)
              .rotate() // respeta el EXIF de orientación antes de redimensionar
              .resize({ width, withoutEnlargement: true })
              .webp({ quality: QUALITY })
              .toBuffer();
            fs.writeFileSync(dest, webp);
          }
          const size = fs.statSync(dest).size;
          bytes += size;
          variants.push({ width, key: vKey, bytes: size });
        }

        const original = copiar(item);
        bytes += original.bytes;
        out.push({ rowId: item.rowId, kind: 'image', originalKey: original.key, originalWidth: meta.width, variants });
        hechas++;
      } catch (err) {
        fallidas++;
        console.log(`ERROR ${item.name}: ${err.message}`);
      }
      if ((hechas + fallidas) % 100 === 0) {
        process.stdout.write(`\r${hechas + fallidas}/${todo.length}  generado ${mb(bytes)}`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  if (!LIMIT) {
    for (const item of asIs) {
      const c = copiar(item);
      bytes += c.bytes;
      out.push({ rowId: item.rowId, kind: item.kind === 'original' ? 'raw' : item.kind, originalKey: c.key, variants: [] });
    }
  }

  fs.writeFileSync(path.join(OUT, '_plan.json'), JSON.stringify({ widths: WIDTHS, quality: QUALITY, items: out }, null, 1));
  console.log(`\n\nimágenes procesadas: ${hechas}  fallidas: ${fallidas}`);
  console.log(`objetos a subir: ${out.reduce((n, i) => n + 1 + i.variants.length, 0)}`);
  console.log(`peso total: ${mb(bytes)}`);
  console.log(`plan en ${path.join(OUT, '_plan.json')}`);
})().catch((e) => { console.error(e); process.exit(1); });
