export default ({ env }) => ({
  // Correo saliente: aviso a coordinación de cada caso nuevo
  // (src/api/case/utils/notificar-caso.ts). Va por el SMTP de Resend:
  // SMTP_HOST=smtp.resend.com, SMTP_USERNAME=resend, SMTP_PASSWORD=<API key>.
  // Sin SMTP_HOST no se configura y el aviso no se envía.
  ...(env('SMTP_HOST')
    ? {
        email: {
          config: {
            provider: 'nodemailer',
            providerOptions: {
              host: env('SMTP_HOST'),
              port: env.int('SMTP_PORT', 465),
              secure: env.int('SMTP_PORT', 465) === 465,
              auth: {
                user: env('SMTP_USERNAME'),
                pass: env('SMTP_PASSWORD'),
              },
            },
            settings: {
              defaultFrom: env('EMAIL_FROM'),
              defaultReplyTo: env('EMAIL_FROM'),
            },
          },
        },
      }
    : {}),
  upload: {
    config: {
      provider: 'aws-s3',
      providerOptions: {
        // Las URLs que Strapi guarda apuntan a CloudFront, no al bucket: S3
        // queda privado y todo el tráfico público pasa por el CDN.
        baseUrl: env('AWS_CDN_URL'),
        s3Options: {
          region: env('AWS_REGION'),
          credentials: {
            accessKeyId: env('AWS_ACCESS_KEY_ID'),
            secretAccessKey: env('AWS_SECRET_ACCESS_KEY'),
          },
          params: {
            Bucket: env('AWS_BUCKET'),
            // Obligatorio declararlo, aunque sea nulo. El provider rellena
            // ACL: public-read cuando la propiedad no existe, y el bucket
            // tiene los ACL desactivados: mandar la cabecera lo rompe con
            // AccessControlListNotSupported.
            ACL: null,
          },
        },
      },
      actionOptions: {
        upload: {},
        uploadStream: {},
        delete: {},
      },
    },
  },
});
