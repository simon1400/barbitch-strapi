export default ({env}) => ({
  backup: {
    enabled: true,
    resolve: './src/plugins/backup',
  },
  imagekit: {
    enabled: true,
    config: {
      publicKey: env('IMAGEKIT_PUBLIC_KEY'),
      privateKey: env('IMAGEKIT_PRIVATE_KEY'),
      urlEndpoint: env('IMAGEKIT_URL_ENDPOINT'),
      uploadEnabled: true,
      useTransformUrls: true,
    },
  },
  'strapi-plugin-required-relation-field': {
    enabled: true,
  },
  "bulk-editor": {
    enabled: true,
  },
  // 'document-metadata' — НЕ внешний плагин, а внутренний сервис @strapi/content-manager
  // (грузится автоматически). Конфиг-запись была ошибочной и ломала загрузку плагинов.
  // 'document-metadata': {
  //   enabled: true,
  // },
  // 'publisher' (strapi-plugin-publisher) — пакет удалён из node_modules.
  // Чтобы вернуть отложенную публикацию: npm i strapi-plugin-publisher и раскомментировать.
  // 'publisher': {
  // 	enabled: true,
  // },
});
