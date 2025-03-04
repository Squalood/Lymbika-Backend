"use strict";

//@ts-ignore
const stripe = require("stripe")(process.env.STRIPE_KEY);

/**
 * Order Controller
 */
const { createCoreController } = require("@strapi/strapi").factories;

module.exports = createCoreController("api::order.order", ({ strapi }) => ({
    async create(ctx) {
        //@ts-ignore
        const { products } = ctx.request.body;

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
                            unit_amount: Math.round(item.price * 100),
                        },
                        quantity: 1,
                    };
                })
            );

            const session = await stripe.checkout.sessions.create({
                shipping_address_collection: { allowed_countries: ["MX"] }, 
                payment_method_types: ["card"],
                mode: "payment",
                success_url: process.env.CLIENT_URL + "/success", 
                cancel_url: process.env.CLIENT_URL + "/successError",
                line_items: lineItems,
            });

            await strapi.service("api::order.order").create({
                data: { products, stripeid: session.id },
            });

            return { stripeSession: session };
        } catch (error) {
            ctx.response.status = 500;
            return { error };
        }
    },
}));
