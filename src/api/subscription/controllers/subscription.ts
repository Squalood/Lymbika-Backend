'use strict';

//@ts-ignore
const stripe = require('stripe')(process.env.STRIPE_KEY);

// ── Configuración ────────────────────────────────────────────────────────────

/**
 * A donde vuelve el usuario al cerrar el portal de Stripe.
 *
 * El `?portal=1` NO es decorativo: es lo que le dice al frontend que acaba de
 * volver de administrar su suscripcion, para que espere al webhook en vez de
 * pintarle el estado viejo. Ver `portal-return-sync.tsx`.
 */
const RETORNO = `${process.env.CLIENT_URL}/dashboard/summaries?portal=1`;

// ── Controller ───────────────────────────────────────────────────────────────

export default {
  // POST /api/subscription/portal
  /**
   * Abre una sesion firmada del Customer Portal de Stripe.
   *
   * Reemplaza al link generico que estaba escrito a mano en el frontend, que
   * le pedia el correo al usuario y le mandaba un codigo. Aqui el customer sale
   * del token, asi que el usuario entra directo a lo suyo y no puede abrir lo
   * de otro.
   */
  async portal(ctx: any) {
    const user = ctx.state.user;
    if (!user) {
      return ctx.unauthorized('Debes iniciar sesión para administrar tu suscripción.');
    }

    const customerId = user.stripeCustomerId;

    // Sin customer hay dos historias muy distintas detras, y el usuario merece
    // saber cual es la suya. Ojo: un miembro de cortesia que SI tiene customer
    // (pago antes y luego se le dio la cortesia) entra al portal con
    // normalidad — el corte solo aplica cuando no hay nada que abrir.
    if (!customerId) {
      if (user.membershipManual === true) {
        return ctx.forbidden(
          'Tu membresía la activó el equipo de Lymbika: no hay una suscripción de Stripe que administrar.',
          { code: 'membresia_manual' }
        );
      }
      return ctx.notFound('No encontramos una suscripción ligada a tu cuenta.', {
        code: 'sin_suscripcion',
      });
    }

    try {
      const sesion = await stripe.billingPortal.sessions.create({
        customer: customerId,
        return_url: RETORNO,
      });

      return { url: sesion.url };
    } catch (error) {
      // El fallo mas comun aqui es que el Customer Portal no este configurado
      // en el Dashboard ("No configuration provided"), y es por modo: hay que
      // activarlo en test y en produccion por separado.
      strapi.log.error(
        `[subscription.portal] fallo al abrir el portal del usuario ${user.id}`,
        error
      );
      return ctx.internalServerError('No se pudo abrir la administración de tu suscripción.');
    }
  },
};
