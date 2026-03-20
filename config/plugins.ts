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
  ckeditor: {
    enabled: false,
  },
  'gpt-5': {
    enabled: false,
  },
  'required-relation-field': {
    enabled: false,
  },
  'responsive-backend': {
    enabled: false,
  },
});
