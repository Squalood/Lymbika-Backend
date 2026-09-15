'use strict';

//@ts-ignore
const stripe = require('stripe')(process.env.STRIPE_KEY);

// ── Configuración ────────────────────────────────────────────────────────────

const ORDEN_UID = 'api::order.order';

export type Resultado = {
  estado: 'procesado' | 'ignorado';
  detalle: string;
};

export const EVENTOS_DE_ORDEN = new Set<string>([
  'checkout.session.completed',
  'checkout.session.expired',
]);

/**
 * `paid` solo cuando el dinero está de verdad.
 *
 * Hoy la cuenta solo tiene tarjeta activa, así que `completed` siempre llega
 * con payment_status 'paid'. El guardia cuesta una línea y es lo que evita
 * marcar como pagadas órdenes de OXXO/SPEI el día que se activen: con esos
 * métodos `completed` llega en cuanto el cliente imprime el voucher. Ante la
 * duda, la orden se queda en `pending`, que es el lado seguro del error.
 */
function estadoDestino(tipo: string, sesion: any): 'paid' | 'failed' | null {
  switch (tipo) {
    case 'checkout.session.completed':
      return ['paid', 'no_payment_required'].includes(sesion.payment_status) ? 'paid' : null;
    case 'checkout.session.expired':
      return 'failed';
    default:
      return null;
  }
}

// ── Handler ──────────────────────────────────────────────────────────────────

export async function manejarOrden(evento: any): Promise<Resultado> {
  const sesion = evento.data.object;

  // ── 1. ¿Es una compra de productos? ────────────────────────────────────────
  // Doble filtro a propósito. `mode` funciona incluso para las sesiones que ya
  // estaban abiertas antes de que order.ts empezara a mandar metadata, así que
  // la ausencia de metadata NO descarta: se trata como compra.
  if (sesion.mode !== 'payment') {
    return { estado: 'ignorado', detalle: `mode=${sesion.mode}` };
  }
  const tipo = sesion.metadata?.tipo;
  if (tipo && tipo !== 'producto') {
    return { estado: 'ignorado', detalle: `metadata.tipo=${tipo}` };
  }

  const destino = estadoDestino(evento.type, sesion);
  if (!destino) {
    return { estado: 'ignorado', detalle: `payment_status=${sesion.payment_status}` };
  }

  // ── 2. La orden ────────────────────────────────────────────────────────────
  // Se busca el BORRADOR: en Strapi v5 siempre existe, incluso en las órdenes
  // anteriores al commit que las hizo nacer publicadas. Buscar el publicado
  // dejaría esas fuera.
  const ordenes = await strapi.documents(ORDEN_UID).findMany({
    filters: { stripeid: sesion.id },
    fields: ['estado', 'total'],
    status: 'draft',
    limit: 2,
  });

  if (ordenes.length === 0) {
    return recuperarOrden(sesion, destino);
  }
  if (ordenes.length > 1) {
    strapi.log.warn(`[stripe.webhook] hay más de una orden con stripeid ${sesion.id}`);
  }

  const orden = ordenes[0];

  // ── 3. Transiciones ────────────────────────────────────────────────────────
  // `paid` es terminal: un `expired` que llegue tarde o desordenado no degrada
  // una orden ya cobrada.
  if (orden.estado === 'paid' && destino !== 'paid') {
    return { estado: 'ignorado', detalle: `ya está paid; no se degrada a ${destino}` };
  }
  if (orden.estado === destino) {
    return { estado: 'ignorado', detalle: `ya estaba en ${destino}` };
  }

  const aviso = destino === 'paid' ? verificarImporte(orden, sesion) : null;

  await strapi.documents(ORDEN_UID).update({
    documentId: orden.documentId,
    data: { estado: destino },
    // Sin esto solo se actualiza el borrador, y la fila publicada —la que ve el
    // admin y la que devuelve la API— se queda en `pending` para siempre.
    status: 'published',
  });

  return {
    estado: 'procesado',
    detalle: `orden ${orden.documentId}: ${orden.estado} → ${destino}${aviso ? ` | ${aviso}` : ''}`,
  };
}

// ── Verificación de importe ──────────────────────────────────────────────────

/**
 * El total de la orden se calculó con los mismos precios que los line_items,
 * así que una divergencia es un bug nuestro, no un fraude. Nunca bloquea el
 * `paid`: Stripe ya tiene el dinero y la orden debe reflejar la realidad.
 */
function verificarImporte(orden: any, sesion: any): string | null {
  // `total` es decimal: Postgres lo devuelve como string, sqlite como número.
  const esperado = Math.round(Number(orden.total) * 100);
  const cobrado = Number(sesion.amount_total);
  const moneda = String(sesion.currency ?? '').toLowerCase();

  if (!Number.isFinite(esperado) || !Number.isFinite(cobrado)) return null;
  if (Math.abs(esperado - cobrado) <= 1 && moneda === 'mxn') return null;

  const aviso = `IMPORTE DIVERGENTE: orden ${esperado} mxn vs stripe ${cobrado} ${moneda}`;
  strapi.log.error(`[stripe.webhook] ${sesion.id} ${aviso}`);
  return aviso;
}

// ── Orden ausente ────────────────────────────────────────────────────────────

/**
 * La orden se escribe al iniciar el checkout dentro de un try/catch que solo
 * loguea, así que puede no existir. No es una carrera —se escribe antes de
 * devolverle la URL al navegador—, así que reintentar no ayudaría: se
 * reconstruye desde Stripe, que es la fuente de verdad del dinero.
 */
async function recuperarOrden(sesion: any, destino: string): Promise<Resultado> {
  if (destino !== 'paid') {
    return { estado: 'ignorado', detalle: `sin orden para ${sesion.id}, y no está pagada` };
  }

  const items = await stripe.checkout.sessions.listLineItems(sesion.id, { limit: 100 });
  const productos = items.data.map((li: any) => ({
    // No se puede mapear de vuelta al producto de Strapi con fiabilidad: en la
    // sesión solo queda el nombre, no el id.
    id: null,
    name: li.description,
    quantity: li.quantity,
    unit_amount: li.price?.unit_amount ?? null,
  }));

  const userId = Number(sesion.client_reference_id);
  const envio = sesion.collected_information?.shipping_details ?? sesion.shipping_details ?? null;

  await strapi.documents(ORDEN_UID).create({
    data: {
      stripeid: sesion.id,
      products: productos,
      isDelivery: Boolean(envio),
      userEmail: sesion.customer_details?.email ?? sesion.customer_email ?? null,
      user: Number.isInteger(userId) && userId > 0 ? userId : null,
      total: Number(sesion.amount_total) / 100,
      estado: 'paid',
    },
    status: 'published',
  });

  strapi.log.error(
    `[stripe.webhook] no existía orden para ${sesion.id}: reconstruida desde Stripe`
  );
  return { estado: 'procesado', detalle: 'orden ausente, reconstruida desde Stripe' };
}
