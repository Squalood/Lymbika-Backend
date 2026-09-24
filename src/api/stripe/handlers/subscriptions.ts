'use strict';

import { derivarMembresia } from '../services/membership';
import { tipoPorPriceId, type Tipo } from '../../subscription/services/planes';
import type { Resultado } from './orders';

//@ts-ignore
const stripe = require('stripe')(process.env.STRIPE_KEY);

// ── Configuración ────────────────────────────────────────────────────────────

const USER_UID = 'plugin::users-permissions.user';

export const EVENTOS_DE_SUSCRIPCION = new Set<string>([
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
]);

type Usuario = {
  documentId: string;
  id: number;
  email?: string;
  membershipManual?: boolean;
};

// ── Búsqueda del usuario ─────────────────────────────────────────────────────

async function porCustomerId(customerId: string): Promise<Usuario | null> {
  if (!customerId) return null;
  const users = await strapi.documents(USER_UID).findMany({
    filters: { stripeCustomerId: customerId } as any,
    limit: 1,
  });
  return (users[0] as Usuario) ?? null;
}

async function porId(userId: number): Promise<Usuario | null> {
  if (!Number.isInteger(userId) || userId <= 0) return null;
  const users = await strapi.documents(USER_UID).findMany({
    filters: { id: userId },
    limit: 1,
  });
  return (users[0] as Usuario) ?? null;
}

// ── Que plan contrato ────────────────────────────────────────────────────────

/**
 * El tier sale del precio realmente contratado, no de la metadata.
 *
 * Si el usuario se cambia de plan desde el Customer Portal, Stripe cambia el
 * precio del item pero **deja la metadata como estaba**: derivarlo del precio
 * se autocorrige, la metadata se quedaria mintiendo para siempre. La metadata
 * queda de respaldo para las suscripciones cuyo precio ya no este en el
 * catalogo (por ejemplo las que vienen de los Payment Links viejos).
 */
async function derivarTipo(sub: any): Promise<Tipo | null> {
  for (const item of sub?.items?.data ?? []) {
    const tipo = await tipoPorPriceId(String(item?.price?.id ?? ''));
    if (tipo) return tipo;
  }

  const meta = sub?.metadata?.tier;
  return meta === 'personal' || meta === 'familiar' ? meta : null;
}

// ── Escritura ────────────────────────────────────────────────────────────────

/**
 * Vuelca el estado de una suscripción de Stripe sobre el usuario.
 *
 * `membershipActive` se deriva aquí y en ningún otro sitio: es lo que lee el
 * checkout para el precio de miembro.
 */
async function sincronizar(usuario: Usuario, sub: any, customerId: string): Promise<string> {
  const status: string = sub?.status ?? 'canceled';

  const data: Record<string, unknown> = {
    stripeCustomerId: customerId,
    stripeSubscriptionId: sub?.id ?? null,
    subscriptionStatus: status,
    subscriptionCancelAtPeriodEnd: Boolean(sub?.cancel_at_period_end),
    subscriptionCurrentPeriodEnd: sub?.current_period_end
      ? new Date(sub.current_period_end * 1000)
      : null,
    membershipActive: derivarMembresia(status, usuario.membershipManual === true),
  };

  // Solo se escribe cuando se puede resolver: un evento que no trae los items
  // no debe borrar un tier que ya se conocia.
  const tipo = await derivarTipo(sub);
  if (tipo) data.subscriptionTier = tipo;

  await strapi.documents(USER_UID).update({
    documentId: usuario.documentId,
    data: data as any,
  });

  const nota = usuario.membershipManual ? ' (manual: no se degrada)' : '';
  return `usuario ${usuario.id}: ${status} → membershipActive=${data.membershipActive}${nota}`;
}

// ── Handler ──────────────────────────────────────────────────────────────────

export async function manejarSuscripcion(evento: any): Promise<Resultado> {
  // ── checkout.session.completed en modo suscripción: el que siembra ─────────
  // Es el único evento que trae `client_reference_id`, o sea la identidad del
  // usuario. Los `customer.subscription.*` solo saben del customer de Stripe.
  if (evento.type === 'checkout.session.completed') {
    const sesion = evento.data.object;
    if (sesion.mode !== 'subscription') {
      return { estado: 'ignorado', detalle: `mode=${sesion.mode}` };
    }

    const usuario = await porId(Number(sesion.client_reference_id));
    if (!usuario) {
      // Pasa si alguien paga desde un Payment Link sin pasar por el sitio.
      strapi.log.warn(
        `[stripe.webhook] suscripción sin usuario: client_reference_id=${sesion.client_reference_id}, customer=${sesion.customer}`
      );
      return {
        estado: 'ignorado',
        detalle: `sin usuario para client_reference_id=${sesion.client_reference_id}`,
      };
    }

    if (!sesion.subscription) {
      return { estado: 'ignorado', detalle: 'la sesión no trae suscripción' };
    }

    const sub = await stripe.subscriptions.retrieve(sesion.subscription);
    const detalle = await sincronizar(usuario, sub, String(sesion.customer));
    return { estado: 'procesado', detalle };
  }

  // ── customer.subscription.*: mantienen ─────────────────────────────────────
  const objeto = evento.data.object;
  const customerId = String(objeto.customer ?? '');

  const usuario = await porCustomerId(customerId);
  if (!usuario) {
    // Puede llegar ANTES que checkout.session.completed, cuando el usuario
    // todavía no tiene stripeCustomerId. No se reintenta: la sesión, que sí
    // sabe quién es, escribirá el estado completo. Se arregla solo.
    strapi.log.warn(
      `[stripe.webhook] ${evento.type}: no hay usuario con stripeCustomerId=${customerId}`
    );
    return { estado: 'ignorado', detalle: `sin usuario para customer ${customerId}` };
  }

  // Se relee de Stripe en vez de confiar en el objeto del evento: los eventos
  // no llegan ordenados, y un `updated` viejo pisaría a uno nuevo. `retrieve`
  // siempre devuelve el estado actual.
  let sub: any;
  if (evento.type === 'customer.subscription.deleted') {
    // La suscripción borrada ya no se puede releer con estado útil, pero el
    // evento sí trae los items y la metadata: se conservan para no perder el
    // tier al cancelar.
    sub = {
      id: objeto.id,
      status: 'canceled',
      cancel_at_period_end: false,
      items: objeto.items,
      metadata: objeto.metadata,
    };
  } else {
    sub = await stripe.subscriptions.retrieve(objeto.id);
  }

  const detalle = await sincronizar(usuario, sub, customerId);
  return { estado: 'procesado', detalle };
}
