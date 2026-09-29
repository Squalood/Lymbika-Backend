import { StockError, parseLocation } from '../services/stock-core';

/**
 * Endpoints de stock del POS. La lógica vive en services/stock-core.ts; aquí solo se lee la
 * petición y se traducen los `StockError` a respuestas HTTP con un código estable que el
 * frontend puede distinguir (INSUFFICIENT_STOCK, NO_PHARMACY, …).
 */
export default ({ strapi }: { strapi: any }) => {
  const core = () => strapi.service('api::pos-stock.stock-core');

  const handle = (fn: (ctx: any) => Promise<unknown>) => async (ctx: any) => {
    try {
      ctx.body = await fn(ctx);
    } catch (e) {
      if (e instanceof StockError) {
        ctx.status = e.status;
        ctx.body = { error: { status: e.status, code: e.code, message: e.message, details: e.details ?? null } };
        return;
      }
      throw e;
    }
  };

  const body = (ctx: any) => ctx.request.body ?? {};
  const user = (ctx: any) => ctx.state.user;

  return {
    sale: handle((ctx) => core().sale({ ventaDocumentId: body(ctx).ventaDocumentId, user: user(ctx) })),

    saleReturn: handle((ctx) =>
      core().saleReturn({ devolucionDocumentId: body(ctx).devolucionDocumentId, user: user(ctx) })
    ),

    purchase: handle((ctx) => core().purchase({ compraDocumentId: body(ctx).compraDocumentId, user: user(ctx) })),

    transfer: handle((ctx) => {
      const b = body(ctx);
      return core().transfer({
        from: parseLocation(b.from),
        to: parseLocation(b.to),
        lines: b.lines,
        notes: b.notes,
        idemKey: b.idemKey,
        user: user(ctx),
      });
    }),

    adjust: handle((ctx) => {
      const b = body(ctx);
      return core().adjust({
        productDocumentId: b.productDocumentId,
        location: parseLocation(b.location),
        mode: b.mode,
        value: b.value,
        reason: b.reason,
        lotDocumentId: b.lotDocumentId,
        affectStock: b.affectStock,
        idemKey: b.idemKey,
        user: user(ctx),
      });
    }),

    count: handle((ctx) => {
      const b = body(ctx);
      return core().count({
        productDocumentId: b.productDocumentId,
        location: parseLocation(b.location),
        lots: b.lots,
        unlotted: b.unlotted,
        reason: b.reason,
        idemKey: b.idemKey,
        user: user(ctx),
      });
    }),

    discardLot: handle((ctx) => {
      const b = body(ctx);
      return core().discard({ lotDocumentIds: b.lotDocumentIds, reason: b.reason, idemKey: b.idemKey, user: user(ctx) });
    }),

    levels: handle((ctx) => core().levels({ pharmacy: parseLocation(ctx.query.pharmacy) })),
  };
};
