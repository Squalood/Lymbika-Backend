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
                products.map(async (item) => {
                    // Detectar si es producto o servicio
                    const isProduct = item.type === "product";
                    
                    let itemData;
                    
                    if (isProduct) {
                        // Buscar producto
                        itemData = await strapi.entityService.findOne(
                            "api::product.product", 
                            item.id
                        );
                        
                        return {
                            price_data: {
                                currency: "MXN",
                                product_data: {
                                    name: itemData.productName,
                                },
                                unit_amount: Math.round(item.price * 100),
                            },
                            quantity: item.quantity,
                        };
                    } else {
                        // Buscar servicio de clínica
                        const clinics = await strapi.entityService.findMany(
                            "api::clinic.clinic",
                            {
                                populate: {
                                    services: {
                                        populate: ['image']
                                    },
                                },
                            }
                        );
                        
                        // Encontrar el servicio específico en todas las clínicas
                        let serviceData = null;
                        if (clinics && clinics.length > 0) {
                            for (const clinic of clinics) {
                                if (clinic.services) {
                                    const found = clinic.services.find(
                                        (service) => service.id === item.id
                                    );
                                    if (found) {
                                        serviceData = found;
                                        break;
                                    }
                                }
                            }
                        }
                        
                        return {
                            price_data: {
                                currency: "MXN",
                                product_data: {
                                    name: serviceData?.title || item.name,
                                    description: serviceData?.description || undefined,
                                },
                                unit_amount: Math.round(item.price * 100),
                            },
                            quantity: 1, // Servicios siempre tienen cantidad 1
                        };
                    }
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
                    userEmail,
                },
            });

            return { stripeSession: session };
        } catch (error) {
            ctx.response.status = 500;
            return { error };
        }
    },
}));