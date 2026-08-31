import path from 'path';

/**
 * Lee una variable obligatoria. Sin valor por defecto a propósito: un fallback
 * silencioso es lo que hizo que las credenciales de Neon acabaran commiteadas
 * en este archivo. Si falta la variable, que reviente el arranque con un
 * mensaje claro en vez de conectarse a algo inesperado.
 */
const required = (env, key: string): string => {
  const value = env(key);
  if (!value) {
    throw new Error(
      `[database] Falta la variable de entorno ${key}. ` +
        `Definila en .env para desarrollo, o en Environment del servicio en Render para producción.`,
    );
  }
  return value;
};

export default ({ env }) => {
  const client = env('DATABASE_CLIENT', 'postgres');

  // Cada conexión se construye sólo si es la que se va a usar: así trabajar en
  // local con sqlite no exige tener configuradas las credenciales de postgres.
  const connections = {
    mysql: () => ({
      connection: {
        host: required(env, 'DATABASE_HOST'),
        port: env.int('DATABASE_PORT', 3306),
        database: required(env, 'DATABASE_NAME'),
        user: required(env, 'DATABASE_USERNAME'),
        password: required(env, 'DATABASE_PASSWORD'),
        ssl: env.bool('DATABASE_SSL', false) && {
          key: env('DATABASE_SSL_KEY', undefined),
          cert: env('DATABASE_SSL_CERT', undefined),
          ca: env('DATABASE_SSL_CA', undefined),
          capath: env('DATABASE_SSL_CAPATH', undefined),
          cipher: env('DATABASE_SSL_CIPHER', undefined),
          rejectUnauthorized: env.bool('DATABASE_SSL_REJECT_UNAUTHORIZED', true),
        },
      },
      pool: { min: env.int('DATABASE_POOL_MIN', 2), max: env.int('DATABASE_POOL_MAX', 10) },
    }),

    postgres: () => {
      const connectionString = env('DATABASE_URL');

      // Con DATABASE_URL alcanza; si no, hacen falta los campos sueltos.
      const credentials = connectionString
        ? { connectionString }
        : {
            host: required(env, 'DATABASE_HOST'),
            port: env.int('DATABASE_PORT', 5432),
            database: required(env, 'DATABASE_NAME'),
            user: required(env, 'DATABASE_USERNAME'),
            password: required(env, 'DATABASE_PASSWORD'),
          };

      return {
        connection: {
          ...credentials,
          ssl: env.bool('DATABASE_SSL', false) && {
            key: env('DATABASE_SSL_KEY', undefined),
            cert: env('DATABASE_SSL_CERT', undefined),
            ca: env('DATABASE_SSL_CA', undefined),
            capath: env('DATABASE_SSL_CAPATH', undefined),
            cipher: env('DATABASE_SSL_CIPHER', undefined),
            rejectUnauthorized: env.bool('DATABASE_SSL_REJECT_UNAUTHORIZED', false),
          },
          schema: env('DATABASE_SCHEMA', 'public'),
        },
        pool: { min: env.int('DATABASE_POOL_MIN', 2), max: env.int('DATABASE_POOL_MAX', 10) },
      };
    },

    sqlite: () => ({
      connection: {
        filename: path.join(__dirname, '..', '..', env('DATABASE_FILENAME', '.tmp/data.db')),
      },
      useNullAsDefault: true,
    }),
  };

  const build = connections[client];
  if (!build) {
    throw new Error(
      `[database] DATABASE_CLIENT="${client}" no está soportado. Usá: ${Object.keys(connections).join(', ')}.`,
    );
  }

  return {
    connection: {
      client,
      ...build(),
      acquireConnectionTimeout: env.int('DATABASE_CONNECTION_TIMEOUT', 60000),
    },
  };
};
