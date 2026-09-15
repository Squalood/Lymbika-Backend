/**
 * Prueba el webhook de Stripe sin el Stripe CLI.
 *
 * La firma de Stripe es un HMAC-SHA256 del cuerpo con el STRIPE_WEBHOOK_SECRET,
 * y el SDK trae `generateTestHeaderString` justo para fabricarla. Así podemos
 * mandarle eventos firmados de verdad a un Strapi local sin tocar la cuenta.
 *
 * Uso:
 *   node scripts/probar-webhook.js                 # casos que no tocan órdenes
 *   node scripts/probar-webhook.js cs_test_abc123  # además, el ciclo completo
 *                                                  # sobre una orden existente
 *
 * El `cs_...` sale de la columna `stripeid` de cualquier orden en el admin.
 * Requiere que STRIPE_WEBHOOK_SECRET esté en el .env y que Strapi esté
 * corriendo. El secreto puede ser inventado (p.ej. whsec_pruebalocal): lo
 * único que importa es que el .env y este script usen el mismo.
 */

require('dotenv').config();

const stripe = require('stripe')(process.env.STRIPE_KEY || 'sk_test_placeholder');

const URL = process.env.WEBHOOK_URL || 'http://localhost:1337/api/stripe/webhook';
const SECRETO = process.env.STRIPE_WEBHOOK_SECRET;

// ── Utilidades ───────────────────────────────────────────────────────────────

let idSecuencia = 0;
const nuevoEventId = () => `evt_prueba_${Date.now()}_${++idSecuencia}`;

function construirEvento(tipo, sesion, eventId = nuevoEventId()) {
  return {
    id: eventId,
    object: 'event',
    type: tipo,
    created: Math.floor(Date.now() / 1000),
    data: { object: sesion },
  };
}

function sesionDeCompra({ id, payment_status = 'paid', amount_total = 15104, mode = 'payment' }) {
  return {
    id,
    object: 'checkout.session',
    mode,
    payment_status,
    amount_total,
    currency: 'mxn',
    customer_email: 'prueba@lymbika.com',
    client_reference_id: '1',
    metadata: { tipo: 'producto', origen: 'ecommerce' },
  };
}

async function enviar(evento, { firmaValida = true } = {}) {
  const payload = JSON.stringify(evento);

  let firma;
  if (firmaValida) {
    firma = stripe.webhooks.generateTestHeaderString({ payload, secret: SECRETO });
  } else {
    firma = 't=1,v1=0000000000000000000000000000000000000000000000000000000000000000';
  }

  const headers = { 'Content-Type': 'application/json' };
  if (firma !== null) headers['Stripe-Signature'] = firma;

  const res = await fetch(URL, { method: 'POST', headers, body: payload });
  const texto = await res.text();
  return { status: res.status, cuerpo: texto.slice(0, 160) };
}

async function enviarSinFirma(evento) {
  const res = await fetch(URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(evento),
  });
  return { status: res.status, cuerpo: (await res.text()).slice(0, 160) };
}

// ── Casos ────────────────────────────────────────────────────────────────────

let pasadas = 0;
let falladas = 0;

function comprobar(nombre, condicion, detalle) {
  if (condicion) {
    pasadas++;
    console.log(`  OK    ${nombre}`);
  } else {
    falladas++;
    console.log(`  FALLA ${nombre}`);
    console.log(`        ${detalle}`);
  }
}

async function main() {
  if (!SECRETO) {
    console.error('Falta STRIPE_WEBHOOK_SECRET en el .env. Pon cualquier valor, p.ej. whsec_pruebalocal');
    process.exit(1);
  }

  const sesionId = process.argv[2];

  console.log(`\nWebhook: ${URL}`);
  console.log(`Secreto: ${SECRETO.slice(0, 12)}...`);
  console.log(sesionId ? `Orden:   ${sesionId}\n` : '\n(sin cs_... : se omiten los casos que tocan una orden real)\n');

  // ── 1. Firma inválida ──────────────────────────────────────────────────────
  {
    const ev = construirEvento('checkout.session.completed', sesionDeCompra({ id: 'cs_falso' }));
    const r = await enviar(ev, { firmaValida: false });
    comprobar('firma inválida -> 400', r.status === 400, `dio ${r.status}: ${r.cuerpo}`);
  }

  // ── 2. Sin cabecera de firma ───────────────────────────────────────────────
  {
    const ev = construirEvento('checkout.session.completed', sesionDeCompra({ id: 'cs_falso' }));
    const r = await enviarSinFirma(ev);
    comprobar('sin firma -> 400', r.status === 400, `dio ${r.status}: ${r.cuerpo}`);
  }

  // ── 3. Evento fuera de la allowlist ────────────────────────────────────────
  {
    const ev = construirEvento('payment_intent.created', { id: 'pi_prueba' });
    const r = await enviar(ev);
    comprobar(
      'evento desconocido -> 200 ignorado',
      r.status === 200 && r.cuerpo.includes('ignored'),
      `dio ${r.status}: ${r.cuerpo}`
    );
  }

  // ── 4. Suscripción: el handler de órdenes no debe tocarla ──────────────────
  {
    const ev = construirEvento(
      'checkout.session.completed',
      sesionDeCompra({ id: 'cs_suscripcion', mode: 'subscription' })
    );
    const r = await enviar(ev);
    comprobar('mode=subscription -> 200 (lo ignora órdenes)', r.status === 200, `dio ${r.status}: ${r.cuerpo}`);
  }

  if (!sesionId) {
    resumen();
    return;
  }

  // ── 5. payment_status distinto de paid -> NO marca pagada ──────────────────
  {
    const ev = construirEvento(
      'checkout.session.completed',
      sesionDeCompra({ id: sesionId, payment_status: 'unpaid' })
    );
    const r = await enviar(ev);
    comprobar('payment_status=unpaid -> 200 sin marcar paid', r.status === 200, `dio ${r.status}: ${r.cuerpo}`);
    console.log('        (verifica en el admin que la orden sigue en pending)');
  }

  // ── 6. Pago confirmado -> paid ─────────────────────────────────────────────
  const idPago = nuevoEventId();
  {
    const ev = construirEvento('checkout.session.completed', sesionDeCompra({ id: sesionId }), idPago);
    const r = await enviar(ev);
    comprobar('completed+paid -> 200', r.status === 200, `dio ${r.status}: ${r.cuerpo}`);
    console.log('        (verifica en el admin que la orden aparece PAID en el LISTADO)');
  }

  // ── 7. El mismo evento otra vez -> duplicado ───────────────────────────────
  {
    const ev = construirEvento('checkout.session.completed', sesionDeCompra({ id: sesionId }), idPago);
    const r = await enviar(ev);
    comprobar(
      'evento repetido -> 200 duplicate',
      r.status === 200 && r.cuerpo.includes('duplicate'),
      `dio ${r.status}: ${r.cuerpo}`
    );
    console.log('        (verifica que en Stripe Event hay UNA sola fila con ese eventId)');
  }

  // ── 8. Expirado sobre una orden ya pagada -> no degrada ────────────────────
  {
    const ev = construirEvento('checkout.session.expired', sesionDeCompra({ id: sesionId }));
    const r = await enviar(ev);
    comprobar('expired sobre orden paid -> 200', r.status === 200, `dio ${r.status}: ${r.cuerpo}`);
    console.log('        (verifica en el admin que la orden SIGUE en paid)');
  }

  resumen();
}

function resumen() {
  console.log(`\n${pasadas} pasadas, ${falladas} falladas\n`);
  if (falladas > 0) process.exit(1);
}

main().catch((e) => {
  console.error('\nError ejecutando las pruebas:', e.message);
  console.error('¿Está Strapi corriendo en ' + URL + '?');
  process.exit(1);
});
