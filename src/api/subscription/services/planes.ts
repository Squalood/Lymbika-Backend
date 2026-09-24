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
  id: number;
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
 * `status: 'published'` es obligatorio: el Document Service de v5 devuelve el
 * borrador por omision, y no se cobra por un plan sin publicar.
 */
export async function buscarPlan(membershipId: number, tipo: Tipo): Promise<Plan | null> {
  let filas: any[];
  try {
    filas = await strapi.documents(MEMBERSHIP_UID).findMany({
      filters: { id: membershipId } as any,
      status: 'published',
      limit: 1,
    });
  } catch (error) {
    strapi.log.error(`[planes] no se pudo leer la membresía ${membershipId}`, error);
    return null;
  }

  const fila = filas[0] as any;
  if (!fila) return null;

  const enStrapi = limpiarPriceId(
    tipo === 'familiar' ? fila.stripePriceIdF : fila.stripePriceIdP
  );

  return {
    id: Number(fila.id),
    name: String(fila.name ?? '').trim(),
    precio: Number(tipo === 'familiar' ? fila.priceF : fila.priceP) || null,
    priceId: priceIdDeDesarrollo(tipo) ?? enStrapi,
  };
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
