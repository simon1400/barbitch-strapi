import type { StrapiApp } from '@strapi/strapi/admin';
import React from 'react';
import { ServiceMoneyPanel } from './extensions/serviceMoneyHint/ServiceMoneyHint';

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

const ClockIcon = () => (
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
    <circle cx="12" cy="12" r="10" />
    <polyline points="12 6 12 12 16 14" />
  </svg>
);

export default {
  config: {
    locales: [],
  },

  register(app: StrapiApp) {
    // Trimmed time dropdown (08:00..21:00) for work-time start/end. App-level custom field
    // → uid `global::time-slot` (server side registered in src/index.ts). Stores "HH:MM".
    (app as any).customFields.register({
      name: 'time-slot',
      type: 'string',
      intlLabel: { id: 'time-slot.label', defaultMessage: 'Время (слот)' },
      intlDescription: {
        id: 'time-slot.description',
        defaultMessage: 'Время из расписания салона (08:00–21:00)',
      },
      icon: ClockIcon,
      components: {
        Input: async () =>
          import('./extensions/timeSlot/TimeSlotInput').then((m) => ({ default: m.default })),
      },
    });

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

  bootstrap(app: StrapiApp) {
    // Money hint side panel in the "Оказанные услуги" Edit view — mirrors the
    // verifyFlags math and shows recommended "Цена мастера" / "Прибыль салона"
    // so the admin doesn't compute on a calculator. Display-only (no auto-fill).
    try {
      (app as any)
        .getPlugin('content-manager')
        .apis.addEditViewSidePanel((panels: any[]) => [...panels, ServiceMoneyPanel]);
    } catch (e) {
      // content-manager plugin not ready / API changed — fail silently, don't break admin boot.
    }

    // Make relation/combobox option dropdowns ~3× taller. The design-system caps the
    // scrollable options list at max-height: 15rem (~3 visible rows). We override the
    // scroll container (direct parent of [role="listbox"]) and the listbox itself.
    if (typeof document !== 'undefined') {
      const style = document.createElement('style');
      style.setAttribute('data-barbitch', 'taller-relation-dropdown');
      style.textContent = `
        [role="listbox"],
        :has(> [role="listbox"]) {
          max-height: min(45rem, 70vh) !important;
        }
      `;
      document.head.appendChild(style);
    }
  },
};
