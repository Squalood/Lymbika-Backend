/**
 * Rutas del equipo (/dashboard/operations), aparte del core router.
 *
 * `scope` reutiliza el permiso `find` de case: quien puede ver casos puede ver
 * a quién asignarlos, sin marcar otra acción en el rol. Dos segmentos después
 * de /cases para no chocar con GET /cases/:id.
 */
export default {
  routes: [
    {
      method: 'GET',
      path: '/cases/equipo/miembros',
      handler: 'case.equipo',
      config: { auth: { scope: ['api::case.case.find'] }, policies: [], middlewares: [] },
    },
  ],
};
