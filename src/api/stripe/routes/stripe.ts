export default {
  routes: [
    {
      method: 'POST',
      path: '/stripe/webhook',
      handler: 'stripe.webhook',
      config: {
        // Stripe no manda JWT: la autenticidad la da la firma HMAC del cuerpo,
        // que se verifica en el controlador. Sin `auth: false`,
        // users-permissions responderia 403 y Stripe reintentaria tres dias.
        // Es la unica ruta del repo que debe ser publica.
        auth: false,
        policies: [],
        middlewares: [],
      },
    },
  ],
};
