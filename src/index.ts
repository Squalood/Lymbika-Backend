// import type { Core } from '@strapi/strapi';

import path from 'path';

// Se resuelve desde la raiz del proyecto y no con una ruta relativa: este
// archivo vive en src/index.ts en desarrollo y en dist/src/index.js una vez
// compilado, asi que "../lib" no apuntaria al mismo sitio en los dos casos.
// El build de Strapi solo transpila .ts, por eso el modulo no vive en src/.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const mediaVariants = require(path.join(process.cwd(), 'lib', 'media-variants.js'));

/**
 * Genera las variantes WebP de una imagen recién subida.
 *
 * S3 no transforma nada, así que cada ancho que pida el loader del frontend
 * tiene que existir como objeto. Sin esto, toda imagen subida después de la
 * migración se vería rota en el sitio.
 *
 * Nunca lanza: una imagen sin variantes es un problema recuperable con
 * scripts/sync-new-media.js, pero tumbar la subida no lo es.
 */
async function asegurarVariantes(strapi, file, motivo: string) {
  if (!file || !mediaVariants.REDIMENSIONABLE.test(file.mime || '')) return;

  const key = mediaVariants.keyFromFile(file);
  try {
    const { generadas, existentes } = await mediaVariants.ensureVariants({
      key,
      mime: file.mime,
      bucket: process.env.AWS_BUCKET,
    });
    if (generadas > 0) {
      strapi.log.info(`[media] ${key}: ${generadas} variantes generadas (${existentes} ya estaban) [${motivo}]`);
    }
  } catch (error) {
    strapi.log.error(`[media] no se pudieron generar las variantes de ${key}: ${error.message}`);
  }
}

export default {
  /**
   * An asynchronous register function that runs before
   * your application is initialized.
   *
   * This gives you an opportunity to extend code.
   */
  register(/* { strapi }: { strapi: Core.Strapi } */) {},

  /**
   * An asynchronous bootstrap function that runs before
   * your application gets started.
   *
   * This gives you an opportunity to set up your data model,
   * run jobs, or perform some special logic.
   */
  bootstrap({ strapi }) {
    const provider = strapi.config.get('plugin::upload.provider');
    if (provider !== 'aws-s3') {
      strapi.log.info(`[media] provider "${provider}": no se generan variantes WebP`);
      return;
    }

    strapi.db.lifecycles.subscribe({
      models: ['plugin::upload.file'],

      async afterCreate(event) {
        await asegurarVariantes(strapi, event.result, 'alta');
      },

      // Reemplazar un archivo desde el admin cambia el hash, así que la nueva
      // clave llega sin variantes. Cuando ya existen, esto son cinco HEAD.
      async afterUpdate(event) {
        await asegurarVariantes(strapi, event.result, 'reemplazo');
      },
    });

    strapi.log.info(`[media] variantes WebP activas para anchos ${mediaVariants.WIDTHS.join(', ')}`);
  },
};
