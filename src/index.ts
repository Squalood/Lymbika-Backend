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

/**
 * Candados de la base de datos que Strapi no sabe declarar en un schema.
 *
 * - `pharmacy_stocks.pair_key` único: una sola fila por par producto-farmacia. Strapi no
 *   crea índices compuestos sobre relaciones (viven en tablas `_lnk`), así que /pos-stock
 *   escribe `pairKey = <productDocId>__<pharmacyDocId>` y la unicidad la da este índice.
 * - `stock_operations.op_key` único: hace idempotentes los reintentos de /pos-stock.
 *
 * Antes de crear el primero hay que completar el `pairKey` de las filas hechas a mano y
 * fusionar duplicados (sumando su stock), o el índice no se podría crear.
 *
 * Se corre en cada arranque: el sync de schema de Strapi puede quitar índices que no conoce.
 * Nunca lanza: sin el índice el stock sigue funcionando, pero se registra como error.
 */
async function asegurarIndicesDeStock(strapi) {
  const PS = 'api::pharmacy-stock.pharmacy-stock';
  const OP = 'api::stock-operation.stock-operation';
  const client = strapi.db.dialect?.client;
  if (client !== 'postgres' && client !== 'sqlite') {
    strapi.log.warn(`[stock] base "${client}": no se crean los índices únicos de stock`);
    return;
  }

  try {
    const knex = strapi.db.connection;
    const ps = strapi.db.metadata.get(PS);
    const op = strapi.db.metadata.get(OP);
    const pairCol = ps.attributes.pairKey.columnName;
    const stockCol = ps.attributes.stock.columnName;

    const rows = await strapi.db.query(PS).findMany({
      select: ['id', 'pairKey', 'stock'],
      populate: { product: { select: ['documentId'] }, pharmacy: { select: ['documentId'] } },
      orderBy: { id: 'asc' },
    });
    const keep = new Map<string, { id: number; stock: number; changed: boolean }>();
    const extras: number[] = [];
    for (const r of rows) {
      if (!r.product?.documentId || !r.pharmacy?.documentId) continue;
      const key = `${r.product.documentId}__${r.pharmacy.documentId}`;
      const k = keep.get(key);
      if (!k) {
        keep.set(key, { id: r.id, stock: Number(r.stock ?? 0), changed: r.pairKey !== key });
      } else {
        k.stock += Number(r.stock ?? 0);
        k.changed = true;
        extras.push(r.id);
      }
    }
    for (const [key, k] of keep) {
      if (k.changed) await knex(ps.tableName).where('id', k.id).update({ [pairCol]: key, [stockCol]: k.stock });
    }
    for (const id of extras) await strapi.db.query(PS).delete({ where: { id } });
    if (extras.length) strapi.log.warn(`[stock] se fusionaron ${extras.length} fila(s) duplicadas de pharmacy-stock`);

    await knex.raw('CREATE UNIQUE INDEX IF NOT EXISTS pharmacy_stocks_pair_key_uq ON ?? (??) WHERE ?? IS NOT NULL', [
      ps.tableName,
      pairCol,
      pairCol,
    ]);
    await knex.raw('CREATE UNIQUE INDEX IF NOT EXISTS stock_operations_op_key_uq ON ?? (??)', [
      op.tableName,
      op.attributes.opKey.columnName,
    ]);
    strapi.log.info('[stock] índices únicos de pharmacy-stock y stock-operation listos');
  } catch (error) {
    strapi.log.error(`[stock] no se pudieron asegurar los índices únicos: ${error.message}`);
  }
}

/**
 * TEMPORAL — borrar en el siguiente despliegue.
 *
 * Un despliegue anterior guardó en la base una vista en español del panel de
 * Strapi para la colección Case. Esto la borra y deja que Strapi regenere su
 * vista por defecto. Solo actúa si encuentra la marca que dejó ese despliegue,
 * así que después de correr una vez ya no hace nada.
 */
async function restaurarVistaDeCasos(strapi) {
  const marca = { type: 'core', name: 'lymbika', key: 'case-panel-version' };
  try {
    if ((await strapi.store.get(marca)) == null) return;
    await strapi.db.query('strapi::core-store').deleteMany({
      where: {
        key: {
          $in: [
            'plugin_content_manager_configuration_content_types::api::case.case',
            'plugin_content_manager_configuration_components::case.follow-up-task',
          ],
        },
      },
    });
    await strapi.plugin('content-manager').service('content-types').syncConfigurations();
    await strapi.plugin('content-manager').service('components').syncConfigurations();
    await strapi.store.delete(marca);
    strapi.log.info('[case] vista del panel de Casos restaurada a la de Strapi');
  } catch (error) {
    strapi.log.error(`[case] no se pudo restaurar la vista del panel: ${error.message}`);
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
  async bootstrap({ strapi }) {
    await asegurarIndicesDeStock(strapi);
    await restaurarVistaDeCasos(strapi);

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
