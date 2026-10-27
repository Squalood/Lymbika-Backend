# Lymbika-Backend — memoria del proyecto para Claude

Contexto general (máquina, Neon `dev-local` vs `main`, `.env` local vs `.env.production`, flujo local → Render): ver `..\..\CLAUDE.md`. Aquí solo lo específico de este repo.

## Qué es
- API + admin de Lymbika (tienda de farmacia en línea, servicios médicos/cirugías, membresía, casos de pacientes y POS de farmacias). Lo consumen `Lymbika-Frontend` (www.lymbika.com) y `point-of-sale`.
- Strapi **5.36** + TypeScript, Node ≤ 22. BD Postgres (Neon) vía `DATABASE_URL`; también soporta sqlite/mysql (`config/database.ts`, sin defaults a propósito: si falta una variable revienta el arranque).
- Deploy: Render (`lymbika-backend.onrender.com`), despliega al hacer push a `main`.
- Media: provider **aws-s3** (bucket privado + CloudFront, `AWS_CDN_URL`). Cloudinary es legado (la dependencia sigue en package.json; los `scripts/` de migración la mencionan).
- Correo: nodemailer contra SMTP de Resend, solo si existe `SMTP_HOST` (`config/plugins.ts`).
- Stripe SDK v17 (`STRIPE_KEY`, `STRIPE_WEBHOOK_SECRET`). Variables documentadas en `.env.example` (no leer `.env`/`.env.production`).

## Comandos
- `npm run develop` → admin y API en http://localhost:1337 (autoreload; **sincroniza el esquema de la BD**).
- `npm run build` (compila admin) · `npm run start` (prod, sin autoreload).
- No hay tests ni linter configurados. Verificar compilando (`npm run build`) o arrancando `develop`.
- `node scripts/probar-webhook.js` manda eventos firmados al webhook local sin Stripe CLI.

## Mapa de content types (`src/api/*`)
Casi todos usan controller/service/router de fábrica (`factories.createCore*`, archivos de 2–7 líneas). Lo personalizado se indica con ★.

**Catálogo / tienda en línea**
- `product` (precio, `priceMember`, `priceInpatient`, `impuesto`, `stock_central`, lotes, stock por farmacia), `category`, `laboratorio`, `review` ★ (`create` fuerza `user` = usuario del JWT).
- `order` ★ — `create`: acepta solo `{id, quantity}`, precios desde Strapi (`status: 'published'`), precio de miembro si `membershipActive`, envío `DELIVERY_COST_MXN`, crea sesión de Stripe Checkout; **no valida stock** (el stock es del POS). Ruta extra `GET /orders/by-session/:sessionId` (`routes/order-consulta.ts`).
- `stripe` ★ (sin content type) — `POST /api/stripe/webhook` (`auth: false`, única ruta pública por firma). Verifica firma con el cuerpo crudo, idempotencia con `stripe-event` (`eventId` único, estados recibido/procesado/ignorado/fallido) y despacha a `handlers/orders.ts` (marca órdenes pagadas) y `handlers/subscriptions.ts`.
- `export` ★ (sin content type) — `GET /export/products` (CSV), `POST /export/products/import`, `POST /export/products/reset-stock`.

**Membresía / usuarios**
- `membership` (planes; `stripePriceIdP`/`F` = personal/familiar), `membership-page` (single).
- `subscription` ★ (sin content type) — `POST /subscription/checkout` y `/subscription/portal` (Customer Portal). Planes leídos solo vía `services/planes.ts`.
- `stripe/services/membership.ts` = **única** regla de `membershipActive` (active/trialing/past_due conceden).
- `profile` ★ — `PUT /profile`: el usuario edita solo `firstName`, `lastName`, `bio` (reemplaza el `update` de users-permissions, que dejaba regalarse la membresía).
- `src/extensions/users-permissions/`: campos extra del `user` (Stripe, suscripción, `membershipManual`, `membershipActive`) y `strapi-server.ts` que hace visible `provider` en el admin.

**Clínicas / servicios médicos**
- `clinic`, `doctor`, `hospital`, `service` (especialidad), `medical-service` (con landing: hero, FAQ, galería, hospitales), `service-rate` (precio por servicio+doctor+clínica, paquetes), `surgery`, `faq-group`.
- `case` ★ — casos de pacientes (sin draft). Rutas públicas en `routes/case-paciente.ts` (`auth: false`): `POST /cases/intake`, `GET /cases/by-token/:token`, `POST /cases/by-token/:token/documents`. Ningún rol debe tener permisos sobre el core router de `case`. `lifecycles.ts` completa token/número (`LYM-<año>-<000001>`)/link si se crea desde el panel (`utils/identidad-caso.ts`); `utils/notificar-caso.ts` avisa por correo a `CASE_NOTIFY_EMAILS` con datos mínimos y nunca lanza.

**Contenido / páginas (single types)**
- `home-page` (dynamic zone de `components/home/*`; ver `docs/home-page-migration.md`), `about-page`, `navbar-section`, `schedules-page`, `site-config` (constantes globales del frontend), `page` (collection, legado).

**POS / inventario**
- `caja-pos` (apertura/corte por farmacia, MXN/USD/tarjeta/transferencia), `venta-pos` (items = componente `venta-item` con `unitCost`, tax; `recargoTarjeta`, `managementFee`, `esProveedor`, `esMembresia`), `devolucion-pos`, `compra-pos` (items `compra-item` con `costoUnitario`, IVA, `destination_pharmacy`), `proveedor`, `factura` (borradores de CFDI, ligadas a venta/farmacia).
- `pharmacy`, `pharmacy-stock` (fila por producto-farmacia, `pairKey`), `inventory-lot` (lotes, caducidad, merma), `stock-transfer`, `stock-operation` (bitácora idempotente; sin controller/rutas).
- `pos-stock` ★ (sin content type) — toda la lógica en `services/stock-core.ts`; rutas `POST /pos-stock/{sale,return,purchase,transfer,adjust,count,discard-lot,move-all}` y `GET /pos-stock/levels`. Requieren JWT y habilitar cada acción al rol Authenticated en Users & Permissions.

## Patrones a respetar
- **Stock** (leer el encabezado de `src/api/pos-stock/services/stock-core.ts` antes de tocarlo):
  - `product.stock_central` = total; cada farmacia en `pharmacy-stock`; **bodega = total − Σ farmacias** (no se guarda). Ubicación `null`/`"bodega"` = bodega.
  - Todo movimiento dentro de `strapi.db.transaction` con `FOR UPDATE`; orden de bloqueo producto → farmacias. El cliente manda el documento (venta/compra/devolución) o el delta, nunca el valor final.
  - `stock_central` se escribe por SQL sobre `document_id`, nunca con el Document Service (re-publicaría el borrador del producto).
  - Cada operación registra `stock-operation` con `opKey` único (reintentos idempotentes). Lotes FEFO; fechas en zona `America/Mexico_City`. Devoluciones no tocan lotes.
  - Errores como `StockError(status, code, …)`; el controller los traduce a `{ error: { code } }` estable para el POS.
  - Los índices únicos (`pharmacy_stocks.pair_key`, `stock_operations.op_key`) se crean en cada arranque en `src/index.ts` (Strapi no los declara y el sync puede borrarlos).
- **Seguridad de precios/identidad**: el servidor resuelve precios, usuario y membresía; descartar cualquier campo extra del body (ver `order`, `subscription`, `profile`, `review`).
- Rutas custom de varios segmentos (`/orders/by-session/:x`, `/cases/by-token/:x`) para no chocar con `GET /:id` del core router. `auth: false` solo con otra forma de autenticación (firma, token secreto).
- Middleware `strapi::body` con `includeUnparsed: true` (`config/middlewares.ts`): necesario para la firma de Stripe. El CSP deriva el dominio del CDN de `AWS_CDN_URL`.
- `src/index.ts` bootstrap: suscripción a lifecycles de `plugin::upload.file` que genera variantes WebP en S3 vía `lib/media-variants.js` (JS fuera de `src/` porque el build solo transpila `.ts`; nunca lanza). Reparación: `scripts/sync-new-media.js --fix`.
- Efectos secundarios (correo, variantes) **nunca lanzan**: registran con `strapi.log` y siguen.
- Código y comentarios en español; los comentarios explican el *porqué* y las decisiones (mantener ese estilo). Secciones con `// ── Título ───`.
- `api.ts`: `defaultLimit 25`, `maxLimit 5000`.

## Convenciones de commits
- Conventional commits en español: `tipo(scope): descripción`, tipos `feat`, `fix`, `refactor`, `chore`, `perf`; scope = content type o área (`stock`, `case`, `stripe`, `subscription`, `media`, `site-config`…). Ej.: `feat(stock): conteo físico por lote (/pos-stock/count)`.
- Descripción en minúscula, verbo en presente (agrega, quita, migra…). Trabajo normalmente directo en `main`; ramas `chore/...` + PR para cambios sensibles.
- Los cambios de schema van junto con `types/generated/*.d.ts` (los regenera `strapi develop`).

## Gotchas
- `strapi develop` sincroniza el esquema: renombrar/borrar un campo borra la columna y sus datos. **Nunca** correr local contra la BD de producción (usar branch Neon `dev-local`).
- Cambios de estructura se hacen en el admin local (Content-Type Builder escribe `schema.json`), se commitean y Render los aplica en prod. Avisar antes de renombrar/borrar campos que el frontend o el POS consuman.
- Permisos de rutas nuevas (users-permissions) no viven en el código: hay que habilitarlos en el admin de cada entorno.
- `order` nace publicada (no borrador). `stripe-event`, `case`, `factura`, `pharmacy*`, `inventory-lot`, `stock-*`, `service-rate`, `site-config` no tienen draft & publish.
- Para OXXO/SPEI habría que añadir `checkout.session.async_payment_*` al webhook (ver comentario en `src/api/stripe/controllers/stripe.ts`).
- Local: sin llaves AWS no se sube/borra media; sin `SMTP_HOST` no salen correos; Stripe con `sk_test_`.
