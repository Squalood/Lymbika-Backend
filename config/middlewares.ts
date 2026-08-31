// El admin carga las miniaturas de la Media Library desde el CDN, asi que su
// dominio tiene que estar en el CSP o el navegador las bloquea sin decir nada.
// Se deriva de AWS_CDN_URL para no hardcodearlo: al pasar a un dominio propio
// basta cambiar la variable de entorno.
const dominioCdn = (() => {
  try {
    return new URL(process.env.AWS_CDN_URL).host;
  } catch {
    return null;
  }
})();

const origenesMedia = ["'self'", 'data:', 'blob:', 'market-assets.strapi.io', dominioCdn].filter(
  Boolean,
);

export default [
  'strapi::logger',
  'strapi::errors',
  {
    name: 'strapi::security',
    config: {
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          'connect-src': ["'self'", 'https:'],
          'img-src': origenesMedia,
          'media-src': origenesMedia,
          upgradeInsecureRequests: null,
        },
      },
    },
  },
  'strapi::cors',
  'strapi::poweredBy',
  'strapi::query',
  'strapi::body',
  {
    name: 'strapi::session',
    config: {
      secure: false,
      sameSite: false,
    },
  },
  'strapi::favicon',
  'strapi::public',
];
