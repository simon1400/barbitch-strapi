// Cron-задачи Strapi. Подключаются в config/server.ts (cron.tasks).
// Дайджест шлётся только если заданы env TELEGRAM_DIGEST_BOT_TOKEN/CHAT_ID
// и NOONA_TOKEN/NOONA_COMPANY_ID — иначе тихий skip (см. сервис digest).

export default {
  // Синк-зеркало Noona → client/booking (own-booking фаза 1). Выключен по умолчанию:
  // включается ТОЛЬКО env MIRROR_SYNC_ENABLED=true (+ NOONA_TOKEN/NOONA_COMPANY_ID).
  // На проде без явного включения не запустится.
  mirrorSync: {
    task: async ({ strapi }) => {
      if (process.env.MIRROR_SYNC_ENABLED !== 'true') return;
      try {
        await strapi.service('api::booking-mirror.booking-mirror').syncRecent();
      } catch (e) {
        strapi.log.error(`booking-mirror cron failed: ${(e as Error).message}`);
      }
    },
    options: {
      rule: '*/10 * * * *', // каждые 10 минут
      tz: 'Europe/Prague',
    },
  },
  // Чистка протухших слот-холдов движка бронирования (own-booking). Безвредна
  // везде: до появления таблицы slot_holds сервис тихо возвращает 0.
  engineHoldsCleanup: {
    task: async ({ strapi }) => {
      try {
        await strapi.service('api::booking-engine.booking-engine').cleanupHolds();
      } catch (e) {
        strapi.log.error(`engine holds cleanup cron failed: ${(e as Error).message}`);
      }
    },
    options: {
      rule: '* * * * *', // каждую минуту
      tz: 'Europe/Prague',
    },
  },
  // Reminder T−24ч по броням ДВИЖКА (own-booking шаг 6). Выключен по умолчанию:
  // включается ТОЛЬКО env ENGINE_REMINDERS_ENABLED=true (+ RESEND_API_KEY для писем).
  // Идемпотентен (отметка remindersSent), зеркальные Noona-брони не трогает.
  engineReminders: {
    task: async ({ strapi }) => {
      if (process.env.ENGINE_REMINDERS_ENABLED !== 'true') return;
      try {
        await strapi.service('api::booking-engine.booking-notify').sendReminders();
      } catch (e) {
        strapi.log.error(`engine reminders cron failed: ${(e as Error).message}`);
      }
    },
    options: {
      rule: '*/15 * * * *', // каждые 15 минут
      tz: 'Europe/Prague',
    },
  },
  // Лояльность bitchcard (К3): начисление копилки по checkedOut-броням окна
  // последних дней (идемпотентно по bookingDocId) + авто-награды при пересечении
  // порогов + expire-проход. Выключено по умолчанию: ТОЛЬКО env LOYALTY_ENABLED=true.
  loyaltyDaily: {
    task: async ({ strapi }) => {
      if (process.env.LOYALTY_ENABLED !== 'true') return;
      try {
        const res = await strapi.service('api::loyalty.loyalty').runDaily();
        strapi.log.info(
          `loyalty daily: +${res.created} tx (${res.skipped} skip), redemptions +${res.redemptionsCreated}, expired ${res.expired}`
        );
      } catch (e) {
        strapi.log.error(`loyalty daily cron failed: ${(e as Error).message}`);
      }
    },
    options: {
      rule: '30 4 * * *', // каждый день в 04:30 (после закрытия смены, до дайджеста)
      tz: 'Europe/Prague',
    },
  },
  // Comeback-напоминание «пора записаться снова» (~25 дней после последнего визита,
  // s155). Выключено по умолчанию: ТОЛЬКО env COMEBACK_REMINDER_ENABLED=true
  // (+ RESEND_API_KEY для реальной отправки). Идемпотентно (comeback-reminder-log),
  // защиты: будущая бронь / поздний визит / opt-out / blacklist / кулдаун / дневной кап.
  comebackReminders: {
    task: async ({ strapi }) => {
      if (process.env.COMEBACK_REMINDER_ENABLED !== 'true') return;
      try {
        const res = await strapi.service('api::comeback-reminder.comeback-reminder').run();
        if (res.candidates > 0) {
          strapi.log.info(
            `comeback reminders: ${res.sent} sent / ${res.candidates} candidates`
          );
        }
      } catch (e) {
        strapi.log.error(`comeback reminders cron failed: ${(e as Error).message}`);
      }
    },
    options: {
      rule: '0 11 * * *', // каждый день в 11:00 (салон уже открыт, после дайджеста 08:00)
      tz: 'Europe/Prague',
    },
  },
  // Просьба оставить отзыв на Google — вечером того же дня, только клиентам
  // с 2+ завершёнными визитами. Выключено по умолчанию: ТОЛЬКО env
  // REVIEW_REQUEST_ENABLED=true (+ RESEND_API_KEY для реальной отправки и
  // GOOGLE_PLACE_ID / REVIEW_LINK_URL для ссылки — без ссылки прогон no-op).
  // Идемпотентно (review-request-log), защиты: opt-out / blacklist / поздний визит /
  // кулдаун ~год / дневной кап (пачка отзывов за день = флаг для антиспама Google).
  reviewRequests: {
    task: async ({ strapi }) => {
      if (process.env.REVIEW_REQUEST_ENABLED !== 'true') return;
      try {
        const res = await strapi.service('api::review-request.review-request').run();
        if (res.candidates > 0) {
          strapi.log.info(`review requests: ${res.sent} sent / ${res.candidates} candidates`);
        }
      } catch (e) {
        strapi.log.error(`review requests cron failed: ${(e as Error).message}`);
      }
    },
    options: {
      // 20:00 Праги: впечатление ещё свежее, но все дневные чекауты уже сделаны
      // (последние визиты кончаются ~19:45; закрытые лишь утром уйдут след. вечером)
      rule: '0 20 * * *',
      tz: 'Europe/Prague',
    },
  },
  // Плановый график мастеров (s218): довести блоки плана до окна записи. Окно
  // (последняя дата salon_hours) сдвигается каждую ночь синком часов салона, часы
  // салона могут поправить в CM — поэтому раз в час. Идемпотентно: без изменений
  // плана и часов — ноль записей.
  masterScheduleReconcile: {
    task: async ({ strapi }) => {
      try {
        const res = await strapi.service('api::booking-engine.master-schedule').reconcileAll();
        if (res.created || res.deleted) {
          strapi.log.info(`master-schedule cron: +${res.created} −${res.deleted} plan block(s) / ${res.schedules} plan(s)`);
        }
      } catch (e) {
        strapi.log.error(`master-schedule cron failed: ${(e as Error).message}`);
      }
    },
    options: {
      rule: '20 * * * *', // каждый час в :20
      tz: 'Europe/Prague',
    },
  },
  // Офлайн-конверсии Google Ads (s243): закрытые визиты с согласием на cookies →
  // действие «Návštěva – uskutečněná (server-side)» через Data Manager API. Выключено
  // по умолчанию: ТОЛЬКО env ADS_VISIT_CONVERSIONS_ENABLED=true (+ GOOGLE_DM_* как у
  // client и GOOGLE_DM_CONVERSION_ACTION_VISIT; без них прогон no-op). Пробный режим —
  // GOOGLE_DM_VALIDATE_ONLY=true. Идемпотентно (журнал booking.adsConversion).
  adsVisitConversions: {
    task: async ({ strapi }) => {
      if (process.env.ADS_VISIT_CONVERSIONS_ENABLED !== 'true') return;
      try {
        const res = await strapi.service('api::booking-engine.ads-conversions').run();
        if (res.candidates || res.skipped > 0 || res.reverted) {
          strapi.log.info(`ads visit conversions: ${JSON.stringify(res)}`);
        }
      } catch (e) {
        strapi.log.error(`ads visit conversions cron failed: ${(e as Error).message}`);
      }
    },
    options: {
      // каждый час в :40 — визиты закрывают в течение дня и утром следующего
      rule: '40 * * * *',
      tz: 'Europe/Prague',
    },
  },
  // Push управляющей (s247, MANAGER_UX_NEXT_SESSION_PROMPT.md §5): напоминания о výkazu и блоки,
  // ждущие подтверждения. Выключено по умолчанию: ТОЛЬКО env MANAGER_PUSH_ENABLED=true (+ VAPID
  // ключи — без них прогон no-op). Пуши-события (поручения, отправленный výkaz) — без этого флага.
  managerReportReminderEvening: {
    task: async ({ strapi }) => {
      if (process.env.MANAGER_PUSH_ENABLED !== 'true') return;
      try {
        await strapi.service('api::booking-engine.manager-notify').remindReports({ kind: 'evening' });
      } catch (e) {
        strapi.log.error(`manager report reminder (evening) cron failed: ${(e as Error).message}`);
      }
    },
    options: {
      rule: '0 21 * * 1-5', // будни 21:00 — výkaz за сегодня ещё не отправлен
      tz: 'Europe/Prague',
    },
  },
  managerReportReminderMorning: {
    task: async ({ strapi }) => {
      if (process.env.MANAGER_PUSH_ENABLED !== 'true') return;
      try {
        await strapi.service('api::booking-engine.manager-notify').remindReports({ kind: 'morning' });
      } catch (e) {
        strapi.log.error(`manager report reminder (morning) cron failed: ${(e as Error).message}`);
      }
    },
    options: {
      rule: '0 9 * * 2-6', // вт–сб 09:00 — за вчера (до 10:00 ещё вовремя)
      tz: 'Europe/Prague',
    },
  },
  managerAgingBlocks: {
    task: async ({ strapi }) => {
      if (process.env.MANAGER_PUSH_ENABLED !== 'true') return;
      try {
        const res = await strapi.service('api::booking-engine.manager-notify').pushAgingBlocks();
        if (res.due) strapi.log.info(`manager aging blocks: ${JSON.stringify(res)}`);
      } catch (e) {
        strapi.log.error(`manager aging blocks cron failed: ${(e as Error).message}`);
      }
    },
    options: {
      rule: '5 8-22 * * *', // каждый час в :05 с 08 до 22 — ждёт подтверждения > 6 ч (один раз)
      tz: 'Europe/Prague',
    },
  },
  managerPendingBlocksReminder: {
    task: async ({ strapi }) => {
      if (process.env.MANAGER_PUSH_ENABLED !== 'true') return;
      try {
        await strapi.service('api::booking-engine.manager-notify').remindPendingBlocks();
      } catch (e) {
        strapi.log.error(`manager pending blocks cron failed: ${(e as Error).message}`);
      }
    },
    options: {
      rule: '0 10 * * *', // каждый день 10:00 — всё, что ждёт дольше суток
      tz: 'Europe/Prague',
    },
  },
  // Склад (s252, STOCK_NEXT_SESSION_PROMPT.md Фаза 2): сводка управляющей 10:00 (новые «málo/došlo»,
  // заказы не пришли в срок, по понедельникам — давно не считали) и владельцу (просроченные заказы);
  // понедельник 10:00 — «Rychlá inventura» администраторам, 19:00 — не сделана → управляющей + запись
  // в журнал (строка в её výkazu). Выключено по умолчанию: ТОЛЬКО env STOCK_PUSH_ENABLED=true
  // (+ VAPID — без них push no-op). Тот же env гасит и push-события склада.
  stockDaily: {
    task: async ({ strapi }) => {
      if (process.env.STOCK_PUSH_ENABLED !== 'true') return;
      try {
        const res = await strapi.service('api::booking-engine.stock-notify').daily();
        if (res.items || res.overdue || res.stale) strapi.log.info(`stock daily: ${JSON.stringify(res)}`);
      } catch (e) {
        strapi.log.error(`stock daily cron failed: ${(e as Error).message}`);
      }
    },
    options: {
      rule: '0 10 * * *', // каждый день 10:00
      tz: 'Europe/Prague',
    },
  },
  stockInventoryStart: {
    task: async ({ strapi }) => {
      if (process.env.STOCK_PUSH_ENABLED !== 'true') return;
      try {
        await strapi.service('api::booking-engine.stock-notify').inventoryStart();
      } catch (e) {
        strapi.log.error(`stock inventory start cron failed: ${(e as Error).message}`);
      }
    },
    options: {
      rule: '0 10 * * 1', // понедельник 10:00 — решение владельца §0.6
      tz: 'Europe/Prague',
    },
  },
  stockInventoryEscalate: {
    task: async ({ strapi }) => {
      if (process.env.STOCK_PUSH_ENABLED !== 'true') return;
      try {
        const res = await strapi.service('api::booking-engine.stock-notify').inventoryEscalate();
        if (res.remaining) strapi.log.info(`stock inventory missed: ${JSON.stringify(res)}`);
      } catch (e) {
        strapi.log.error(`stock inventory escalate cron failed: ${(e as Error).message}`);
      }
    },
    options: {
      rule: '0 19 * * 1', // понедельник 19:00 — не сделана до вечера → управляющей
      tz: 'Europe/Prague',
    },
  },
  dailyDigest: {
    task: async ({ strapi }) => {
      try {
        await strapi.service('api::digest.digest').sendDigest();
      } catch (e) {
        strapi.log.error(`daily digest cron failed: ${(e as Error).message}`);
      }
    },
    options: {
      rule: '0 8 * * *', // каждый день в 08:00
      tz: 'Europe/Prague',
    },
  },
};
