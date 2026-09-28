/**
 * Rutas de stock del POS (/api/pos-stock/...). Requieren JWT: hay que habilitar cada acción
 * para el rol Authenticated en Settings → Users & Permissions → Roles → Pos-stock.
 */
const route = (method: 'GET' | 'POST', path: string, handler: string) => ({
  method,
  path,
  handler: `pos-stock.${handler}`,
  config: { policies: [], middlewares: [] },
});

export default {
  routes: [
    route('POST', '/pos-stock/sale', 'sale'),
    route('POST', '/pos-stock/return', 'saleReturn'),
    route('POST', '/pos-stock/purchase', 'purchase'),
    route('POST', '/pos-stock/transfer', 'transfer'),
    route('POST', '/pos-stock/adjust', 'adjust'),
    route('POST', '/pos-stock/discard-lot', 'discardLot'),
    route('GET', '/pos-stock/levels', 'levels'),
  ],
};
