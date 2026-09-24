'use strict';

/**
 * El catalogo de planes vive en Strapi: los price ids los pega un admin en cada
 * membresia. Este modulo es el unico que sabe leerlos, y lo usan los dos lados
 * del flujo — el checkout para cobrar, y el webhook para saber que se contrato.
 */

const MEMBERSHIP_UID = 'api::membership.membership' as any;

export type Tipo = 'personal' | 'familiar';

export const TIPOS = new Set<string>(['personal', 'familiar']);

export type Plan = {
  documentId: string;
  name: string;
  /** Lo que anuncia la pagina, en pesos. Solo para registro. */
  precio: number | null;
  /** `null` = ese plan no se vende en linea. */
  priceId: string | null;
};

/**
 * Un id de precio de Stripe siempre empieza por `price_`.
 *
 * El filtro atrapa el error de captura real: pegar la URL del Payment Link, o
 * un `prod_...`, en el campo. Mejor tratarlo como "no disponible en linea" que
 * mandarselo a Stripe y recibir un error opaco.
 */
function limpiarPriceId(bruto: unknown): string | null {
  const valor = typeof bruto === 'string' ? bruto.trim() : '';
  return valor.startsWith('price_') ? valor : null;
}

/**
 * En desarrollo se puede sobreescribir el price id sin tocar el dato de Strapi.
 *
 * Hace falta porque los price ids de test y de produccion son distintos y el
 * campo en Strapi es uno solo: sin esto, probar en local obligaria a pisar los
 * valores buenos. El guard de NODE_ENV impide que aplique en produccion.
 */
function priceIdDeDesarrollo(tipo: Tipo): string | null {
  if (process.env.NODE_ENV === 'production') return null;

  const valor =
    tipo === 'familiar' ? process.env.DEV_STRIPE_PRICE_F : process.env.DEV_STRIPE_PRICE_P;
  const limpio = limpiarPriceId(valor);

  if (limpio) {
    strapi.log.warn(
      `[planes] usando DEV_STRIPE_PRICE_${tipo === 'familiar' ? 'F' : 'P'} en vez del price id de Strapi`
    );
  }
  return limpio;
}

// ── Lectura del catalogo ─────────────────────────────────────────────────────

/**
 * Busca una membresia publicada y devuelve el price id del tipo pedido.
 *
 * Se direcciona por `documentId`, NO por el id numerico. En Strapi v5,
 * republicar un documento borra la fila publicada y crea otra: el id numerico
 * cambia y el `documentId` no. Con el id numerico, cada edicion de un plan en
 * el admin rompia el boton de suscribirse hasta que caducara la cache del
 * frontend.
 *
 * `status: 'published'` es obligatorio: el Document Service de v5 devuelve el
 * borrador por omision, y no se cobra por un plan sin publicar.
 */
export async function buscarPlan(documentId: string, tipo: Tipo): Promise<Plan | null> {
  let fila: any;
  try {
    fila = await strapi.documents(MEMBERSHIP_UID).findOne({
      documentId,
      status: 'published',
    });
  } catch (error) {
    strapi.log.error(`[planes] no se pudo leer la membresía ${documentId}`, error);
    return null;
  }

  if (!fila) return null;

  const campo = tipo === 'familiar' ? 'stripePriceIdF' : 'stripePriceIdP';
  const bruto = fila[campo];
  const enStrapi = limpiarPriceId(bruto);

  // Diagnostico: sin esto, "no se puede contratar en linea" no distingue entre
  // el campo vacio, un valor mal pegado, y el caso mas comun de todos — haber
  // guardado sin publicar, porque aqui se lee la version publicada.
  if (!enStrapi) {
    if (bruto == null || String(bruto).trim() === '') {
      const borrador = await leerBorrador(documentId, campo);
      if (borrador) {
        strapi.log.error(
          `[planes] la membresía ${documentId} tiene ${campo} en el BORRADOR pero no en la version publicada: falta darle a Publish`
        );
      } else {
        strapi.log.error(`[planes] la membresía ${documentId} no tiene ${campo}`);
      }
    } else {
      strapi.log.error(
        `[planes] ${campo} de la membresía ${documentId} no parece un price id de Stripe: "${String(bruto).slice(0, 40)}" (debe empezar por price_)`
      );
    }
  }

  return {
    documentId: String(fila.documentId),
    name: String(fila.name ?? '').trim(),
    precio: Number(tipo === 'familiar' ? fila.priceF : fila.priceP) || null,
    priceId: priceIdDeDesarrollo(tipo) ?? enStrapi,
  };
}

/** Solo para el diagnostico de arriba: dice si el valor existe sin publicar. */
async function leerBorrador(documentId: string, campo: string): Promise<string | null> {
  try {
    const fila = await strapi.documents(MEMBERSHIP_UID).findOne({
      documentId,
      status: 'draft',
    });
    return limpiarPriceId((fila as any)?.[campo]);
  } catch {
    return null;
  }
}

/**
 * Traduce un price id de Stripe al tipo de plan que representa.
 *
 * Se consulta el catalogo en vez de fiarse de la metadata de la suscripcion: si
 * el usuario se cambia de plan desde el Customer Portal, Stripe cambia el
 * precio del item pero **deja la metadata como estaba**. Derivarlo del precio
 * real se autocorrige; la metadata se quedaria mintiendo para siempre.
 */
export async function tipoPorPriceId(priceId: string): Promise<Tipo | null> {
  const limpio = limpiarPriceId(priceId);
  if (!limpio) return null;

  // Envuelto a proposito: esta funcion la llama el webhook de suscripciones, y
  // el tier es un extra. Si el catalogo no esta configurado —o los campos de
  // price id aun no existen en el content type— se devuelve null y el resto de
  // la sincronizacion sigue su curso. Nunca al reves.
  let filas: any[];
  try {
    filas = await strapi.documents(MEMBERSHIP_UID).findMany({
      status: 'published',
      limit: 100,
    });
  } catch (error) {
    strapi.log.warn(`[planes] no se pudo leer el catálogo para resolver ${limpio}`);
    return null;
  }

  for (const fila of filas as any[]) {
    if (limpiarPriceId(fila.stripePriceIdP) === limpio) return 'personal';
    if (limpiarPriceId(fila.stripePriceIdF) === limpio) return 'familiar';
  }
  return null;
}
