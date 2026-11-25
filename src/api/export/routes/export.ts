export default {
  routes: [
    {
      method: 'GET',
      path: '/export/products',
      handler: 'export.exportProducts',
      config: {
        policies: [],
        middlewares: [],
      },
    },
    {
      method: 'POST',
      path: '/export/products/import',
      handler: 'export.importProducts',
      config: {
        policies: [],
        middlewares: [],
      },
    },
    {
      // Prompt para llenar la ficha de un producto con ChatGPT/Claude (botón del POS).
      method: 'GET',
      path: '/export/products/:documentId/prompt',
      handler: 'export.fichaPrompt',
      config: {
        policies: [],
        middlewares: [],
      },
    },
    {
      method: 'POST',
      path: '/export/products/reset-stock',
      handler: 'export.resetStock',
      config: {
        policies: [],
        middlewares: [],
      },
    },
  ],
};
