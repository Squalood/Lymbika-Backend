/**
 * review controller
 */

import { factories } from '@strapi/strapi'

export default factories.createCoreController("api::review.review", ({ strapi }) => ({
  async create(ctx) {
    const user = ctx.state.user;

    if (!user) {
      return ctx.unauthorized("No puedes crear una reseña sin estar logueado.");
    }

    const { data } = ctx.request.body;

    const response = await strapi.entityService.create("api::review.review", {
      data: {
        ...data,
        user: user.id, // Asignar manualmente
      },
    });

    return response;
  },
}));

