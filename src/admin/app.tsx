import type { StrapiApp } from '@strapi/strapi/admin';
import React from 'react';

const DatabaseIcon = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <ellipse cx="12" cy="5" rx="9" ry="3" />
    <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
    <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
  </svg>
);

export default {
  config: {
    locales: [],
  },

  register(app: StrapiApp) {
    (app as any).addMenuLink({
      to: '/plugins/backup',
      icon: DatabaseIcon,
      intlLabel: {
        id: 'backup.plugin.name',
        defaultMessage: 'Backup',
      },
      Component: async () => {
        const { default: Page } = await import('./extensions/backup/BackupPage');
        return { default: Page };
      },
      permissions: [],
    });
  },

  bootstrap(_app: StrapiApp) {},
};
