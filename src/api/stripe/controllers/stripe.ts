'use strict';

import { manejarOrden, EVENTOS_DE_ORDEN } from '../handlers/orders';
import { manejarSuscripcion, EVENTOS_DE_SUSCRIPCION } from '../handlers/subscriptions';
import type { Resultado } from '../handlers/orders';

//@ts-ignore
const stripe = require('stripe')(process.env.STRIPE_KEY);

// ── Configuración ────────────────────────────────────────────────────────────

const CUERPO_CRUDO = Symbol.for('unparsedBody');

// `as any` a proposito: los tipos de Strapi se generan a partir de los content
// types existentes, y este se crea desde el Content-Type Builder. Sin el cast,
// `strapi develop` no arranca hasta que exista — y hace falta que arranque
// justo para poder crearlo. Se puede quitar cuando los tipos se regeneren.
const EVENTO_UID = 'api::stripe-event.stripe-event' as any;

/**
 * Solo estos eventos tocan la base. Cualquier otro se responde 200 y se tira.
 *
 * Cuando se activen OXXO o SPEI hay que añadir aquí (y en el Dashboard)
 * `checkout.session.async_payment_succeeded` y `async_payment_failed`, o esas
 * órdenes se quedarán en `pending` para siempre: con esos métodos el evento
 * `completed` llega cuando el cliente imprime el voucher, no cuando paga.
 */
const EVENTOS = new Set<string>([...EVENTOS_DE_ORDEN, ...EVENTOS_DE_SUSCRIPCION]);

// ── Idempotencia ─────────────────────────────────────────────────────────────

/**
 * Devuelve el documentId de la fila de control, o null si el evento ya está
 * resuelto. El índice único de `eventId` es el candado real: si dos entregas
 * de Stripe llegan a la vez, una de las dos creaciones revienta y se descarta.
 */
async function reservar(evento: any): Promise<string | null> {
  const previos = await strapi.documents(EVENTO_UID).findMany({
    filters: { eventId: evento.id },
    fields: ['estado'],
    limit: 1,
  });

  if (previos.length > 0) {
    const previo = previos[0];
    if (previo.estado === 'procesado' || previo.estado === 'ignorado') {
      strapi.log.info(`[stripe.webhook] ${evento.id}: reintento de un evento ya resuelto`);
      return null;
    }
    // 'recibido' o 'fallido': el proceso anterior se interrumpió. Se reintenta
    // sobre la misma fila; las escrituras del handler son idempotentes.
    return previo.documentId;
  }

  try {
    const fila = await strapi.documents(EVENTO_UID).create({
      data: {
        eventId: evento.id,
        tipo: evento.type,
        estado: 'recibido',
        objetoId: evento.data?.object?.id ?? null,
      },
    });
    return fila.documentId;
  } catch {
    // Único motivo realista: una entrega simultánea ya insertó este eventId.
    strapi.log.info(`[stripe.webhook] ${evento.id}: entrega simultánea, se descarta`);
    return null;
  }
}

async function cerrar(documentId: string, estado: string, detalle: string) {
  await strapi.documents(EVENTO_UID).update({
    documentId,
    data: { estado, detalle: detalle.slice(0, 500) } as any,
  });
}

// ── Controller ───────────────────────────────────────────────────────────────

export default {
  // POST /api/stripe/webhook  — público: la firma HMAC es la autenticación.
  async webhook(ctx: any) {
    const secreto = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secreto) {
      // Nunca se procesa nada sin poder verificar. Fallar cerrado.
      strapi.log.error('[stripe.webhook] falta STRIPE_WEBHOOK_SECRET');
      return ctx.internalServerError('Webhook no configurado.');
    }

    const firma = ctx.request.headers['stripe-signature'];
    const crudo = ctx.request.body?.[CUERPO_CRUDO];

    if (!firma || typeof crudo !== 'string') {
      strapi.log.warn('[stripe.webhook] petición sin firma o sin cuerpo crudo');
      return ctx.badRequest('Firma ausente.');
    }

    let evento: any;
    try {
      evento = stripe.webhooks.constructEvent(crudo, firma, secreto);
    } catch (error: any) {
      strapi.log.warn(`[stripe.webhook] firma inválida: ${error.message}`);
      return ctx.badRequest('Firma inválida.');
    }

    // ── A partir de aquí el evento es auténtico y la respuesta es 200 pase lo
    // que pase. Un 5xx haría que Stripe reintente tres días por algo que un
    // reintento no arregla; lo que falle queda en el log y en stripe-events.

    if (!EVENTOS.has(evento.type)) {
      strapi.log.info(`[stripe.webhook] ${evento.id} ${evento.type}: fuera de la allowlist`);
      ctx.status = 200;
      return { received: true, ignored: true };
    }

    const fila = await reservar(evento);
    if (!fila) {
      ctx.status = 200;
      return { received: true, duplicate: true };
    }

    try {
      const { estado, detalle }: Resultado = await despachar(evento);
      await cerrar(fila, estado, detalle);
      strapi.log.info(`[stripe.webhook] ${evento.id} ${evento.type}: ${estado} — ${detalle}`);
    } catch (error: any) {
      strapi.log.error(`[stripe.webhook] ${evento.id} ${evento.type}: fallo al procesar`, error);
      await cerrar(fila, 'fallido', String(error?.message ?? error)).catch(() => {});
    }

    ctx.status = 200;
    return { received: true };
  },
};

// ── Despacho ─────────────────────────────────────────────────────────────────

/**
 * Un dominio por handler, para que el de suscripciones y el de órdenes no se
 * toquen entre sí.
 *
 * El único evento compartido es `checkout.session.completed`: lo generan las
 * compras (`mode: 'payment'`) y las suscripciones (`mode: 'subscription'`).
 * Aquí se decide por `mode`, y además cada handler vuelve a comprobarlo por su
 * cuenta — así ninguno procesa lo que no es suyo si se le llama por error.
 */
async function despachar(evento: any): Promise<Resultado> {
  if (evento.type === 'checkout.session.completed') {
    const modo = evento.data?.object?.mode;
    return modo === 'subscription' ? manejarSuscripcion(evento) : manejarOrden(evento);
  }

  if (EVENTOS_DE_SUSCRIPCION.has(evento.type)) {
    return manejarSuscripcion(evento);
  }
  if (EVENTOS_DE_ORDEN.has(evento.type)) {
    return manejarOrden(evento);
  }
  return { estado: 'ignorado', detalle: `sin handler para ${evento.type}` };
}
