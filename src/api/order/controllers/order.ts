"use strict";

import Stripe from "stripe";

//@ts-ignore
const stripe = require("stripe")(process.env.STRIPE_KEY);

/**
 * Order Controller
 */
const { createCoreController } = require("@strapi/strapi").factories;

module.exports = createCoreController("api::order.order", ({ strapi }) => ({
    async create(ctx) {
        //@ts-ignore
        const { products, mediClubRegular, isDelivery, userEmail } = ctx.request.body;

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
                            unit_amount: Math.round((mediClubRegular && item.priceMember > 0 ? item.priceMember : item.price) * 100),
                        },
                        quantity: 1,
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

            const session = await stripe.checkout.sessions.create(sessionConfig)

            await strapi.service("api::order.order").create({
                data: { products, stripeid: session.id, isDelivery, userEmail, }, //error: No value exists in scope for the shorthand property 'userEmail'. Either declare one or provide an initializer.
            });

            return { stripeSession: session };
        } catch (error) {
            ctx.response.status = 500;
            return { error };
        }
    },
}));