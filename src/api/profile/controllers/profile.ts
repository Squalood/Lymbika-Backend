'use strict';

// ── Configuración ────────────────────────────────────────────────────────────

/**
 * Lo único que el dueño de la cuenta puede cambiar de sí mismo.
 *
 * Reemplaza al permiso `update` de users-permissions, que es todo o nada:
 * concede editar CUALQUIER usuario y CUALQUIER campo — incluido
 * `membershipActive`, con el que cualquiera podía regalarse la membresía.
 */
const CAMPOS_EDITABLES = {
  firstName: 100,
  lastName: 100,
  bio: 2000,
} as const;

type CampoEditable = keyof typeof CAMPOS_EDITABLES;

// ── Controller ───────────────────────────────────────────────────────────────

export default {
  // PUT /api/profile
  async updateMe(ctx: any) {
    const user = ctx.state.user;
    if (!user) {
      return ctx.unauthorized('Debes iniciar sesión para editar tu perfil.');
    }

    const body = (ctx.request.body ?? {}) as Record<string, unknown>;
    const data: Record<string, string> = {};

    for (const campo of Object.keys(CAMPOS_EDITABLES) as CampoEditable[]) {
      const valor = body[campo];
      if (valor === undefined || valor === null) continue;

      if (typeof valor !== 'string') {
        return ctx.badRequest(`El campo ${campo} debe ser texto.`);
      }

      const limpio = valor.trim();
      if (limpio.length > CAMPOS_EDITABLES[campo]) {
        return ctx.badRequest(
          `El campo ${campo} no puede pasar de ${CAMPOS_EDITABLES[campo]} caracteres.`
        );
      }

      data[campo] = limpio;
    }

    // Todo lo demás que venga en el body se ignora en silencio.
    if (Object.keys(data).length === 0) {
      return ctx.badRequest('No hay nada que actualizar.');
    }

    try {
      // El usuario sale del token, nunca del cliente: no se puede editar a otro.
      const actualizado = await strapi
        .documents('plugin::users-permissions.user')
        .update({ documentId: user.documentId, data });

      const { password, resetPasswordToken, confirmationToken, ...seguro } =
        actualizado as Record<string, unknown>;

      return seguro;
    } catch (error) {
      strapi.log.error(`[profile.updateMe] fallo al actualizar el usuario ${user.id}`, error);
      return ctx.internalServerError('No se pudo actualizar el perfil.');
    }
  },
};
