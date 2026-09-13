"use strict";

import type Stripe from "stripe";

//@ts-ignore
const stripe = require("stripe")(process.env.STRIPE_KEY);

const { createCoreController } = require("@strapi/strapi").factories;

// ── Configuración ────────────────────────────────────────────────────────────

const MONEDA = "mxn";
const MAX_ITEMS_POR_CARRITO = 50;
// Espeja el tope por artículo del carrito (frontend: hooks/use-cart.tsx).
const MAX_UNIDADES_POR_ITEM = 3;
const COSTO_ENVIO_MXN = Number(process.env.DELIVERY_COST_MXN ?? 200);

type ItemNormalizado = { id: number; quantity: number };

// ── Validación del carrito ───────────────────────────────────────────────────

/**
 * Deja pasar únicamente { id, quantity }. Todo lo demás que venga en el body
 * —precio, nombre, email, mediClubRegular— se descarta: el precio y la
 * identidad los resuelve el servidor, nunca el cliente.
 */
function normalizarItems(
  items: unknown
): { error: string } | { items: ItemNormalizado[] } {
  if (!Array.isArray(items) || items.length === 0) {
    return { error: "El carrito está vacío." };
  }
  if (items.length > MAX_ITEMS_POR_CARRITO) {
    return { error: "Demasiados artículos en el carrito." };
  }

  const normalizados: ItemNormalizado[] = [];

  for (const item of items) {
    const id = Number((item as any)?.id);
    const quantity = Number((item as any)?.quantity);

    if (!Number.isInteger(id) || id <= 0) {
      return { error: "Hay un artículo inválido en el carrito." };
    }
    if (
      !Number.isInteger(quantity) ||
      quantity < 1 ||
      quantity > MAX_UNIDADES_POR_ITEM
    ) {
      return { error: `Cantidad inválida para el artículo ${id}.` };
    }

    normalizados.push({ id, quantity });
  }

  if (new Set(normalizados.map((i) => i.id)).size !== normalizados.length) {
    return { error: "Hay artículos duplicados en el carrito." };
  }

  return { items: normalizados };
}

// ── Controller ───────────────────────────────────────────────────────────────

module.exports = createCoreController("api::order.order", ({ strapi }) => ({
  async create(ctx) {
    // ── 1. Autenticación ─────────────────────────────────────────────────────
    const user = ctx.state.user;
    if (!user) {
      return ctx.unauthorized("Debes iniciar sesión para completar la compra.");
    }

    // ── 2. Validación de forma ───────────────────────────────────────────────
    const { items, isDelivery } = (ctx.request.body ?? {}) as {
      items?: unknown;
      isDelivery?: unknown;
    };

    const normalizado = normalizarItems(items);
    if ("error" in normalizado) {
      return ctx.badRequest(normalizado.error);
    }

    const conEnvio = isDelivery === true;

    try {
      // ── 3. Precios desde Strapi (única fuente de verdad) ───────────────────
      // Una sola consulta para todo el carrito. `status: 'published'` evita
      // vender borradores: el content type product tiene draftAndPublish.
      const productos = await strapi
        .documents("api::product.product")
        .findMany({
          filters: { id: { $in: normalizado.items.map((i) => i.id) } },
          fields: [
            "id",
            "productName",
            "price",
            "priceMember",
            "active",
          ],
          status: "published",
        });

      const porId = new Map<number, any>(
        productos.map((p: any) => [Number(p.id), p])
      );

      // No se valida stock: `stock_central` es del inventario de farmacia
      // (caja-pos / inventory-lot), no de la tienda en linea. La venta online
      // no depende de el.
      // El descuento de miembro sale del usuario autenticado, nunca del body.
      const esMiembro = user.mediClubRegular === true;

      const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [];
      const resumen: {
        id: number;
        name: string;
        quantity: number;
        unit_amount: number;
      }[] = [];

      for (const { id, quantity } of normalizado.items) {
        const producto = porId.get(id);

        if (!producto) {
          return ctx.badRequest("Un producto del carrito ya no está disponible.");
        }
        if (producto.active === false) {
          return ctx.badRequest(`"${producto.productName}" no está disponible.`);
        }

        const precioMiembro = Number(producto.priceMember);
        const precioLista = Number(producto.price);
        const precio =
          esMiembro && precioMiembro > 0 ? precioMiembro : precioLista;

        if (!Number.isFinite(precio) || precio <= 0) {
          return ctx.badRequest(
            `"${producto.productName}" no tiene un precio configurado.`
          );
        }

        const unitAmount = Math.round(precio * 100);

        lineItems.push({
          price_data: {
            currency: MONEDA,
            product_data: { name: producto.productName },
            unit_amount: unitAmount,
          },
          quantity,
        });

        resumen.push({
          id,
          name: producto.productName,
          quantity,
          unit_amount: unitAmount,
        });
      }

      // ── 4. Envío, calculado en el servidor ────────────────────────────────
      if (conEnvio && COSTO_ENVIO_MXN > 0) {
        const envioUnitAmount = Math.round(COSTO_ENVIO_MXN * 100);

        lineItems.push({
          price_data: {
            currency: MONEDA,
            product_data: { name: "Costo de envío" },
            unit_amount: envioUnitAmount,
          },
          quantity: 1,
        });

        resumen.push({
          id: 0,
          name: "Costo de envío",
          quantity: 1,
          unit_amount: envioUnitAmount,
        });
      }

      const totalCentavos = resumen.reduce(
        (acc, l) => acc + l.unit_amount * l.quantity,
        0
      );

      // ── 5. Sesión de Stripe ───────────────────────────────────────────────
      // Sin `payment_method_types`: Stripe habilita los métodos activos en el
      // Dashboard (tarjeta, OXXO, SPEI) en lugar de forzar solo tarjeta.
      const sessionConfig: Stripe.Checkout.SessionCreateParams = {
        mode: "payment",
        line_items: lineItems,
        customer_email: user.email,
        client_reference_id: String(user.id),
        success_url: `${process.env.CLIENT_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.CLIENT_URL}/cart`,
      };

      if (conEnvio) {
        sessionConfig.shipping_address_collection = {
          allowed_countries: ["MX"],
        };
      }

      const session = await stripe.checkout.sessions.create(sessionConfig);

      // ── 6. Registro de la orden ───────────────────────────────────────────
      // Un fallo al persistir no debe impedir el pago: Stripe ya tiene la
      // sesión y es la fuente de verdad del dinero. Se registra el error para
      // poder reconciliar a mano.
      try {
        await strapi.documents("api::order.order").create({
          data: {
            stripeid: session.id,
            products: resumen,
            isDelivery: conEnvio,
            userEmail: user.email,
            user: user.id,
            total: totalCentavos / 100,
            estado: "pending",
          },
          // Una orden es un registro transaccional: nace publicada. Sin esto
          // Strapi v5 la deja como borrador y no aparece en los listados.
          status: "published",
        });
      } catch (error) {
        strapi.log.error(
          `[order.create] no se pudo registrar la orden de la sesión ${session.id}`,
          error
        );
      }

      return { url: session.url, id: session.id };
    } catch (error) {
      strapi.log.error("[order.create] fallo al crear la sesión de pago", error);
      return ctx.internalServerError(
        "No se pudo iniciar el pago. Intenta de nuevo."
      );
    }
  },
}));
