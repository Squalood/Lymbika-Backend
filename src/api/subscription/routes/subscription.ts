export default {
  routes: [
    {
      method: 'POST',
      path: '/subscription/checkout',
      handler: 'subscription.checkout',
      config: {
        policies: [],
        middlewares: [],
      },
    },
    {
      method: 'POST',
      path: '/subscription/portal',
      handler: 'subscription.portal',
      config: {
        // Sin `auth: false`, al reves que /stripe/webhook: aqui si hace falta
        // JWT. El portal se abre para el usuario del token y para nadie mas.
        policies: [],
        middlewares: [],
      },
    },
  ],
};
