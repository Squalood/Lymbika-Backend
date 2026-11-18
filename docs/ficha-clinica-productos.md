# Ficha clínica de productos

> Guía de la estructura de datos clínicos de `product`: qué existe, cómo se captura y cómo se consulta.
> Estado: estructura creada (commit `b36eb70`). La ficha se captura a mano desde el admin; el pre-llenado con IA, la ficha en la página del producto y el chatbot son fases siguientes.

## 0. Para qué existe

El objetivo es un chatbot en el frontend que recomiende productos. Antes, la información clínica vivía en texto libre (`sal`, `descriptionPro`), con errores e inconsistencias, y no se podía filtrar de forma confiable. Por ejemplo, no se podía consultar "venta libre, apto para niños de 2 años y que no dé sueño".

La ficha clínica guarda esa información en campos estructurados, que se pueden filtrar y revisar.

Principios del diseño:

- **Todo es aditivo.** No se borró ni renombró ningún campo. Los productos sin ficha se comportan igual que antes.
- **Lo que depende de la sustancia se captura una sola vez.** La loratadina tiene la misma información de embarazo o contraindicaciones en Clarityne, Grimeral y el genérico, así que esos datos viven en `principio-activo` y no en cada producto.
- **Se distingue la ficha capturada de la ficha revisada.** El bot solo debe usar fichas revisadas por un farmacéutico.

---

## 1. Modelo

```
                      ┌────────────────────┐
                      │  principio-activo  │  ← información por sustancia
                      └─────────▲──────────┘
                                │ principioActivo (1)
┌───────────────┐   composicion (repetible)   ┌──────────────────────────┐
│    product    │────────────────────────────▶│ componente               │
│               │                             │ producto.composicion     │
│               │                             │ cantidad, unidad, por…   │
│               │                             └──────────────────────────┘
│               │  indicaciones (N:N)  ┌──────────────┐  especialidades (N:N)  ┌───────────┐
│               │─────────────────────▶│  indicacion  │───────────────────────▶│  service  │
└───────────────┘                      └──────────────┘                        │(Specialty)│
                                                                               └───────────┘
```

| Pieza | Tipo | Draft & publish | Archivo |
|---|---|---|---|
| `principio-activo` | Colección | No | [schema](../src/api/principio-activo/content-types/principio-activo/schema.json) |
| `indicacion` | Colección | No | [schema](../src/api/indicacion/content-types/indicacion/schema.json) |
| `producto.composicion` | Componente | — | [composicion.json](../src/components/producto/composicion.json) |
| Campos nuevos de `product` | — | Sí (como el resto del producto) | [schema](../src/api/product/content-types/product/schema.json) |
| `service.indicaciones` | Inverso de `indicacion.especialidades` | — | [schema](../src/api/service/content-types/service/schema.json) |

---

## 2. Qué va dónde

Para decidir dónde va un dato, la pregunta es: **¿cambia entre dos productos que contienen la misma sustancia?**
- **No** → va en `principio-activo`.
- **Sí** → va en el producto (por ejemplo, la posología, que depende de la concentración y la forma).

### 2.1 `principio-activo` (por sustancia)

| Campo | Tipo | Valores / notas |
|---|---|---|
| `nombre` | string, requerido, único | Nombre genérico, como aparecerá en `sal` ("Loratadina", "Naproxeno sódico") |
| `slug` | uid | Se genera del nombre |
| `sinonimos` | text | Otros nombres: "paracetamol, acetaminofén" |
| `codigoAtc` | string | Clasificación ATC (loratadina = `R06AX13`). Agrupa por clase terapéutica |
| `embarazo` | enum | `compatible` · `precaucion` · `contraindicado` · `sinDatos` |
| `lactancia` | enum | Mismos valores que `embarazo` |
| `causaSomnolencia` | boolean | `null` = no capturado. No es lo mismo que `false` |
| `esAntibiotico` | boolean | Los antibióticos son fracción IV, pero la farmacia retiene la receta |
| `contraindicaciones` | text | |
| `advertencias` | text | Precauciones; efectos al manejar o con alcohol |
| `interacciones` | text | Con qué no combinarlo |
| `efectosAdversos` | text | Reacciones secundarias comunes |

### 2.2 `indicacion` (padecimiento o síntoma)

| Campo | Tipo | Notas |
|---|---|---|
| `nombre` | string, requerido, único | "Rinitis alérgica", "Dolor de cabeza" |
| `slug` | uid | |
| `sinonimos` | text | **Cómo lo dice la gente**: "estornudos, mocos, comezón de ojos". Es lo que permite la búsqueda por síntoma |
| `descripcion` | text | |
| `senalesAlarma` | text | Cuándo **no** recomendar nada y mandar al médico ("fiebre de más de 3 días", "dolor de pecho") |
| `especialidades` | relación N:N → `service` | A qué especialidad derivar. Así el bot puede ofrecer una consulta con un doctor de Lymbika |
| `products` | relación N:N (inverso) | Productos para esta indicación |

### 2.3 Componente `producto.composicion` (un renglón por principio activo)

| Campo | Tipo | Valores |
|---|---|---|
| `principioActivo` | relación → `principio-activo` | Se elige de la colección, no se escribe a mano. Así no hay variantes como "Loratadina", "loratadina" y "Loratadine" |
| `cantidad` | decimal | `10` |
| `unidad` | enum | `mg` · `g` · `mcg` · `UI` · `mEq` · `UFC` · `ml` · `porcentaje` |
| `porCantidad` | decimal | Opcional. En "250 mg / 5 ml" es el `5` |
| `porUnidad` | enum | `ml` · `g` · `dosis` · `gota` |

Ejemplos:

| Producto | Renglones |
|---|---|
| Tableta de loratadina 10 mg | Loratadina · 10 · mg |
| Jarabe de paracetamol 250 mg/5 ml | Paracetamol · 250 · mg · 5 · ml |
| Crema de sulfadiazina de plata 1 % | Sulfadiazina de plata · 1 · porcentaje |
| Brunadol (naproxeno 275 + paracetamol 300) | Naproxeno sódico · 275 · mg<br>Paracetamol · 300 · mg |

### 2.4 Campos nuevos en `product`

| Campo | Tipo | Valores / notas |
|---|---|---|
| `tipoProducto` | enum | `medicamento` · `suplemento` · `dermocosmetico` · `dispositivoMedico` · `higienePersonal` · `otro`. Define qué reglas aplican al producto (un condón no tiene fracción) |
| `composicion` | componente repetible | Ver §2.3. Solo principios activos. Los ingredientes de cosméticos siguen en `sal` |
| `formaFarmaceutica` | enum | `tableta` · `tabletaMasticable` · `tabletaEfervescente` · `tabletaSublingual` · `capsula` · `jarabe` · `suspension` · `solucionOral` · `gotasOrales` · `polvo` · `crema` · `gel` · `unguento` · `locion` · `solucionTopica` · `spray` · `inhalador` · `solucionNebulizar` · `solucionNasal` · `gotasOftalmicas` · `gotasOticas` · `ovulo` · `supositorio` · `inyectable` · `parche` · `otro` |
| `viaAdministracion` | enum | `oral` · `sublingual` · `topica` · `oftalmica` · `otica` · `nasal` · `inhalada` · `vaginal` · `rectal` · `intramuscular` · `intravenosa` · `subcutanea` · `otra` |
| `contenidoCantidad` | decimal | `20` en "caja c/20 tabletas". Sirve para calcular el precio por unidad |
| `contenidoUnidad` | enum | `tabletas` · `capsulas` · `ml` · `g` · `sobres` · `piezas` · `ampolletas` · `ovulos` · `supositorios` · `parches` · `dosis` |
| `fraccion` | enum | `I` a `VI` (ver §3.2). **Determina `conReceta`** |
| `edadMinimaMeses` | integer ≥ 0 | Siempre en meses: 2 años = `24`, adultos = `144` (12 años) o lo que diga el prospecto |
| `indicaciones` | relación N:N → `indicacion` | |
| `posologia` | text | Dosis para adultos y niños, tomada del prospecto |
| `advertenciasAdicionales` | text | Solo lo propio del producto que no viene de la sustancia (p. ej. un excipiente como la tartrazina) |
| `registroSanitario` | string | Número de registro COFEPRIS |
| `prospecto` | media (un archivo) | PDF del IPP. Solo se puede subir en producción (en local no hay llaves de AWS) |
| `requiereRefrigeracion` | boolean | Para envíos con cadena de frío |
| `sinAzucar` | boolean | Importante para la categoría de diabetes |
| `fuenteInfo` | enum | `empaque` · `ipp` · `plm` · `ia` · `otra`. De dónde salió la información clínica |
| `estadoFicha` | enum | `pendiente` (default en productos nuevos) · `revisada`. Ver §4 |
| `revisadoPor` | string | Nombre y cédula de quien revisó |
| `fechaRevision` | date | |

Campos que **siguen igual**: `sal`, `conReceta`, `tipo`, `drug_type`, `descriptionPro`, etc. Los usan el frontend, el POS y el CSV, y no se tocaron.

---

## 3. Campos derivados: `sal` y `conReceta`

`sal` y `conReceta` son anteriores a la ficha y los siguen leyendo:
- la búsqueda del frontend (`hooks/use-search.ts`) y del POS (`searchProducts.ts`, `getProductsPage.ts`),
- la tarjeta de producto del frontend (bloquea el carrito si `conReceta`),
- el export/import CSV.

En vez de cambiar a todos esos consumidores, **se calculan solos a partir de la ficha** cuando hay datos.

### 3.1 Reglas

| Campo | Se recalcula si… | Valor | Si no hay datos… |
|---|---|---|---|
| `sal` | `composicion` tiene al menos un renglón con principio activo | Los renglones unidos con coma: `"Naproxeno sódico 275 mg, Paracetamol 300 mg"`, `"Paracetamol 250 mg / 5 ml"`, `"Sulfadiazina de plata 1%"` | Se respeta el texto manual (cosméticos y dispositivos describen ahí sus ingredientes) |
| `conReceta` | `fraccion` está capturada | `I`–`IV` → `true` · `V`–`VI` → `false` | Se respeta el valor manual |

> ⚠️ **En un producto con ficha, editar `sal` o `conReceta` a mano no sirve: se recalculan al guardar.** Si el valor está mal, hay que corregir la composición o la fracción.

> ⚠️ **Al capturar la fracción puede cambiar lo que se vende en línea.** Hoy hay medicamentos con receta marcados `conReceta = false` (olanzapina, quetiapina, atorvastatina, misoprostol…). Al capturarles la fracción IV pasan a `true` y el frontend ya no deja agregarlos al carrito. Es lo correcto, pero conviene saberlo.

### 3.2 Fracciones COFEPRIS (Art. 226 de la Ley General de Salud)

| Fracción | Qué es | `conReceta` | ¿Lo recomienda el bot? |
|---|---|---|---|
| I | Estupefacientes (receta especial con código) | true | No |
| II | Psicotrópicos, receta retenida | true | No |
| III | Psicotrópicos, receta que se surte hasta 3 veces | true | No |
| IV | Requiere receta médica; puede resurtirse. Antibióticos: receta retenida (`esAntibiotico`) | true | No |
| V | Sin receta, solo en farmacias | false | Sí |
| VI | Sin receta, en cualquier establecimiento | false | Sí |

Los productos que no son medicamentos (suplementos, dermocosméticos, dispositivos) no tienen fracción. Se deja vacía y `conReceta` se queda como esté.

### 3.3 Cómo está implementado

- [`src/api/product/utils/derivar-ficha.ts`](../src/api/product/utils/derivar-ficha.ts) es un **middleware del Document Service**, registrado en `register()` de [`src/index.ts`](../src/index.ts).
- Corre después de `create`, `update`, `publish` y `discardDraft` de `api::product.product`, que es lo que usan el admin, el import CSV y cualquier código con `strapi.documents(...)`.
- Calcula **por fila**: el borrador y la versión publicada se derivan cada una con su propia composición. Un cambio en el borrador no altera lo publicado hasta que se publique.
- Escribe por SQL sobre el `id` de la fila y solo si el valor cambió, con el mismo criterio que `stock_central`. Pasar por el Document Service volvería a disparar el middleware y republicaría el borrador.
- Reutiliza la transacción del llamador si la hay. Escribir fuera de ella se quedaría esperando el candado que esa misma transacción tiene sobre la fila.
- **Nunca lanza.** Si falla, registra `[product] no se pudieron derivar sal/conReceta de <documentId>` y el guardado sigue. Para corregir un valor desactualizado basta con volver a guardar el producto.
- Lo que **no** pasa por el middleware: escrituras con `strapi.db.query` o SQL directo (como `/pos-stock`, que solo toca `stock_central`). Esas no cambian la ficha.

---

## 4. Estados de la ficha

| `estadoFicha` | Significado |
|---|---|
| `null` | Producto anterior a la ficha: **sin capturar** (los 1,925 productos existentes empiezan así) |
| `pendiente` | Capturada, o creada después de la ficha, pero **sin revisar** por un farmacéutico |
| `revisada` | Revisada. Se llena `revisadoPor` (nombre y cédula) y `fechaRevision` |

`fuenteInfo` indica de dónde salió la información: `empaque`, `ipp` (prospecto oficial), `plm` (diccionario PLM), `ia` u `otra`.

**Regla para el pre-llenado con IA (fase futura).** Ningún script ni proceso automático puede romper esto:
1. Solo llena **campos vacíos**. Nunca sobrescribe lo capturado a mano.
2. Solo toca fichas en `null` o `pendiente`. **Nunca toca una ficha `revisada`.**
3. Marca `fuenteInfo = ia` y deja `estadoFicha = pendiente`.

---

## 5. Guía de captura (admin)

### 5.1 Orden recomendado

1. **Principios activos primero.** En *Content Manager → Principio activo*, crear la sustancia con su información clínica. Se hace una vez y sirve para todos los productos que la contienen.
2. **Indicaciones.** En *Content Manager → Indicación*, crear el padecimiento con sus sinónimos coloquiales, las señales de alarma y las especialidades a las que se deriva.
3. **Producto.** Abrir el producto y llenar:
   - `tipoProducto`
   - `composicion` (botón *Add an entry*, un renglón por sustancia)
   - forma, vía y contenido
   - `fraccion`, `edadMinimaMeses` e `indicaciones`
   - `posologia`
   - `fuenteInfo`
4. **Guardar y publicar.** `sal` y `conReceta` se actualizan solos (§3).
5. **Revisión.** Un farmacéutico verifica la ficha, cambia `estadoFicha` a `revisada` y llena `revisadoPor` y `fechaRevision`.

### 5.2 Por dónde empezar

Con 1,925 productos no hay que llenarlo todo de golpe. Para que el bot sirva pronto:
- Primero, **medicamentos de venta libre** (fracción V y VI) y los **más vendidos**. Son los únicos que el bot puede recomendar.
- Para los medicamentos con receta basta con `tipoProducto` y `fraccion`, que ya corrigen `conReceta`.
- Para los no medicamentos basta con `tipoProducto` y, si aplica, `indicaciones`.

### 5.3 Criterios para casos dudosos

- **Combinados** (paracetamol + fenilefrina + clorfenamina): un renglón por cada sustancia. Para embarazo, lactancia y somnolencia, el producto toma **el caso más restrictivo** de sus sustancias. Esto lo calcula quien consulta (§6), no se captura en el producto.
- **Edad mínima**: siempre en meses, tal como la indica el prospecto. Si el prospecto dice "mayores de 12 años", poner `144`.
- **Cosméticos y dispositivos**: no llevan `composicion` ni `fraccion`. Su descripción de ingredientes se queda en `sal`.
- **Sustancias que no son fármaco** (vitaminas, probióticos): pueden ir en `composicion` si quieres poder buscarlas por sustancia, por ejemplo "Vitamina D3 · 1000 · UI".

---

## 6. Cómo consultarla (API)

### 6.1 Permisos

Las rutas nuevas no tienen permisos por defecto: responden **403** hasta habilitarlos. En *Settings → Users & Permissions → Roles → Public*, marcar `find` y `findOne` de **Principio-activo** e **Indicacion**. Hay que hacerlo **en cada entorno** (local y producción), porque los permisos no viven en el código.

Los campos nuevos de `product` ya se pueden leer con los permisos actuales de producto.

### 6.2 Ejemplos REST

Ficha completa de un producto:

```
GET /api/products/:documentId
  ?populate[composicion][populate][principioActivo]=true
  &populate[indicaciones][fields][0]=nombre
```

Productos que contienen una sustancia:

```
GET /api/products?filters[composicion][principioActivo][nombre][$eqi]=loratadina
```

Candidatos por síntoma, solo de venta libre y con ficha revisada:

```
GET /api/products
  ?filters[indicaciones][sinonimos][$containsi]=estornudos
  &filters[fraccion][$in][0]=V&filters[fraccion][$in][1]=VI
  &filters[estadoFicha][$eq]=revisada
  &filters[active][$eq]=true
```

Estos filtros se probaron con el Document Service, que es lo que usa la API REST por dentro.

> ⚠️ **Un filtro sobre la composición coincide si *alguno* de sus principios activos lo cumple, no todos.** `filters[composicion][principioActivo][causaSomnolencia][$eq]=false` devuelve un antigripal con fexofenadina (no da sueño) **y** clorfenamina (sí da sueño). Para condiciones de seguridad (somnolencia, embarazo, lactancia) hay que traer la composición con `populate` y verificar **todas** las sustancias en código, tomando el caso más restrictivo.

### 6.3 Reglas para el bot (fase futura)

El bot solo debe recomendar productos que cumplan **todo** esto:

- `estadoFicha = revisada`.
- `active = true`, publicados y con stock.
- `fraccion` en V o VI, o `tipoProducto` distinto de `medicamento`.
- `edadMinimaMeses` menor o igual a la edad del paciente.
- Ninguna sustancia `contraindicado` si la paciente está embarazada o en lactancia.

Además:

- Si el síntoma coincide con `senalesAlarma` de la indicación, no recomienda productos: deriva a la especialidad (`indicacion.especialidades`).
- Para un medicamento con receta (I–IV) puede decir que existe y que requiere receta, y ofrecer la consulta, pero **no lo recomienda**.

Estos filtros deben aplicarse **en el servidor**, con una ruta del backend que devuelva los candidatos ya filtrados, y no en las instrucciones al modelo. Es el mismo criterio que precios y membresía: el servidor decide y el cliente no puede saltárselo.

---

## 7. Despliegue

La estructura se crea sola al desplegar, pero los permisos y los datos no.

1. `git push` a `main` → Render despliega y Strapi crea las tablas y columnas nuevas en producción. Es aditivo: no toca datos existentes.
2. En el admin de producción, habilitar los permisos públicos de §6.1.
3. Capturar las fichas **en el admin de producción**, no en local: el contenido real vive ahí, y el branch `dev-local` se reemplaza con cada "Reset from parent".

---

## 8. Pendientes y fases siguientes

| Fase | Qué | Notas |
|---|---|---|
| Pre-llenado con IA | Script que lea `productName` y `sal`, proponga tipo, composición, forma y contenido, y genere un CSV para revisión | Requiere API key. Respetar la regla de §4 |
| Import/export CSV | Agregar las columnas nuevas | Antes hay que arreglar tres fallas del import actual: arma mal el `connect` de categoría; escribe `fecha_caducidad`, que ya no existe; y sobrescribe `stock_central` por Document Service, contra la regla de stock |
| Frontend | Mostrar la ficha en la página del producto | Ningún consumidor actual se rompe: frontend y POS piden campos explícitos |
| Chatbot | Ruta de candidatos en el backend + bot en el frontend | Ver §6.3 |
| Limpieza de `tipo` | El enum tiene valores con espacios al inicio y mezcla categorías | El frontend lo usa en el filtro de categorías: coordinar el cambio |
