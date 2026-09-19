/**
 * Rutas propias de order, aparte del core router de `order.ts`.
 *
 * La ruta lleva dos segmentos despues de /orders a proposito: el core router
 * ya define GET /orders/:id, y una ruta de un solo segmento haria match ahi
 * primero, tomando "by-session" como si fuera un id.
 */
export default {
  routes: [
    {
      method: 'GET',
      path: '/orders/by-session/:sessionId',
      handler: 'order.porSesion',
      config: {
        policies: [],
        middlewares: [],
      },
    },
  ],
};
