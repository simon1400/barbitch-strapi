// Роуты движка бронирования (content-api → авто-префикс /api).
// auth:false везде: публичные защищает rate-limit, админские — ручной admin-jwt
// в контроллере (Strapi-стратегии наш HS256-токен не знают, паттерн s78/s93).

const pub = (method: string, path: string, handler: string) => ({
  method,
  path,
  handler,
  config: { auth: false, policies: [], middlewares: ['global::rate-limit-engine'] },
});

const admin = (method: string, path: string, handler: string) => ({
  method,
  path,
  handler,
  config: { auth: false, policies: [], middlewares: [] },
});

export default {
  routes: [
    pub('GET', '/engine/services', 'booking-engine.listServices'),
    pub('GET', '/engine/services/:id', 'booking-engine.getService'),
    pub('GET', '/engine/services/:id/employees', 'booking-engine.listServiceEmployees'),
    pub('GET', '/engine/availability', 'booking-engine.availability'),
    pub('POST', '/engine/holds', 'booking-engine.createHold'),
    pub('GET', '/engine/holds/:id', 'booking-engine.getHold'),
    pub('POST', '/engine/bookings', 'booking-engine.createBooking'),
    pub('GET', '/engine/cancel/:token', 'booking-engine.getCancel'),
    pub('POST', '/engine/cancel/:token', 'booking-engine.postCancel'),
    // дозапись с thank-you: предложения услуг других категорий в окно сразу после брони (−15%)
    pub('GET', '/engine/rebook/:token/offers', 'booking-engine.rebookOffers'),
    pub('POST', '/engine/rebook/:token', 'booking-engine.rebookCreate'),
    // управление бронью клиентом (страница /rezervace/{token}: перенос термина + отмена)
    pub('GET', '/engine/manage/:token', 'booking-engine.getManage'),
    pub('GET', '/engine/manage/:token/availability', 'booking-engine.manageAvailability'),
    pub('POST', '/engine/manage/:token/reschedule', 'booking-engine.postReschedule'),
    // сервисные ручки нотификаций (гейт секретом DIGEST_SECRET в контроллере, паттерн digest)
    admin('GET', '/engine/notify/preview', 'booking-engine.notifyPreview'),
    admin('POST', '/engine/notify/run-reminders', 'booking-engine.notifyRunReminders'),
    // Web Push (PWA мастеров): публичный VAPID-ключ + подписка/отписка устройства
    pub('GET', '/engine/push/vapid', 'booking-engine.pushVapid'),
    admin('POST', '/engine/push/subscribe', 'booking-engine.pushSubscribe'),
    admin('POST', '/engine/push/unsubscribe', 'booking-engine.pushUnsubscribe'),
    // день календаря: единственный источник броней для сетки. Для роли master
    // сервер вырезает контакты клиентов и деньги ЧУЖИХ броней — раньше админка
    // тянула /api/bookings напрямую и всё это приезжало в браузер мастера.
    admin('GET', '/engine/admin/calendar/day', 'booking-engine.adminCalendarDay'),
    admin('GET', '/engine/admin/calendar/week', 'booking-engine.adminCalendarWeek'),
    admin('GET', '/engine/admin/clients/history', 'booking-engine.adminClientHistory'),
    // аналитика: вся история броней и список клиентов одним сжатым ответом вместо
    // десятка постраничных запросов админки к /api/bookings и /api/clients
    admin('GET', '/engine/admin/analytics/history', 'booking-engine.adminAnalyticsHistory'),
    admin('GET', '/engine/admin/analytics/clients', 'booking-engine.adminAnalyticsClients'),
    admin('POST', '/engine/admin/bookings', 'booking-engine.adminCreateBooking'),
    admin('PATCH', '/engine/admin/bookings/:id', 'booking-engine.adminPatchBooking'),
    admin('DELETE', '/engine/admin/bookings/:id', 'booking-engine.adminDeleteBooking'),
    // закрытие визита из календаря (D2): запись «Оказанная услуга» по брони
    admin('GET', '/engine/admin/bookings/:id/checkout', 'booking-engine.adminCheckoutGet'),
    admin('POST', '/engine/admin/bookings/:id/checkout', 'booking-engine.adminCheckoutCreate'),
    admin('PATCH', '/engine/admin/checkout/:id', 'booking-engine.adminCheckoutPatch'),
    admin('DELETE', '/engine/admin/checkout/:id', 'booking-engine.adminCheckoutDelete'),
    // бесплатная коррекция (s210): визиты клиента для селекта «Korekce po návštěvě»
    admin('GET', '/engine/admin/bookings/:id/korekce-candidates', 'booking-engine.adminKorekceCandidates'),
    // лояльность bitchcard в календаре: награды клиента брони + применить/снять скидку по коду
    admin('GET', '/engine/admin/bookings/:id/redemptions', 'booking-engine.adminBookingRedemptions'),
    admin('POST', '/engine/admin/bookings/:id/redemption', 'booking-engine.adminApplyRedemption'),
    admin('DELETE', '/engine/admin/bookings/:id/redemption', 'booking-engine.adminReleaseRedemption'),
    // скидка дозаписи (rebook −15%): снять / вернуть из drawer календаря
    admin('POST', '/engine/admin/bookings/:id/rebook-discount', 'booking-engine.adminRestoreRebookDiscount'),
    admin('DELETE', '/engine/admin/bookings/:id/rebook-discount', 'booking-engine.adminRemoveRebookDiscount'),
    // модуль «Дозаписи администраторов» (s197): кандидаты дня, дозапись −10 % с
    // черновиком комиссии администратору, «мои дозаписи» за месяц
    admin('GET', '/engine/admin/upsell/day', 'booking-engine.adminUpsellDay'),
    admin('POST', '/engine/admin/upsell', 'booking-engine.adminUpsellCreate'),
    admin('GET', '/engine/admin/upsell/mine', 'booking-engine.adminUpsellMine'),
    admin('POST', '/engine/admin/upsell/result', 'booking-engine.adminUpsellResult'),
    admin('GET', '/engine/admin/upsell/report', 'booking-engine.adminUpsellReport'),
    // «Источники броней» (s200): откуда пришли брони, новые клиенты и их выручка
    admin('GET', '/engine/admin/attribution/report', 'booking-engine.adminAttributionReport'),
    // дашборд «Сегодня» (s214): что требует внимания руководства
    admin('GET', '/engine/admin/today', 'booking-engine.adminToday'),
    // дни рождения сотрудников (s221): ближайшие 30 дней, без года рождения
    admin('GET', '/engine/admin/birthdays', 'booking-engine.adminBirthdays'),
    admin('GET', '/engine/admin/my-month', 'booking-engine.adminMyMonth'),
    // корректировки зарплат (s215): штрафы, доп. заработок, списания, авансы, выплаты
    admin('GET', '/engine/admin/corrections', 'booking-engine.adminCorrectionsList'),
    admin('POST', '/engine/admin/corrections', 'booking-engine.adminCorrectionCreate'),
    admin('DELETE', '/engine/admin/corrections/:kind/:id', 'booking-engine.adminCorrectionDelete'),
    // Затраты салона (s236): руководство; правка/удаление — владелец, управляющая — запросом
    admin('GET', '/engine/admin/costs', 'booking-engine.adminCostsList'),
    admin('GET', '/engine/admin/costs/suggest', 'booking-engine.adminCostsSuggest'),
    admin('POST', '/engine/admin/costs', 'booking-engine.adminCostCreate'),
    admin('PATCH', '/engine/admin/costs/:id', 'booking-engine.adminCostUpdate'),
    admin('DELETE', '/engine/admin/costs/:id', 'booking-engine.adminCostDelete'),
    admin('POST', '/engine/admin/costs/:id/requests', 'booking-engine.adminCostRequest'),
    admin('DELETE', '/engine/admin/costs/requests/:rid', 'booking-engine.adminCostRequestCancel'),
    admin('POST', '/engine/admin/costs/requests/:rid/approve', 'booking-engine.adminCostRequestApprove'),
    admin('POST', '/engine/admin/costs/requests/:rid/reject', 'booking-engine.adminCostRequestReject'),
    // Фаза 2 (s237): повтор прошлого месяца, сигналы «Сегодня», чеки (закрытый каталог)
    admin('GET', '/engine/admin/costs/recurring', 'booking-engine.adminCostsRecurring'),
    admin('POST', '/engine/admin/costs/batch', 'booking-engine.adminCostsBatch'),
    admin('GET', '/engine/admin/costs/attention', 'booking-engine.adminCostsAttention'),
    admin('POST', '/engine/admin/costs/:id/files', 'booking-engine.adminCostFileUpload'),
    admin('GET', '/engine/admin/costs/:id/files/:fid', 'booking-engine.adminCostFileDownload'),
    admin('DELETE', '/engine/admin/costs/:id/files/:fid', 'booking-engine.adminCostFileDelete'),
    // Фаза 3 (s238): сверка с кассой, чеки месяца одним ZIP
    admin('GET', '/engine/admin/costs/cash-check', 'booking-engine.adminCostsCashCheck'),
    admin('POST', '/engine/admin/costs/cash-check/skips', 'booking-engine.adminCostsCashSkip'),
    admin('DELETE', '/engine/admin/costs/cash-check/skips/:sid', 'booking-engine.adminCostsCashUnskip'),
    admin('GET', '/engine/admin/costs/receipts', 'booking-engine.adminCostsReceiptsZip'),
    // «Výkaz práce» (s239): свой отчёт — управляющая, все отчёты и отметки — владелец
    admin('GET', '/engine/admin/work-reports/mine', 'booking-engine.adminWorkReportsMine'),
    admin('PUT', '/engine/admin/work-reports/mine/:date', 'booking-engine.adminWorkReportSave'),
    admin('POST', '/engine/admin/work-reports/mine/:date/comments', 'booking-engine.adminWorkReportComment'),
    admin('GET', '/engine/admin/work-reports/attention', 'booking-engine.adminWorkReportsAttention'),
    admin('GET', '/engine/admin/work-reports', 'booking-engine.adminWorkReportsList'),
    admin('POST', '/engine/admin/work-reports/:id/review', 'booking-engine.adminWorkReportReview'),
    admin('POST', '/engine/admin/shift-close/journal', 'booking-engine.adminShiftCloseJournal'),
    // поручения владельца управляющей (s240): `attention` — раньше `/:id`
    admin('GET', '/engine/admin/tasks/attention', 'booking-engine.adminTasksAttention'),
    admin('GET', '/engine/admin/tasks', 'booking-engine.adminTasksList'),
    admin('POST', '/engine/admin/tasks', 'booking-engine.adminTaskCreate'),
    admin('PATCH', '/engine/admin/tasks/:id', 'booking-engine.adminTaskUpdate'),
    admin('POST', '/engine/admin/tasks/:id/actions', 'booking-engine.adminTaskAction'),
    admin('POST', '/engine/admin/tasks/:id/files', 'booking-engine.adminTaskFileUpload'),
    admin('GET', '/engine/admin/tasks/:id/files/:fid', 'booking-engine.adminTaskFileDownload'),
    admin('DELETE', '/engine/admin/tasks/:id/files/:fid', 'booking-engine.adminTaskFileDelete'),
    // Отпуска / больничные + автоблоки мастеру (s216) — только руководство
    admin('GET', '/engine/admin/time-offs/conflicts', 'booking-engine.adminTimeOffConflicts'),
    admin('POST', '/engine/admin/time-offs', 'booking-engine.adminTimeOffCreate'),
    admin('PATCH', '/engine/admin/time-offs/:id', 'booking-engine.adminTimeOffUpdate'),
    admin('DELETE', '/engine/admin/time-offs/:id', 'booking-engine.adminTimeOffDelete'),
    // Смены администраторов (s217): редактор графика недели — только руководство
    admin('GET', '/engine/admin/shifts', 'booking-engine.adminShiftsList'),
    admin('PUT', '/engine/admin/shifts/:monday', 'booking-engine.adminShiftSave'),
    admin('DELETE', '/engine/admin/shifts/:monday', 'booking-engine.adminShiftDelete'),
    // Плановый график мастеров (s218): смотреть и предлагать — администратор, остальное — руководство
    admin('GET', '/engine/admin/schedule', 'booking-engine.adminScheduleGrid'),
    admin('POST', '/engine/admin/schedule/:personal/preview', 'booking-engine.adminSchedulePreview'),
    admin('PUT', '/engine/admin/schedule/:personal/template', 'booking-engine.adminScheduleTemplate'),
    admin('PUT', '/engine/admin/schedule/:personal/days', 'booking-engine.adminScheduleDays'),
    admin('POST', '/engine/admin/schedule/:personal/requests/:date', 'booking-engine.adminScheduleDecide'),
    admin('GET', '/engine/admin/schedule/:personal/legacy', 'booking-engine.adminScheduleLegacy'),
    admin('POST', '/engine/admin/schedule/:personal/legacy', 'booking-engine.adminScheduleLegacyReplace'),
    // Карточка сотрудника (s224): список, карточка, личные данные, секции, ставки,
    // файлы (сканы — закрытый каталог), заметки — только руководство
    admin('GET', '/engine/admin/staff', 'booking-engine.adminStaffList'),
    admin('GET', '/engine/admin/staff-reminders', 'booking-engine.adminStaffReminders'),
    admin('GET', '/engine/admin/staff/:id', 'booking-engine.adminStaffCard'),
    admin('GET', '/engine/admin/staff/:id/private', 'booking-engine.adminStaffPrivate'),
    admin('PATCH', '/engine/admin/staff/:id', 'booking-engine.adminStaffPatch'),
    admin('POST', '/engine/admin/staff/:id/rates', 'booking-engine.adminStaffRate'),
    admin('POST', '/engine/admin/staff/:id/files', 'booking-engine.adminStaffFileUpload'),
    admin('GET', '/engine/admin/staff/:id/files/:fileId', 'booking-engine.adminStaffFileDownload'),
    admin('PATCH', '/engine/admin/staff/:id/files/:fileId', 'booking-engine.adminStaffFileUpdate'),
    admin('DELETE', '/engine/admin/staff/:id/files/:fileId', 'booking-engine.adminStaffFileDelete'),
    admin('POST', '/engine/admin/staff/:id/notes', 'booking-engine.adminStaffNoteCreate'),
    admin('PATCH', '/engine/admin/staff/:id/notes/:noteId', 'booking-engine.adminStaffNoteUpdate'),
    admin('DELETE', '/engine/admin/staff/:id/notes/:noteId', 'booking-engine.adminStaffNoteDelete'),
    admin('POST', '/engine/admin/staff', 'booking-engine.adminStaffCreate'),
    admin('POST', '/engine/admin/staff/:id/account', 'booking-engine.adminStaffAccount'),
    admin('POST', '/engine/admin/staff/:id/rename', 'booking-engine.adminStaffRename'),
    admin('GET', '/engine/admin/staff/:id/leave', 'booking-engine.adminStaffLeavePreview'),
    admin('POST', '/engine/admin/staff/:id/leave', 'booking-engine.adminStaffLeave'),
    admin('POST', '/engine/admin/staff/:id/erase', 'booking-engine.adminStaffErase'),
    admin('POST', '/engine/admin/staff/:id/contracts', 'booking-engine.adminStaffContractCreate'),
    admin('PATCH', '/engine/admin/staff/:id/contracts/:contractId', 'booking-engine.adminStaffContractUpdate'),
    admin('DELETE', '/engine/admin/staff/:id/contracts/:contractId', 'booking-engine.adminStaffContractDelete'),
    admin('POST', '/engine/admin/staff/:id/onboarding/:itemId', 'booking-engine.adminStaffOnboarding'),
    admin('GET', '/engine/admin/staff-checklist-items', 'booking-engine.adminStaffChecklistItems'),
    admin('POST', '/engine/admin/staff-checklist-items', 'booking-engine.adminStaffChecklistItemCreate'),
    admin('PATCH', '/engine/admin/staff-checklist-items/:itemId', 'booking-engine.adminStaffChecklistItemUpdate'),
    admin('GET', '/engine/admin/my-card', 'booking-engine.adminMyCard'),
    admin('POST', '/engine/admin/blocks', 'booking-engine.adminCreateBlock'),
    admin('GET', '/engine/admin/blocks/pending', 'booking-engine.adminPendingBlocks'),
    admin('POST', '/engine/admin/blocks/:id/approval', 'booking-engine.adminSetBlockApproval'),
    admin('PATCH', '/engine/admin/blocks/:id', 'booking-engine.adminPatchBlock'),
    admin('DELETE', '/engine/admin/blocks/:id', 'booking-engine.adminDeleteBlock'),
  ],
};
