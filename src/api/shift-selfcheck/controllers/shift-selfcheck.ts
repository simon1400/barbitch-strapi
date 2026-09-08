// @ts-nocheck

// Ручку зовёт ТОЛЬКО виджет панели Strapi (src/admin/extensions/shiftSelfCheck)
// через useFetchClient, т.е. с Bearer-токеном ПАНЕЛИ, а не с сессией сотрудника
// админки. Роут auth:false (content-api не знает стратегию admin), поэтому
// токен панели проверяется здесь вручную — ровно как это делает встроенная
// admin-стратегия Strapi (sessionManager + активная сессия + активный юзер).
// До s182 сверка смены (кассы, чекауты, разница) отдавалась любому анониму.
const panelUser = async (ctx) => {
  const auth = ctx.request?.header?.authorization;
  if (!auth || typeof auth !== 'string') return null;
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const manager = strapi.sessionManager?.('admin');
  if (!manager) return null;
  const res = manager.validateAccessToken(m[1].trim());
  if (!res?.isValid) return null;
  if (!(await manager.isSessionActive(res.payload.sessionId))) return null;
  const rawId = res.payload.userId;
  const numId = Number(rawId);
  const userId = Number.isFinite(numId) && String(numId) === String(rawId) ? numId : rawId;
  const user = await strapi.db.query('admin::user').findOne({ where: { id: userId } });
  return user && user.isActive === true ? user : null;
};

export default {
  async check(ctx) {
    const user = await panelUser(ctx);
    if (!user) return ctx.unauthorized('Admin panel authentication required');
    try {
      const date = ctx.query?.date;
      const result = await strapi
        .service('api::shift-selfcheck.shift-selfcheck')
        .runSelfCheck(date);
      // Strapi admin useFetchClient НЕ разворачивает .data.data → отдаём объект как есть.
      ctx.body = result;
    } catch (err: any) {
      strapi.log.error('Shift self-check error:', err);
      return ctx.badRequest(err.message || 'Failed to run shift self-check');
    }
  },
};
