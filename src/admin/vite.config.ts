import { mergeConfig, type UserConfig } from 'vite';

export default (config: UserConfig) => {
  // Important: always return the modified config.
  return mergeConfig(config, {
    // strapi-plugin-bulk-editor (spreadsheet bulk edit in Content Manager) commonly
    // triggers an ESM/CommonJS interop error in Strapi 5 admin ("does not provide an
    // export named 'flushSync'" / lodash) that white-screens the admin. The plugin's
    // documented fix is to pre-bundle these deps. Harmless if unneeded.
    optimizeDeps: {
      include: ['react-dom', 'lodash'],
    },
  });
};
