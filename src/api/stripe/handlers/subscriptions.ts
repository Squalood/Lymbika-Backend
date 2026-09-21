'use strict';

import { derivarMembresia } from '../services/membership';
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
    // La suscripción borrada ya no se puede releer con estado útil.
    sub = { id: objeto.id, status: 'canceled', cancel_at_period_end: false };
  } else {
    sub = await stripe.subscriptions.retrieve(objeto.id);
  }

  const detalle = await sincronizar(usuario, sub, customerId);
  return { estado: 'procesado', detalle };
}
