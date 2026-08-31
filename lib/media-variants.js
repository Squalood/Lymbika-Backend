/**
 * Generación de las variantes WebP que sirve el frontend.
 *
 * S3 no transforma imágenes, así que cada ancho tiene que existir como objeto.
 * El loader de next/image construye <clave sin extensión>_w<ancho>.webp por
 * convención, sin consultar nada: si el objeto no está, la imagen sale rota.
 *
 * Por eso esto corre en el lifecycle afterCreate de plugin::upload.file, y el
 * mismo módulo lo reutiliza scripts/sync-new-media.js para reparar lo que se
 * haya subido mientras el hook no estaba desplegado.
 *
 * Los anchos coinciden con deviceSizes + imageSizes de next.config.ts del
 * frontend. Si cambian allá, hay que cambiarlos aquí.
 */

const sharp = require('sharp');
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
} = require('@aws-sdk/client-s3');

const WIDTHS = [128, 384, 640, 1080, 1920];
const QUALITY = 78;
const CACHE = 'public, max-age=31536000, immutable';

/** Formatos que sharp sabe redimensionar en esta instalación (sin HEIC). */
const REDIMENSIONABLE = /^image\/(png|jpe?g|webp|avif|tiff)$/;

const variantKey = (key, width) => key.replace(/\.[^./]+$/, '') + '_w' + width + '.webp';
const posterKey = (key) => key.replace(/\.[^./]+$/, '') + '_poster.webp';

/** Clave del objeto tal como la arma el provider de S3: hash + ext. */
const keyFromFile = (file) => `${file.hash}${file.ext || ''}`;

/** Clave a partir de una url de CloudFront. */
function keyFromUrl(url, cdnUrl) {
  const base = String(cdnUrl || '').replace(/\/+$/, '');
  if (!base || !String(url).startsWith(base + '/')) return null;
  return String(url).slice(base.length + 1);
}

function makeClient(env = process.env) {
  return new S3Client({
    region: env.AWS_REGION,
    credentials: {
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    },
  });
}

async function existe(s3, bucket, key) {
  try {
    const r = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return (r.ContentLength || 0) > 0;
  } catch {
    return false;
  }
}

async function descargar(s3, bucket, key) {
  const r = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const trozos = [];
  for await (const t of r.Body) trozos.push(t);
  return Buffer.concat(trozos);
}

/**
 * Asegura que existan las variantes de una imagen ya subida al bucket.
 * Devuelve { generadas, existentes, omitida }.
 */
async function ensureVariants({ key, mime, buffer, s3, bucket, force = false, log = () => {} }) {
  if (!REDIMENSIONABLE.test(mime || '')) return { generadas: 0, existentes: 0, omitida: 'formato no redimensionable' };

  const cliente = s3 || makeClient();
  const balde = bucket || process.env.AWS_BUCKET;
  if (!balde) throw new Error('Falta AWS_BUCKET');

  const pendientes = [];
  let existentes = 0;
  for (const width of WIDTHS) {
    const vKey = variantKey(key, width);
    if (!force && (await existe(cliente, balde, vKey))) existentes++;
    else pendientes.push({ width, vKey });
  }
  if (pendientes.length === 0) return { generadas: 0, existentes, omitida: null };

  const origen = buffer || (await descargar(cliente, balde, key));

  let generadas = 0;
  for (const { width, vKey } of pendientes) {
    const webp = await sharp(origen)
      .rotate()
      .resize({ width, withoutEnlargement: true })
      .webp({ quality: QUALITY })
      .toBuffer();
    await cliente.send(new PutObjectCommand({
      Bucket: balde,
      Key: vKey,
      Body: webp,
      ContentType: 'image/webp',
      CacheControl: CACHE,
    }));
    generadas++;
    log(`variante ${vKey} (${(webp.byteLength / 1024).toFixed(0)} KB)`);
  }

  return { generadas, existentes, omitida: null };
}

module.exports = {
  WIDTHS,
  QUALITY,
  REDIMENSIONABLE,
  variantKey,
  posterKey,
  keyFromFile,
  keyFromUrl,
  makeClient,
  existe,
  descargar,
  ensureVariants,
};
