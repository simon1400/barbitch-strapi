/**
 * Свой лимит «N запросов за окно с одного IP» поверх общего rate-limit-engine —
 * для публичных ручек, которые шлют письма или создают платежи (s274 заявки фирм,
 * s275 оплата ваучеров). В памяти, один PM2-процесс.
 */
export const makeIpLimiter = (windowMs: number, maxPerIp: number) => {
  const hits = new Map<string, number[]>();
  return (ip: string, now = Date.now()) => {
    const key = String(ip || 'unknown');
    const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (recent.length >= maxPerIp) {
      hits.set(key, recent);
      return false;
    }
    recent.push(now);
    hits.set(key, recent);
    if (hits.size > 5000) hits.clear();
    return true;
  };
};
