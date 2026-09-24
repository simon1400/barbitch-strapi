// Юнит-тесты чистого ядра переноса доли при бесплатной коррекции (korekce-transfer.ts, s210).
// korekce-transfer → utils/verify-flags: транспилируем оба и подменяем импорт на data-URL.
// Методы сервиса (глобал strapi) здесь не вызываются — их проверяет живой прогон на копии прода.
//
// Прод-случай (приёмочный тест §9): Kratochvílová — 20.09 Yana (30 %) 1440 Kč,
// бесплатная коррекция 23.09 у Zlaty (40 %). Ожидание: Yana 432 → 0, салон 1008 → 864, Zlata +576.
//
// Запуск: cd strapi && node --test tests/korekce-transfer.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const root = path.resolve(import.meta.dirname, '../src');
const transpile = (file) =>
  ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText;
const dataUrl = (js) => 'data:text/javascript;base64,' + Buffer.from(js, 'utf8').toString('base64');

const vfUrl = dataUrl(transpile('utils/verify-flags.ts'));
const coreJs = transpile('api/booking-engine/services/korekce-transfer.ts');
assert.ok(coreJs.includes("from '../../../utils/verify-flags'"), 'korekce-transfer импортирует verify-flags');
const K = await import(dataUrl(coreJs.split("from '../../../utils/verify-flags'").join(`from '${vfUrl}'`)));
const vf = await import(vfUrl);

// план прод-случая в форме, которую возвращает сервис plan()
const PLAN = {
  status: 'ok',
  mode: 'record',
  bookingDocId: 'w3fuw1gu1uy5mcldxmo5uoj5',
  date: '2026-09-23',
  master: 'Zlata Korunskay',
  masterDocId: 'p-zlata',
  rateB: 40,
  original: {
    bookingDocId: '56owt093aqj9smg2oz71iagt',
    date: '2026-09-20',
    status: 'checkedOut',
    master: 'Yana Shekhovtsova',
    masterDocId: 'p-yana',
    services: 'Prodloužení nehtů + Délka M + Design - level 2',
    clientName: 'Kratochvílová',
  },
  rateA: 30,
  fullPrice: 1440,
  usedBaseKc: 0,
  remainingBaseKc: 1440,
  originalSp: { documentId: 'r2q10923qtjbv0ik82vha4u3' },
  originalClosed: true,
};
const META = { now: '2026-09-24T10:00:00.000Z', actor: 'Viktoriia' };

test('korekceMode: тот же месяц → record, прошлый месяц → payroll, тот же мастер → same_master', () => {
  assert.equal(K.korekceMode('2026-09-20', '2026-09-23', false), 'record');
  assert.equal(K.korekceMode('2026-08-30', '2026-09-02', false), 'payroll');
  // граница года — тоже «другой месяц»
  assert.equal(K.korekceMode('2025-12-30', '2026-01-02', false), 'payroll');
  // тот же мастер важнее месяца
  assert.equal(K.korekceMode('2026-08-30', '2026-09-02', true), 'same_master');
  assert.equal(K.korekceMode('2026-09-20', '2026-09-23', true), 'same_master');
});

test('transferAmounts: прод-случай 1440 × 30 % → 40 %', () => {
  assert.deepEqual(K.transferAmounts({ baseKc: 1440, rateA: 30, rateB: 40 }), {
    staffOutKc: 432,
    staffInKc: 576,
    salonAdjKc: -144,
  });
});

test('transferAmounts: симметрия — исправитель дешевле → салон получает разницу назад', () => {
  assert.deepEqual(K.transferAmounts({ baseKc: 1440, rateA: 40, rateB: 30 }), {
    staffOutKc: 576,
    staffInKc: 432,
    salonAdjKc: 144,
  });
  // равные проценты — салон не меняется
  assert.equal(K.transferAmounts({ baseKc: 990, rateA: 40, rateB: 40 }).salonAdjKc, 0);
});

test('transferAmounts: частичная коррекция и округление — инвариант пары держится до копейки', () => {
  assert.deepEqual(K.transferAmounts({ baseKc: 144, rateA: 30, rateB: 40 }), {
    staffOutKc: 43.2,
    staffInKc: 57.6,
    salonAdjKc: -14.4,
  });
  for (const [base, rA, rB] of [
    [333, 30, 45],
    [1111, 33, 40],
    [777.7, 45, 30],
    [95, 30, 40],
  ]) {
    const a = K.transferAmounts({ baseKc: base, rateA: rA, rateB: rB });
    // исходная теряет staffOut − salonAdj, коррекция получает staffIn: сумма изменений = 0
    assert.ok(Math.abs(-a.staffOutKc + a.salonAdjKc + a.staffInKc) < 0.005, `${base}/${rA}/${rB}`);
  }
});

test('parseBaseKc: обязательна, > 0, не больше остатка; запятая допустима', () => {
  const code = (fn) => {
    try {
      fn();
      return null;
    } catch (e) {
      return [e.status, e.code];
    }
  };
  assert.deepEqual(code(() => K.parseBaseKc('', 1440)), [400, 'korekce_base_required']);
  assert.deepEqual(code(() => K.parseBaseKc(null, 1440)), [400, 'korekce_base_required']);
  assert.deepEqual(code(() => K.parseBaseKc('abc', 1440)), [400, 'korekce_base_invalid']);
  assert.deepEqual(code(() => K.parseBaseKc(0, 1440)), [400, 'korekce_base_invalid']);
  assert.deepEqual(code(() => K.parseBaseKc(-5, 1440)), [400, 'korekce_base_invalid']);
  assert.deepEqual(code(() => K.parseBaseKc(1441, 1440)), [400, 'korekce_base_too_big']);
  assert.deepEqual(code(() => K.parseBaseKc(10, 0)), [409, 'korekce_nothing_left']);
  assert.equal(K.parseBaseKc('144,5', 1440), 144.5);
  assert.equal(K.parseBaseKc('1 440', 1440), 1440);
  assert.equal(K.parseBaseKc(1440, '1440.00'), 1440);
});

test('buildTransfer: record — суммы по формуле, связь с исходной записью', () => {
  const t = K.buildTransfer(PLAN, 1440, META);
  assert.equal(t.mode, 'record');
  assert.equal(t.pending, false);
  assert.equal(t.staffOutKc, 432);
  assert.equal(t.staffInKc, 576);
  assert.equal(t.salonAdjKc, -144);
  assert.equal(t.baseKc, 1440);
  assert.equal(t.originalSpDocId, 'r2q10923qtjbv0ik82vha4u3');
  assert.equal(t.originalBookingDocId, '56owt093aqj9smg2oz71iagt');
  assert.equal(t.korekceBookingDocId, 'w3fuw1gu1uy5mcldxmo5uoj5');
  assert.equal(t.ratePercent, 40);
  assert.equal(t.originalRatePercent, 30);
  assert.equal(t.appliedBy, 'Viktoriia');
});

test('buildTransfer: payroll — исходная не трогается, A оплачивает долю B (разницу несёт A)', () => {
  const t = K.buildTransfer({ ...PLAN, mode: 'payroll', original: { ...PLAN.original, date: '2026-08-30' } }, 1440, META);
  assert.equal(t.staffInKc, 576);
  assert.equal(t.staffOutKc, 0);
  assert.equal(t.salonAdjKc, 0);
  assert.equal(t.payrollKc, 576);
  // biginteger: сумма списания округляется до кроны
  assert.equal(K.buildTransfer({ ...PLAN, mode: 'payroll' }, 333, META).payrollKc, 133); // 333 × 40 % = 133,2
});

test('buildTransfer: тот же мастер — всё по нулям', () => {
  const t = K.buildTransfer({ ...PLAN, status: 'same_master', mode: 'same_master' }, 1440, META);
  assert.deepEqual([t.baseKc, t.staffOutKc, t.staffInKc, t.salonAdjKc, t.payrollKc], [0, 0, 0, 0, 0]);
});

test('shiftOriginal: прод-случай 432/1008 → 0/864, откат возвращает строку байт-в-байт', () => {
  const t = K.buildTransfer(PLAN, 1440, META);
  const row = { staff: '432', salon: '1008', staffOutKc: null, salonAdjKc: null, baseUsedKc: null };
  const after = K.shiftOriginal(row, t, 1);
  assert.deepEqual(after, { staff: 0, salon: 864, staffOutKc: 432, salonAdjKc: -144, baseUsedKc: 1440 });
  // инвариант пары: Σ(staff + salon) исходной + доля B = P
  assert.equal(after.staff + after.salon + t.staffInKc, 1440);
  const back = K.shiftOriginal(
    { staff: after.staff, salon: after.salon, staffOutKc: after.staffOutKc, salonAdjKc: after.salonAdjKc, baseUsedKc: after.baseUsedKc },
    t,
    -1,
  );
  // аккумуляторы вернулись в NULL — запись выглядит как до переноса
  assert.deepEqual(back, { staff: 432, salon: 1008, staffOutKc: null, salonAdjKc: null, baseUsedKc: null });
});

test('shiftOriginal: строки draft и published сдвигаются каждая от своих значений', () => {
  const t = K.buildTransfer(PLAN, 1440, META);
  // ловушка s209: черновик уже правили руками (0), опубликованная — 432
  const draft = K.shiftOriginal({ staff: '0', salon: '1008' }, t, 1);
  const pub = K.shiftOriginal({ staff: '432', salon: '1008' }, t, 1);
  assert.equal(draft.staff, -432);
  assert.equal(pub.staff, 0);
});

test('shiftOriginal: две частичные коррекции складываются, остаток base считается от аккумулятора', () => {
  const t1 = K.buildTransfer(PLAN, 144, META);
  const t2 = K.buildTransfer({ ...PLAN, usedBaseKc: 144, remainingBaseKc: 1296 }, 288, META);
  const r1 = K.shiftOriginal({ staff: '432', salon: '1008' }, t1, 1);
  const r2 = K.shiftOriginal({ staff: r1.staff, salon: r1.salon, staffOutKc: r1.staffOutKc, salonAdjKc: r1.salonAdjKc, baseUsedKc: r1.baseUsedKc }, t2, 1);
  assert.deepEqual(r2, { staff: 302.4, salon: 964.8, staffOutKc: 129.6, salonAdjKc: -43.2, baseUsedKc: 432 });
  // откат ПЕРВОЙ коррекции оставляет вторую
  const back1 = K.shiftOriginal({ staff: r2.staff, salon: r2.salon, staffOutKc: r2.staffOutKc, salonAdjKc: r2.salonAdjKc, baseUsedKc: r2.baseUsedKc }, t1, -1);
  assert.deepEqual(back1, { staff: 345.6, salon: 979.2, staffOutKc: 86.4, salonAdjKc: -28.8, baseUsedKc: 288 });
});

test('sumTransfers: ожидающие переносы складываются в аккумуляторы будущей записи', () => {
  const a = K.buildTransfer(PLAN, 144, META);
  const b = K.buildTransfer(PLAN, 1296, META);
  assert.deepEqual(K.sumTransfers([a, b]), { staffOutKc: 432, salonAdjKc: -144, baseUsedKc: 1440 });
  assert.deepEqual(K.sumTransfers([]), { staffOutKc: 0, salonAdjKc: 0, baseUsedKc: 0 });
});

test('строки комментария: добавление и снятие дают исходный комментарий', () => {
  const t = K.buildTransfer(PLAN, 1440, META);
  const line = K.originalCommentLine(t);
  assert.equal(line, '<p>🔁 Korekce 23. 9. · Zlata Korunskay: mistr −432 Kč, salon −144 Kč (z 1440 Kč)</p>');
  assert.equal(K.removeLine(K.appendLine('<p>Poznámka</p>', line), line), '<p>Poznámka</p>');
  assert.equal(K.removeLine(K.appendLine(null, line), line), null);
  assert.equal(
    K.correctionCommentLine(t),
    '<p>🔁 Korekce po návštěvě 20. 9. · Yana Shekhovtsova: 576 Kč (40 % z 1440 Kč), salon 0</p>',
  );
  const p = K.buildTransfer({ ...PLAN, mode: 'payroll', original: { ...PLAN.original, date: '2026-08-30' } }, 1440, META);
  assert.match(K.correctionCommentLine(p), /odpis ze mzdy Yana Shekhovtsova −576 Kč \(návštěva je z měsíce srpen\)/);
  assert.equal(
    K.payrollComment(p),
    'Korekce u Zlata Korunskay 23. 9. za Prodloužení nehtů + Délka M + Design - level 2 30. 8. (Kratochvílová)',
  );
  // частичная — дробь через запятую
  assert.match(K.originalCommentLine(K.buildTransfer(PLAN, 144, META)), /mistr −43,2 Kč, salon −14,4 Kč \(z 144 Kč\)/);
});

test('korekceHint: форма получает статус, режим, проценты и остаток', () => {
  const h = K.korekceHint(PLAN, null);
  assert.equal(h.status, 'ok');
  assert.equal(h.mode, 'record');
  assert.equal(h.originalClosed, true);
  assert.equal(h.remainingBaseKc, 1440);
  assert.equal(h.rateA, 30);
  assert.equal(h.rateB, 40);
  assert.equal(h.original.master, 'Yana Shekhovtsova');
  assert.equal(h.applied, null);
  // json с записи приходит и строкой (сырой SQL)
  const t = K.buildTransfer(PLAN, 1440, META);
  assert.equal(K.korekceHint(PLAN, JSON.stringify(t)).applied.staffInKc, 576);
  assert.equal(K.korekceHint({ status: 'no_link' }, null).original, null);
});

test('сквозной прод-случай: флаги обеих записей после переноса — только 🔁', () => {
  const t = K.buildTransfer(PLAN, 1440, META);
  const after = K.shiftOriginal({ staff: '432', salon: '1008' }, t, 1);
  const origBooking = { services: [{ title: 'Prodloužení…', price: 1440 }], totalPrice: '1440', priceOverride: false, discount: null };
  const orig = vf.computeBookingFlags({
    booking: origBooking,
    ratePercent: 30,
    staffSalaries: after.staff,
    salonSalaries: after.salon,
    sale: null,
    internal: false,
    korekce: vf.korekceFlagInput({ korekceStaffOutKc: after.staffOutKc, korekceSalonAdjKc: after.salonAdjKc }),
  });
  assert.deepEqual(orig, ['korekce']);
  // обычная админская бронь «Prodloužení nehtů» за 0 Kč у Zlaty (каталог 1100)
  const korBooking = { services: [{ title: 'Prodloužení nehtů', price: 1100 }], totalPrice: '0', priceOverride: true, discount: null };
  const kor = (staff) =>
    vf.computeBookingFlags({
      booking: korBooking,
      ratePercent: 40,
      staffSalaries: staff,
      salonSalaries: 0,
      sale: null,
      internal: false,
      korekce: vf.korekceFlagInput({ korekce: t }),
    });
  assert.deepEqual(kor(576), ['korekce']);
  // 732 на проде — ошибка администратора: флаг обязан её показать
  assert.deepEqual(kor(732), ['mistr_up', 'korekce']);
});
