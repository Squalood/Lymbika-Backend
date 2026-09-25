/**
 * Rutas públicas del paciente, aparte del core router de `case.ts`.
 *
 * Van con `auth: false`: el intake no exige login, y la vista "Mi caso" se
 * autoriza con el token secreto del caso, no con un rol. Las rutas por token
 * llevan dos segmentos despues de /cases para no chocar con GET /cases/:id.
 */
export default {
  routes: [
    {
      method: 'POST',
      path: '/cases/intake',
      handler: 'case.intake',
      config: { auth: false, policies: [], middlewares: [] },
    },
    {
      method: 'GET',
      path: '/cases/by-token/:token',
      handler: 'case.porToken',
      config: { auth: false, policies: [], middlewares: [] },
    },
    {
      method: 'POST',
      path: '/cases/by-token/:token/documents',
      handler: 'case.subirDocumentos',
      config: { auth: false, policies: [], middlewares: [] },
    },
  ],
};
