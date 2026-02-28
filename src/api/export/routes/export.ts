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
