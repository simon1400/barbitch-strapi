export default ({env}) => ({
  // Disable all plugins temporarily to test
  imagekit: {
    enabled: false,
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
