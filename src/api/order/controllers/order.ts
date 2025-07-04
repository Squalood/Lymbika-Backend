"use strict";

import Stripe from "stripe";

//@ts-ignore
const stripe = require("stripe")(process.env.STRIPE_KEY);

const { createCoreController } = require("@strapi/strapi").factories;

module.exports = createCoreController("api::order.order", ({ strapi }) => ({
    async create(ctx) {
        //@ts-ignore
        const { products, isDelivery, userEmail, deliveryCost } = ctx.request.body;

        try {
            const lineItems = await Promise.all(
                products.map(async (product) => {
                    const item = await strapi.entityService.findOne("api::product.product", product.id);

                    return {
                        price_data: {
                            currency: "MXN",
                            product_data: {
                                name: item.productName,
                            },
                            unit_amount: Math.round(product.price * 100), // El precio ya viene calculado desde el cliente
                        },
                        quantity: product.quantity, // Ahora usamos la cantidad correcta
                    };
                })
            );

            const sessionConfig: Stripe.Checkout.SessionCreateParams = {
                payment_method_types: ["card"],
                mode: "payment",
                success_url: process.env.CLIENT_URL + "/success",
                cancel_url: process.env.CLIENT_URL + "/cart",
                line_items: lineItems,
            };

            if (isDelivery) {
                sessionConfig.shipping_address_collection = { allowed_countries: ["MX"] };
            }

            if (!userEmail) {
                return ctx.badRequest("E-mail is required");
            }

            if (deliveryCost && deliveryCost > 0) {
            lineItems.push({
                price_data: {
                currency: "MXN",
                product_data: {
                    name: "Costo de envío",
                },
                unit_amount: Math.round(deliveryCost * 100),
                },
                quantity: 1,
            });
            }

            const session = await stripe.checkout.sessions.create(sessionConfig);

            await strapi.service("api::order.order").create({
                data: {
                    products,
                    stripeid: session.id,
                    isDelivery,
                    userEmail, // Aquí ya funciona bien, era solo un tema de cómo lo estabas pasando.
                },
            });

            return { stripeSession: session };
        } catch (error) {
            ctx.response.status = 500;
            return { error };
        }
    },
}));