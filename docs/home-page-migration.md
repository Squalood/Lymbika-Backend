# Migración: `page[front-page]` → Single Type `home-page`

> Spec de backend (Strapi 5) para el agente que trabaja el frontend (`frontend-lymbika`).
> Estado: propuesta. Nada de esto está creado todavía.

## 0. Objetivo y alcance

- Crear un **Single Type `home-page`** con un único campo `sections` (Dynamic Zone).
- **Reemplaza** la entrada `front-page` del collection type `pages`.
- **Eliminar el uso de campos JSON** para el home: todo lo que hoy vive en
  `pages[slug=front-page].landingPageJson` pasa a componentes reales.

### Lo que NO entra en este alcance

| Cosa | Por qué se queda |
|---|---|
| El collection type `pages` | Sigue sirviendo a los slugs `doctores`, `farmacia`, `lymbika-membership` |
| `landingPageJson` en `pages` | Las 8 claves `doctores*` alimentan `/healthHubs`. Migrarlas es un segundo proyecto |
| `TopContact`, `CarouselTextBanner` | Hoy son hardcoded / `locals/es`. Ver §7.3 |

### Inventario real de `pages` en producción (verificado en BD)

```
slug                                   claves de landingPageJson
front-page          alyusSection, turistSection, videosSection, areDoctorsSection   ← se migra
doctores            doctoresSection1..4, doctoresHeroStats, doctoresCtaSection,
                    doctoresFaqSection, doctoresPlansSection                        ← se queda
farmacia            (vacío)                                                         ← se queda
lymbika-membership  (vacío)                                                         ← se queda
about               (vacío)
medicos-en-juarez   hero, footer, global, header, doctors, finalCta, ecosystem,
                    howItWorks, whyWeExist, crossBorder, specialtySearch            ← ⚠️ ver §7.4
dr-contreras, dr-escudero, dr-guinto, dra-iracheta, dra-cecilia-torres,
dr-adrian-martinez-ruiz, dr-jorge-arturo-blanco,
dra-laura-alejandra-marquez-duarte
                    hero, footer, process, services, telephone, whyChoose,
                    trustStrip, testimonials                                        ← ⚠️ ver §7.4
```

---

## 1. Componentes que se RECICLAN (no crear nada)

| Uso en el home | Componente existente | Filas en prod |
|---|---|---|
| Sección hero | [`hero.hero`](../src/components/hero/hero.json) | 22 |
| Sección galería | [`gallery.gallery`](../src/components/gallery/gallery.json) | 2 |
| Items del carrusel de promos | [`promo.promo`](../src/components/promo/promo.json) | 22 |
| Items de la sección de videos | [`video-id.youtube-video`](../src/components/video-id/youtube-video.json) | 311 |
| `perks` de are-doctors | [`item.pill`](../src/components/item/pill.json) | 12 |
| `testimonial` de are-doctors **y** de turist | [`testimonial.testimonials`](../src/components/testimonial/testimonials.json) † | 93 |

† requiere una modificación aditiva, ver §2.

**`hero.hero` es idéntico campo por campo** a lo que se había planeado como `home.hero`
(`title`/`description`/`buttonText`/`buttonUrl`/`image`), y el home ya lo consume hoy.
No crear `home.hero`.

**`gallery.gallery` ya es `title` + `images` múltiple**, exactamente lo que consume
`galleryCarousel.tsx`. Va **directo en la Dynamic Zone**, sin wrapper.

> Una Dynamic Zone puede listar componentes de **cualquier categoría**. No hace falta
> que todo esté bajo `home.`.

---

## 2. Componente a MODIFICAR

### `testimonial.testimonials` — agregar `role`

Hoy: `name:string`, `text:text`, `rating:decimal`. Le falta `role`, que sí existe en los
datos actuales (`ceoRole`, `testimonial.role`).

```diff
   "attributes": {
     "name": { "type": "string" },
     "text": { "type": "text" },
+    "role": { "type": "string" },
     "rating": { "type": "decimal" }
   }
```

Es aditivo y no rompe las 93 filas existentes (`clinics.testimonials`).
En el home, `rating` simplemente queda vacío.

**Esto elimina una duplicación del plan original**: `turist-section` traía el testimonial
aplanado (`quote`/`ceoName`/`ceoRole`) y `are-doctors-section` lo traía como componente.
Ahora ambos usan el mismo.

---

## 3. Componentes NUEVOS — `schema.json` completo

Rutas relativas a `src/components/`. Si los creas por el Content-Type Builder, Strapi
genera el `collectionName` solo; los valores de abajo son los que produciría.
El `info.icon` es puramente cosmético.

### 3.1 `home/turist-section.json` → `home.turist-section`

```json
{
  "collectionName": "components_home_turist_sections",
  "info": {
    "displayName": "turist-section",
    "icon": "globe",
    "description": "Turismo médico: video + testimonial del CEO"
  },
  "options": {},
  "attributes": {
    "label": { "type": "string" },
    "title": { "type": "string" },
    "description": { "type": "text" },
    "videoId": { "type": "string" },
    "videoLabel": { "type": "string" },
    "quote": { "type": "text" },
    "ctaText": { "type": "string" },
    "ctaHref": { "type": "string" },
    "testimonial": {
      "type": "component",
      "component": "testimonial.testimonials",
      "repeatable": false
    }
  }
}
```

Notas:
- `videoId`/`videoLabel` van **planos a propósito**. Anidar `video-id.youtube-video` para
  dos strings agrega una tabla y un nivel de `populate` sin ganancia.
- `quote` se queda en el wrapper porque en el diseño actual es la cita destacada de la
  sección, separada del bloque de atribución del CEO (que sí es el `testimonial`).
  Si el frontend prefiere que la cita viva dentro del testimonial, borra `quote` de aquí
  y usa `testimonial.text`.

### 3.2 `home/videos-section.json` → `home.videos-section`

```json
{
  "collectionName": "components_home_videos_sections",
  "info": {
    "displayName": "videos-section",
    "icon": "cast",
    "description": "Carrusel de videos de YouTube"
  },
  "options": {},
  "attributes": {
    "title": { "type": "string" },
    "videos": {
      "type": "component",
      "component": "video-id.youtube-video",
      "repeatable": true
    }
  }
}
```

> ⚠️ El plan original decía "relation a videos". **No es posible**: los componentes solo
> pueden tener relaciones a *content types*, y `video-id.youtube-video` es un componente.
> Va como componente anidado repetible.

Hoy el título viene de `landingPageJson.videosSection.title` y la lista de
`pages.videos` (14 filas). El nuevo componente unifica ambos.

### 3.3 `home/promo-carousel.json` → `home.promo-carousel`

```json
{
  "collectionName": "components_home_promo_carousels",
  "info": {
    "displayName": "promo-carousel",
    "icon": "slideshow",
    "description": "Carrusel de promociones"
  },
  "options": {},
  "attributes": {
    "aspectRatio": {
      "type": "enumeration",
      "enum": ["square", "video", "portrait"],
      "default": "video"
    },
    "promos": {
      "type": "component",
      "component": "promo.promo",
      "repeatable": true
    }
  }
}
```

`aspectRatio` es un prop real de `promosection.tsx` que hoy está hardcodeado como
`aspectRatio="video"` en `app/page.tsx`. Aprovechamos para moverlo al CMS.

El wrapper **sí hace falta** aquí: sin él, cada promo sería una entrada independiente
de la DZ en lugar de un carrusel.

### 3.4 `home/alyus-feature.json` → `home.alyus-feature`

```json
{
  "collectionName": "components_home_alyus_features",
  "info": {
    "displayName": "alyus-feature",
    "icon": "apps",
    "description": "Feature con icono emoji"
  },
  "options": {},
  "attributes": {
    "icon": { "type": "string" },
    "title": { "type": "string" },
    "description": { "type": "text" }
  }
}
```

> 🔴 **Este componente existe porque `feature.features` NO sirve aquí.**
> `feature.features.icon` es un `enumeration` de 34 nombres de Lucide
> (`Stethoscope`, `Syringe`, …), pero los iconos reales de esta sección son **emojis**
> (`🧠`, `🔔`, `💊`, `🌎`) y `alyusSection.tsx:54` los renderiza como texto plano (`{f.icon}`).
> Un `enumeration` no los acepta.
>
> **Alternativa (decisión del frontend):** cambiar los 4 emojis por nombres de Lucide,
> renderizar con el mapa de iconos y reciclar `feature.features` (170 filas) en lugar de
> crear este componente. Ahorra un componente pero cambia el diseño visual.
>
> Ojo también: `description` aquí ≠ `desc` en el JSON actual. Ver mapeo en §6.

### 3.5 `home/chat-message.json` → `home.chat-message`

```json
{
  "collectionName": "components_home_chat_messages",
  "info": {
    "displayName": "chat-message",
    "icon": "message",
    "description": "Mensaje del chat demo de Alyus"
  },
  "options": {},
  "attributes": {
    "from": {
      "type": "enumeration",
      "enum": ["ai", "user"],
      "default": "ai",
      "required": true
    },
    "text": { "type": "text", "required": true }
  }
}
```

### 3.6 `home/alyus-section.json` → `home.alyus-section`

```json
{
  "collectionName": "components_home_alyus_sections",
  "info": {
    "displayName": "alyus-section",
    "icon": "discuss",
    "description": "Sección del asistente Alyus con chat demo"
  },
  "options": {},
  "attributes": {
    "badge": { "type": "string" },
    "label": { "type": "string" },
    "title": { "type": "string" },
    "description": { "type": "text" },
    "chatFooter": { "type": "string" },
    "ctaText": { "type": "string" },
    "ctaHref": { "type": "string" },
    "features": {
      "type": "component",
      "component": "home.alyus-feature",
      "repeatable": true
    },
    "messages": {
      "type": "component",
      "component": "home.chat-message",
      "repeatable": true
    }
  }
}
```

`badge` y `label` son **strings planos**, no el componente `badge.badge`
(`boldText`/`text`/`tag`): en los datos actuales son strings simples.

`alyusSection.tsx` también renderiza `PlanSectionAlt`, que lee del content type
`memberships`. No requiere nada en este componente.

### 3.7 `home/are-doctors-section.json` → `home.are-doctors-section`

```json
{
  "collectionName": "components_home_are_doctors_sections",
  "info": {
    "displayName": "are-doctors-section",
    "icon": "briefcase",
    "description": "Sección B2B para empresas y organizaciones"
  },
  "options": {},
  "attributes": {
    "badge": { "type": "string" },
    "title": { "type": "string" },
    "description": { "type": "text" },
    "ctaText": { "type": "string" },
    "ctaHref": { "type": "string" },
    "perks": {
      "type": "component",
      "component": "item.pill",
      "repeatable": true
    },
    "testimonial": {
      "type": "component",
      "component": "testimonial.testimonials",
      "repeatable": false
    }
  }
}
```

`perks` recicla `item.pill` (`text:string`) — los perks actuales son strings planos.
**No crear un cuarto componente de un solo campo de texto**: el proyecto ya tenía
`plus.plus`, `less.less` e `item.pill` idénticos y `less.less` acaba de borrarse por eso.

### 3.8–3.12 Los 5 componentes "marker"

> 🔴 **Strapi no permite guardar un componente con cero campos.** El plan original los
> definía sin campos; el Content-Type Builder lo va a rechazar.

Solución: un `title` opcional de override. Además de desbloquear, aporta valor real —
`hospitalsSection.tsx:18` tiene `"Hospitales en Ciudad Juárez"` y
`choose-category.tsx:14` tiene `"Categorías de la Farmacia"` **hardcodeados**.
`carousel-services` y `ClinicsClientWrapper` hoy no tienen heading; el campo queda
disponible por si se les quiere poner.

Para **deshabilitar** una sección, se quita de la Dynamic Zone. No hace falta un
booleano `enabled`.

```json
// home/clinics.json  → home.clinics
{
  "collectionName": "components_home_clinics",
  "info": { "displayName": "clinics", "icon": "house", "description": "Marcador: grid de clínicas" },
  "options": {},
  "attributes": { "title": { "type": "string" } }
}
```

```json
// home/carousel-services.json  → home.carousel-services
{
  "collectionName": "components_home_carousel_services",
  "info": { "displayName": "carousel-services", "icon": "stack", "description": "Marcador: carrusel de especialidades" },
  "options": {},
  "attributes": { "title": { "type": "string" } }
}
```

```json
// home/hospital-section.json  → home.hospital-section
{
  "collectionName": "components_home_hospital_sections",
  "info": { "displayName": "hospital-section", "icon": "heart", "description": "Marcador: hospitales" },
  "options": {},
  "attributes": { "title": { "type": "string" } }
}
```

```json
// home/choose-category.json  → home.choose-category
{
  "collectionName": "components_home_choose_categories",
  "info": { "displayName": "choose-category", "icon": "grid", "description": "Marcador: categorías de farmacia" },
  "options": {},
  "attributes": { "title": { "type": "string" } }
}
```

```json
// home/surgery-faq.json  → home.surgery-faq
{
  "collectionName": "components_home_surgery_faqs",
  "info": { "displayName": "surgery-faq", "icon": "question", "description": "Marcador: FAQ de cirugías" },
  "options": {},
  "attributes": { "title": { "type": "string" } }
}
```

**Alternativa si molesta el sprawl:** un solo `home.section-marker` con
`type:enumeration[clinics, carousel-services, hospitals, choose-category, surgery-faq]`
+ `title`. Colapsa 5 componentes (5 archivos, 5 tablas, 5 tipos generados) en 1.
Costo: peor UX en el selector de la DZ y un `switch` sobre `type` en vez de sobre
`__component`. Recomiendo los 5 separados por ser lo idiomático en Strapi, pero es
defendible al revés.

---

## 4. El Single Type

### `src/api/home-page/content-types/home-page/schema.json`

```json
{
  "kind": "singleType",
  "collectionName": "home_pages",
  "info": {
    "singularName": "home-page",
    "pluralName": "home-pages",
    "displayName": "Home Page",
    "description": "Landing principal del sitio (reemplaza pages[slug=front-page])"
  },
  "options": {
    "draftAndPublish": true
  },
  "pluginOptions": {},
  "attributes": {
    "seoTitle": { "type": "string" },
    "seoDescription": { "type": "text" },
    "sections": {
      "type": "dynamiczone",
      "components": [
        "hero.hero",
        "home.turist-section",
        "home.carousel-services",
        "home.clinics",
        "home.videos-section",
        "home.promo-carousel",
        "home.hospital-section",
        "home.choose-category",
        "home.alyus-section",
        "gallery.gallery",
        "home.surgery-faq",
        "home.are-doctors-section"
      ]
    }
  }
}
```

El orden de la lista es solo el orden del selector en el admin. **El orden de render
lo define el editor** al acomodar las entradas de la DZ.

Faltan también los archivos estándar de la API (`controllers`, `routes`, `services`);
si se crea por el Content-Type Builder, Strapi los genera.

### Orden actual de `app/page.tsx` (para reproducirlo al capturar el contenido)

```
1  TopContact ............... chrome, fuera de la DZ
2  hero.hero
3  CarouselTextBanner ....... hardcoded (locals/es), fuera de la DZ
4  home.turist-section
5  home.carousel-services
6  home.clinics
7  home.videos-section
8  home.promo-carousel
9  home.hospital-section
10 home.choose-category
11 home.alyus-section
12 gallery.gallery
13 home.surgery-faq
14 home.are-doctors-section
```

---

## 5. Cómo consultarlo desde el frontend

### 5.1 El query (Strapi 5)

> ⚠️ **`populate=*` NO funciona para Dynamic Zones.** Devuelve las entradas de la DZ
> pero sin sus media ni componentes anidados. Hay que usar la sintaxis `on`.

```ts
import qs from "qs";

const query = qs.stringify(
  {
    populate: {
      sections: {
        on: {
          "hero.hero": {
            populate: { image: { fields: ["url"] } },
          },
          "home.turist-section": {
            populate: { testimonial: true },
          },
          "home.videos-section": {
            populate: { videos: true },
          },
          "home.promo-carousel": {
            populate: { promos: { populate: { image: { fields: ["url"] } } } },
          },
          "home.alyus-section": {
            populate: { features: true, messages: true },
          },
          "gallery.gallery": {
            populate: { images: { fields: ["url"] } },
          },
          "home.are-doctors-section": {
            populate: { perks: true, testimonial: true },
          },
          "home.carousel-services": { fields: ["title"] },
          "home.clinics": { fields: ["title"] },
          "home.hospital-section": { fields: ["title"] },
          "home.choose-category": { fields: ["title"] },
          "home.surgery-faq": { fields: ["title"] },
        },
      },
    },
  },
  { encodeValuesOnly: true }
);

const res = await fetch(`${process.env.NEXT_PUBLIC_BACKEND_URL}/api/home-page?${query}`, {
  next: { revalidate: 3600 },
});
const { data } = await res.json();
```

Esto reemplaza **los 3 fetches** que hoy hace `getHomeData()` en `app/page.tsx` por uno.

### 5.2 Diferencias de forma en la respuesta

| | `pages` (collection) | `home-page` (single) |
|---|---|---|
| Forma | `{ data: [ {...} ] }` | `{ data: {...} }` |
| Acceso | `json.data?.[0]` | `json.data` |
| Si está vacío | `[]` | `null` |

Cada entrada de `sections` trae `__component` (ej. `"home.alyus-section"`) e `id`.

### 5.3 Tipos sugeridos

```ts
type Media = { url: string };

type HeroSection = {
  __component: "hero.hero";
  id: number;
  title?: string;
  description?: string;
  buttonText?: string;
  buttonUrl?: string;
  image?: Media | null;
};

type Testimonial = {
  id: number;
  name?: string;
  text?: string;
  role?: string;
  rating?: number | null;
};

type TuristSection = {
  __component: "home.turist-section";
  id: number;
  label?: string;
  title?: string;         // puede contener HTML → dangerouslySetInnerHTML
  description?: string;
  videoId?: string;
  videoLabel?: string;
  quote?: string;
  ctaText?: string;
  ctaHref?: string;
  testimonial?: Testimonial | null;
};

type VideosSection = {
  __component: "home.videos-section";
  id: number;
  title?: string;
  videos: { id: number; videoID: string; title?: string }[];
};

type PromoCarousel = {
  __component: "home.promo-carousel";
  id: number;
  aspectRatio?: "square" | "video" | "portrait";
  promos: { id: number; title?: string; link?: string; image?: Media | null }[];
};

type AlyusSection = {
  __component: "home.alyus-section";
  id: number;
  badge?: string;
  label?: string;
  title?: string;         // contiene HTML
  description?: string;
  chatFooter?: string;
  ctaText?: string;
  ctaHref?: string;
  features: { id: number; icon?: string; title?: string; description?: string }[];
  messages: { id: number; from: "ai" | "user"; text: string }[];
};

type GallerySection = {
  __component: "gallery.gallery";
  id: number;
  title?: string;
  images: Media[];
};

type AreDoctorsSection = {
  __component: "home.are-doctors-section";
  id: number;
  badge?: string;
  title?: string;         // contiene HTML
  description?: string;
  ctaText?: string;
  ctaHref?: string;
  perks: { id: number; text: string }[];
  testimonial?: Testimonial | null;
};

type MarkerSection = {
  __component:
    | "home.clinics"
    | "home.carousel-services"
    | "home.hospital-section"
    | "home.choose-category"
    | "home.surgery-faq";
  id: number;
  title?: string;
};

export type HomeSection =
  | HeroSection
  | TuristSection
  | VideosSection
  | PromoCarousel
  | AlyusSection
  | GallerySection
  | AreDoctorsSection
  | MarkerSection;

export type HomePage = {
  id: number;
  documentId: string;
  seoTitle?: string;
  seoDescription?: string;
  sections: HomeSection[];
};
```

Render con `switch (section.__component)` — la unión discriminada da narrowing completo.

### 5.4 No olvidar los permisos

Settings → Roles → **Public** → habilitar `find` en `api::home-page.home-page`.
Es el motivo #1 de un 403/404 con un query correcto.

---

## 6. Mapeo de datos actual → nuevo

Contenido real en prod (`pages` id=342 publicado / id=13 draft, slug `front-page`).

### `landingPageJson.turistSection` → `home.turist-section`

| JSON actual | Campo nuevo |
|---|---|
| `label` | `label` |
| `title` | `title` |
| `description` | `description` |
| `videoId` | `videoId` |
| `videoLabel` | `videoLabel` |
| `quote` | `quote` |
| `ctaText` | `ctaText` |
| `ctaHref` | `ctaHref` |
| `ceoName` | `testimonial.name` |
| `ceoRole` | `testimonial.role` |
| — | `testimonial.text` queda vacío (la cita está en `quote`) |

### `landingPageJson.areDoctorsSection` → `home.are-doctors-section`

| JSON actual | Campo nuevo |
|---|---|
| `badge`, `title`, `description`, `ctaText`, `ctaHref` | igual |
| `perks: string[]` (5 items) | `perks[].text` |
| `testimonial.quote` | `testimonial.text` ⚠️ cambia de nombre |
| `testimonial.name` | `testimonial.name` |
| `testimonial.role` | `testimonial.role` |

### `landingPageJson.videosSection` → `home.videos-section`

| Origen actual | Campo nuevo |
|---|---|
| `landingPageJson.videosSection.title` | `title` |
| `pages.videos` (componente, 14 filas) | `videos[]` |

### `landingPageJson.alyusSection` → `home.alyus-section`

| JSON actual | Campo nuevo |
|---|---|
| `badge`, `label`, `title`, `description`, `chatFooter`, `ctaText`, `ctaHref` | igual |
| `features[].icon` (emoji) | `features[].icon` |
| `features[].title` | `features[].title` |
| `features[].desc` | `features[].description` ⚠️ cambia de nombre |
| `messages[].from` | `messages[].from` |
| `messages[].text` | `messages[].text` |

### `pages[front-page]` → resto de la DZ

| Origen actual | Destino |
|---|---|
| `pages.hero` (componente `hero.hero`) | entrada `hero.hero` de la DZ |
| `pages.promo` (componente `promo.promo`) | `home.promo-carousel.promos[]` |
| `pages.gallery` (componente `gallery.gallery`) | entrada `gallery.gallery` de la DZ |

### 🐛 Bugs de contenido a corregir durante la migración

1. `alyusSection.title` = `"Habla cuando quieras,<br />con tu asistente médico</em>"`
   → tiene un `</em>` de cierre **sin apertura**. Se renderiza con
   `dangerouslySetInnerHTML`, así que hoy inyecta HTML malformado.
2. `areDoctorsSection.title` usa `<br />` — intencional, pero confirma que el campo
   debe seguir aceptando HTML inline.
3. `feature.features.icon` tiene un valor de enum `"HeartPulse,"` **con coma final**,
   que nunca hará match con un icono de Lucide. No afecta al home pero conviene
   arreglarlo si se toca ese componente.

---

## 7. Advertencias

### 7.1 No borrar nada de `pages` hasta terminar

`pages.hero` tiene 22 filas repartidas entre **todas** las páginas, no solo el home.
Borrar el campo `hero` de `pages` destruiría el hero de `doctores` y de
`lymbika-membership`, que lo usan hoy (`getPageHeroBySlug`).

Orden seguro: crear `home-page` → capturar contenido → apuntar el frontend →
verificar → *después* limpiar `front-page`.

### 7.2 `landingPageJson` no puede desaparecer de `pages`

Las 8 claves `doctores*` alimentan `/healthHubs`. Este proyecto solo deja muertas las
4 claves del home. Si el objetivo es eliminar los campos JSON del todo, `/healthHubs`
necesita el mismo tratamiento (8 secciones más) en un segundo proyecto.

### 7.3 `TopContact` y `CarouselTextBanner` quedan fuera de la DZ

Se renderizan antes/entre las secciones y hoy no vienen del CMS
(`CarouselTextBanner` lee de `locals/es`). Si se quiere que el editor controle el orden
completo de la página, harían falta 2 markers más. Si no, se dejan hardcodeados
alrededor del `.map()` de la DZ — pero entonces su posición es fija y el editor no la
puede mover.

### 7.4 Datos huérfanos detectados en `pages` (no bloquea, pero conviene saberlo)

Hay **9 slugs** en `pages` con `landingPageJson` poblado que **ningún route del
frontend consume**: 8 páginas de doctor (`dr-contreras`, `dr-escudero`, `dr-guinto`,
`dra-iracheta`, `dra-cecilia-torres`, `dr-adrian-martinez-ruiz`,
`dr-jorge-arturo-blanco`, `dra-laura-alejandra-marquez-duarte`) con las claves
`hero/footer/process/services/telephone/whyChoose/trustStrip/testimonials`, y
`medicos-en-juarez` con 11 claves.

No hay route catch-all (`app/[slug]`) ni fetch dinámico que los lea, y esas estructuras
**no están en `types/landingPageJson.ts`**. Puede ser contenido de una versión previa,
de una landing externa, o trabajo a medio terminar. **Confirmar antes de asumir que
`pages` se puede simplificar.**

---

## 8. Resumen de conteo

| | Plan original | Con reciclaje |
|---|---|---|
| Componentes a crear | 12 listados + 4 implícitos = **16** | **12** |
| Reciclados sin tocar | 0 | 5 |
| Reciclados con cambio aditivo | 0 | 1 (`testimonial.testimonials` + `role`) |

Con la variante del marker único serían **8** nuevos en vez de 12.

### Los 12 nuevos

`home.turist-section`, `home.videos-section`, `home.promo-carousel`,
`home.alyus-section`, `home.alyus-feature`, `home.chat-message`,
`home.are-doctors-section`, `home.clinics`, `home.carousel-services`,
`home.hospital-section`, `home.choose-category`, `home.surgery-faq`

---

## 9. Preguntas abiertas para el frontend

1. **`home.alyus-feature` vs `feature.features`** (§3.4) — ¿se mantienen los emojis
   (componente nuevo) o se migran a iconos de Lucide (reciclar y ahorrar un componente)?
2. **`quote` en `turist-section`** (§3.1) — ¿la cita destacada es independiente del
   testimonial del CEO, o se colapsa en `testimonial.text`?
3. **5 markers vs 1 `section-marker`** (§3.8) — trade-off de UX del editor vs sprawl.
4. **`TopContact` / `CarouselTextBanner`** (§7.3) — ¿entran a la DZ como markers?
5. **Los 9 slugs huérfanos** (§7.4) — ¿son contenido vivo en algún lado?
6. **Captura del contenido** — ¿a mano en el admin, o vale la pena un script que lea
   el `landingPageJson` actual y haga PUT al nuevo single type?
