/**
 * Hace visible `provider` en el Content Manager.
 *
 * El plugin lo oculta a propósito en
 * `server/content-types/user/schema-config.js`, junto a `resetPasswordToken` y
 * `confirmationToken`. Para esos dos tiene sentido — son secretos. Para
 * `provider` no: es el único dato que distingue una cuenta creada con Google de
 * una creada con contraseña, y sin él todas las filas de la tabla de usuarios
 * se ven idénticas en el panel.
 *
 * Importa porque en esta versión de Strapi un correo pertenece a un solo
 * proveedor: una cuenta `google` no entra con contraseña y una `local` no entra
 * con el botón de Google (ver `server/controllers/auth.js`, que filtra el login
 * local por `provider: 'local'`). Sin esta columna no hay forma de saber, desde
 * el panel, por qué vía debe entrar cada quien.
 *
 * Quién lee esta bandera: `services/utils/configuration/attributes.js` del
 * content-manager, en `isHidden()`, para excluir el campo tanto de la vista de
 * lista como de la de edición.
 *
 * Orden de carga: el loader aplica primero el merge de
 * `content-types/user/schema.json` y después ejecuta este archivo
 * (`@strapi/core/dist/loaders/plugins/index.js`), así que la mutación persiste.
 * Se deja `resetPasswordToken` y `confirmationToken` ocultos como están.
 */
export default (plugin) => {
  const atributos = plugin?.contentTypes?.user?.schema?.config?.attributes;

  // Defensivo a propósito: si una actualización de Strapi mueve esta
  // estructura, que el campo siga oculto en vez de tumbar el arranque.
  if (atributos?.provider) {
    atributos.provider.hidden = false;
  } else {
    strapi.log.warn(
      '[users-permissions] no se pudo mostrar `provider`: la estructura del schema cambió',
    );
  }

  return plugin;
};
