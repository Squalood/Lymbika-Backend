module.exports = {
    'strapi-neon-tech-db-branches': {
      enabled: true,
      config: {
        neonApiKey: "napi_pz764g7eu75gw20jgyka586m0xbzkle0hmkwnbr87s2locmkmxm2q3rsnkchs8n2", // get it from here: https://console.neon.tech/app/settings/api-keys
        neonProjectName: "lymbika", // the neon project under wich your DB runs
        neonRole: "neondb_owner", // create it manually under roles for your project first
        gitBranch: "main", // branch can be pinned via this config option. Will not use branch from git then. Usefull for preview/production deployment
      }
    },
  };