// Отписка по ссылке из письма (s271). Публичные ручки: защита — подписанный токен
// (utils/unsubscribe-token) + общий per-IP лимит global::rate-limit-cabinet.
//   GET  /api/unsubscribe/:token          — замаскированный e-mail и статус
//   POST /api/unsubscribe/:token          — {action:'unsubscribe'|'resubscribe'} со страницы,
//                                           или form `List-Unsubscribe=One-Click` от почтовика
//   POST /api/unsubscribe/:token/reason   — {reason, comment} — опрос после отписки

const route = (method: string, path: string, handler: string) => ({
  method,
  path,
  handler,
  config: { auth: false, policies: [], middlewares: ['global::rate-limit-cabinet'] },
});

export default {
  routes: [
    route('GET', '/unsubscribe/:token', 'unsubscribe.info'),
    route('POST', '/unsubscribe/:token', 'unsubscribe.change'),
    route('POST', '/unsubscribe/:token/reason', 'unsubscribe.reason'),
  ],
};
