'use strict';

import type Stripe from 'stripe';
import { buscarPlan, TIPOS, type Tipo } from '../services/planes';

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

const USER_UID = 'plugin::users-permissions.user';

/**
 * Estados en los que Stripe todavia tiene una suscripcion viva: abrir un
 * segundo checkout crearia un segundo cobro.
 *
 * `incomplete` NO esta aqui a proposito. Es la suscripcion cuyo primer pago no
 * cuajo; Stripe la deja morir sola a las 23 horas y nunca cobra. Bloquear por
 * ella dejaria al usuario sin poder reintentar durante casi un dia.
 */
const VIGENTES = new Set(['trialing', 'active', 'past_due', 'unpaid', 'paused']);

// ── Controller ───────────────────────────────────────────────────────────────

export default {
  // POST /api/subscription/checkout
  /**
   * Crea la sesion de pago de una suscripcion.
   *
   * Reemplaza a los Payment Links que un admin pegaba en Strapi. La diferencia
   * que importa: aqui el precio y la identidad los pone el servidor, y se
   * puede impedir que alguien contrate dos veces.
   */
  async checkout(ctx: any) {
    const user = ctx.state.user;
    if (!user) {
      return ctx.unauthorized('Debes iniciar sesión para suscribirte.');
    }

    // ── 1. Validacion del body ───────────────────────────────────────────────
    // Solo cruzan el id del plan y el tipo. Ni price id, ni URL, ni email: el
    // cliente no elige lo que se le cobra.
    const { membershipId, tipo } = (ctx.request.body ?? {}) as {
      membershipId?: unknown;
      tipo?: unknown;
    };

    const id = Number(membershipId);
    if (!Number.isInteger(id) || id <= 0) {
      return ctx.badRequest('Ese plan no está disponible.');
    }
    if (typeof tipo !== 'string' || !TIPOS.has(tipo)) {
      return ctx.badRequest('Tipo de plan inválido.');
    }

    // ── 2. Candado contra la doble suscripcion ───────────────────────────────
    if (VIGENTES.has(String(user.subscriptionStatus))) {
      return ctx.badRequest(
        'Ya tienes una suscripción activa. Puedes administrarla desde tu cuenta.',
        { code: 'suscripcion_activa' }
      );
    }

    try {
      // ── 3. El plan, desde Strapi ───────────────────────────────────────────
      const plan = await buscarPlan(id, tipo as Tipo);
      if (!plan) {
        return ctx.badRequest('Ese plan ya no está disponible.');
      }
      if (!plan.priceId) {
        // Fallo de configuracion, no del usuario: el admin no pego el price id.
        strapi.log.error(
          `[subscription.checkout] la membresía ${id} no tiene price id para el plan ${tipo}`
        );
        return ctx.badRequest('Ese plan todavía no se puede contratar en línea.', {
          code: 'plan_sin_precio',
        });
      }

      // ── 4. El customer, persistido ANTES de la sesion ──────────────────────
      // Si la sesion fallara despues, el siguiente intento reutiliza este
      // customer en vez de crear otro. Y el Customer Portal necesita que
      // exista: sin esto, el usuario no podria administrar nada hasta que
      // llegue el webhook.
      let customerId: string = user.stripeCustomerId ?? '';

      if (!customerId) {
        const nombre = [user.firstName, user.lastName].filter(Boolean).join(' ');
        const customer = await stripe.customers.create({
          email: user.email,
          name: nombre || user.username,
          metadata: { strapiUserId: String(user.id) },
        });
        customerId = customer.id;

        try {
          await strapi.documents(USER_UID).update({
            documentId: user.documentId,
            data: { stripeCustomerId: customerId } as any,
          });
        } catch (error) {
          strapi.log.error(
            `[subscription.checkout] el customer ${customerId} quedó huérfano: no se pudo guardar en el usuario ${user.id}`,
            error
          );
          return ctx.internalServerError('No se pudo iniciar la suscripción. Intenta de nuevo.');
        }
      }

      // ── 5. La sesion ───────────────────────────────────────────────────────
      const sessionConfig: Stripe.Checkout.SessionCreateParams = {
        mode: 'subscription',
        line_items: [{ price: plan.priceId, quantity: 1 }],
        // `customer` y `customer_email` son excluyentes. Con `customer` Stripe
        // no crea uno nuevo por sesion, que es lo que pasaba con los Payment
        // Links: quien se suscribia dos veces acababa con customers duplicados
        // y el portal solo veia uno.
        customer: customerId,
        // Lo unico que el webhook usa para saber de quien es el pago.
        client_reference_id: String(user.id),
        metadata: { tipo: 'suscripcion', origen: 'ecommerce', plan: tipo },
        // Esta metadata viaja al objeto Subscription, asi que aparece en todos
        // los customer.subscription.* y no solo en la sesion.
        subscription_data: {
          metadata: { strapiUserId: String(user.id), tier: tipo, membershipId: String(plan.id) },
        },
        // NO puede ser /success: esa pagina vacía el carrito y busca una orden
        // por session_id, que para una suscripción no existe.
        success_url: `${process.env.CLIENT_URL}/dashboard/summaries?suscripcion=activada`,
        cancel_url: `${process.env.CLIENT_URL}/membership`,
      };

      const session = await stripe.checkout.sessions.create(sessionConfig);

      strapi.log.info(
        `[subscription.checkout] usuario ${user.id} → ${session.id} (${tipo}, ${plan.priceId})`
      );
      return { url: session.url, id: session.id };
    } catch (error) {
      strapi.log.error(
        `[subscription.checkout] fallo al crear la sesión del usuario ${user.id}`,
        error
      );
      return ctx.internalServerError('No se pudo iniciar la suscripción. Intenta de nuevo.');
    }
  },

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
