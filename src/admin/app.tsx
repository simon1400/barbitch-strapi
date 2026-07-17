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

const ChecklistIcon = () => (
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
    <path d="M9 11l3 3L22 4" />
    <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
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

    // Homepage widget «Kontrola směny» — read-only самопроверка сегодняшней смены
    // для администраторов (расхождения календарь↔Strapi, неверные суммы, отсутствующие
    // записи + Rozdíl). НЕ публикует. Данные с /api/shift-selfcheck. try/catch —
    // чтобы смена Widgets API в будущих версиях не валила boot админки.
    try {
      (app as any).widgets.register({
        id: 'shift-selfcheck',
        icon: ChecklistIcon,
        title: {
          id: 'shift-selfcheck.widget.title',
          defaultMessage: 'Kontrola směny (dnes)',
        },
        component: async () => {
          const { default: Widget } = await import('./extensions/shiftSelfCheck/Widget');
          return Widget;
        },
      });
    } catch (e) {
      // Widgets API недоступен / изменился — тихо пропускаем.
    }
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
        /* Виджет «Kontrola směny»: убрать внутренний скролл (Strapi даёт <main>
           фикс-высоту 261px + overflow:auto) → растягиваем под содержимое. */
        main:has([data-bb-shift-selfcheck]) {
          height: auto !important;
          max-height: none !important;
          overflow: visible !important;
        }
      `;
      document.head.appendChild(style);
    }
  },
};
