export default ({ env }) => ({
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
