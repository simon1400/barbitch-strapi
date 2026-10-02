// Причина ручного занижения цены при закрытии визита (s241, service-provided.priceBasis):
// настоящий visit-close.ts на заглушке document service.
//   'catalog' / пусто — скидка: мастер от каталожной цены (правило s203);
//   'paid' — сделана меньшая работа: мастер от цены брони, 🎟 не ставится.
// Прод-случай 02.10.2026: «Sundání řas + Intenzivní regenerace» 490 по каталогу,
// цена брони руками 190, мастер 40 % → подсказка была 196 / −6, админ внёс 76 / 114.
// Запуск: cd strapi && node --test tests/visit-close-basis.test.mjs

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
const swap = (js, from, url) => {
  assert.ok(js.includes(`from '${from}'`), `импорт ${from}`);
  return js.split(`from '${from}'`).join(`from '${url}'`);
};

const vfUrl = dataUrl(transpile('utils/verify-flags.ts'));
const ktUrl = dataUrl(swap(transpile('api/booking-engine/services/korekce-transfer.ts'), '../../../utils/verify-flags', vfUrl));
const engineUrl = dataUrl(
  'export class EngineError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }',
);
let js = transpile('api/booking-engine/services/visit-close.ts');
js = swap(js, './slots-core', dataUrl(transpile('api/booking-engine/services/slots-core.ts')));
js = swap(js, './booking-engine', engineUrl);
js = swap(js, '../../../utils/verify-flags', vfUrl);
js = swap(js, './korekce-transfer', ktUrl);
const vc = (await import(dataUrl(js))).default;

const BOOKING_UID = 'api::booking.booking';
const SP_UID = 'api::service-provided.service-provided';

// бронь прод-случая; override — что поменять (каталожная цена и т. п.)
const booking = (over = {}) => ({
  documentId: 'bk1',
  date: '2026-10-02',
  startsAt: '2026-10-02T15:30:00.000Z',
  status: 'active',
  services: [{ title: 'Sundání řas + Intenzivní regenerace přírodních řas', price: 490, seniorPrice: 490 }],
  totalPrice: 190,
  priceOverride: true,
  discount: null,
  internal: false,
  korekce: false,
  clientNameRaw: 'Amálie Mendelová',
  employee: { documentId: 'p-nat', name: 'Nataliia Hobedashvilu', ratePercent: 40 },
  client: { name: 'Amálie Mendelová' },
  ...over,
});

/** Заглушка strapi: одна бронь, одна (или ни одной) запись закрытия. */
const stub = (bk, rec = null) => {
  const state = { rec, created: null, updated: null };
  globalThis.strapi = {
    log: { info() {}, warn() {}, error() {} },
    documents: (uid) => ({
      findOne: async (q) => {
        if (uid === BOOKING_UID) return bk;
        if (uid === SP_UID) return q.status === 'published' ? null : state.rec;
        return null;
      },
      findMany: async () => (uid === SP_UID && state.rec ? [state.rec] : []),
      create: async ({ data }) => {
        state.created = data;
        state.rec = { documentId: 'sp1', ...data, booking: { documentId: bk.documentId } };
        return state.rec;
      },
      update: async ({ data }) => {
        state.updated = data;
        state.rec = { ...state.rec, ...data };
        return state.rec;
      },
    }),
    service: (uid) => {
      if (uid === 'api::booking-engine.korekce-transfer') {
        return { prepare: async () => null, pendingFor: async () => [], appliedFor: async () => [], log() {} };
      }
      if (uid === 'api::booking-engine.booking-engine') return { adminPatchBooking: async () => ({}) };
      if (uid === 'api::calendar-log.calendar-log') return { write: async () => {} };
      throw new Error(`неожиданный сервис ${uid}`);
    },
  };
  return state;
};

const SESSION = { username: 'Viktoriia', role: 'administrator' };
const MONEY = { staffSalaries: '76', salonSalaries: '114' };

test('подсказка: при ручном занижении отдаются обе базы — каталог 196 / −6 и оплаченная 190 → 76', async () => {
  stub(booking());
  const { hint } = await vc.getForBooking('bk1');
  assert.equal(hint.fullPrice, 490);
  assert.equal(hint.mustStaff, 196);
  assert.equal(hint.mustSalon, -6);
  assert.equal(hint.manualDeltaKc, -300);
  assert.deepEqual(hint.manualBasis, { fullPrice: 190, mustStaff: 76 });
});

test('подсказка: без занижения (каталожная цена, завышение) выбора причины нет', async () => {
  stub(booking({ totalPrice: 490, priceOverride: false }));
  assert.equal((await vc.getForBooking('bk1')).hint.manualBasis, null);
  stub(booking({ totalPrice: 600 }));
  const { hint } = await vc.getForBooking('bk1');
  assert.equal(hint.manualDeltaKc, 110);
  assert.equal(hint.manualBasis, null);
});

test('закрытие с причиной «меньшая работа»: 76 / 114 → только 💰, причина в записи, 🎟 нет', async () => {
  process.env.LOYALTY_ENABLED = 'true';
  const st = stub(booking());
  const { checkout } = await vc.createForBooking('bk1', { ...MONEY, priceBasis: 'paid' }, SESSION);
  assert.deepEqual(st.created.verifyFlags, ['cena_rucne']);
  assert.equal(st.created.priceBasis, 'paid');
  assert.equal(st.created.manualDeltaKc, -300);
  assert.equal(checkout.priceBasis, 'paid');
});

test('закрытие с причиной «скидка» и без причины (старая админка): правило s203, 🎟 остаётся', async () => {
  process.env.LOYALTY_ENABLED = 'true';
  const expected = ['mistr_down', 'salon_up', 'cena_rucne', 'sleva_bez_karty'];
  let st = stub(booking());
  await vc.createForBooking('bk1', { ...MONEY, priceBasis: 'catalog' }, SESSION);
  assert.deepEqual(st.created.verifyFlags, expected);
  assert.equal(st.created.priceBasis, 'catalog');
  st = stub(booking());
  await vc.createForBooking('bk1', MONEY, SESSION);
  assert.deepEqual(st.created.verifyFlags, expected);
  assert.equal(st.created.priceBasis, null, 'без выбора причина не записывается');
  // каталожные суммы при «скидке» — норма
  st = stub(booking());
  await vc.createForBooking('bk1', { staffSalaries: '196', salonSalaries: '-6', priceBasis: 'catalog' }, SESSION);
  assert.deepEqual(st.created.verifyFlags, ['cena_rucne', 'sleva_bez_karty']);
});

test('причина без занижения цены не записывается и на расчёт не влияет', async () => {
  const st = stub(booking({ totalPrice: 490, priceOverride: false }));
  await vc.createForBooking('bk1', { staffSalaries: '196', salonSalaries: '294', priceBasis: 'paid' }, SESSION);
  assert.deepEqual(st.created.verifyFlags, ['ok']);
  assert.equal(st.created.priceBasis, null);
  assert.equal(st.created.manualDeltaKc, 0);
});

test('правка закрытого визита: причину можно сменить; без ключа в теле она сохраняется', async () => {
  process.env.LOYALTY_ENABLED = 'true';
  // запись прод-случая: закрыта до s241, причины нет
  const rec = {
    documentId: 'sp1',
    clientName: 'Amálie Mendelová',
    date: '2026-10-02',
    time: '17:30',
    staffSalaries: '76',
    salonSalaries: '114',
    sale: null,
    internal: false,
    priceBasis: null,
    verifyFlags: ['mistr_down', 'salon_up', 'cena_rucne', 'sleva_bez_karty'],
    booking: { documentId: 'bk1' },
  };
  const st = stub(booking({ status: 'checkedOut' }), rec);
  const { checkout } = await vc.patch('sp1', { priceBasis: 'paid' }, SESSION);
  assert.deepEqual(st.updated.verifyFlags, ['cena_rucne']);
  assert.equal(st.updated.priceBasis, 'paid');
  assert.equal(checkout.priceBasis, 'paid');
  // следующая правка без priceBasis в теле (старая админка) причину не теряет
  await vc.patch('sp1', { comment: 'x' }, SESSION);
  assert.equal(st.updated.priceBasis, 'paid');
  assert.deepEqual(st.updated.verifyFlags, ['cena_rucne']);
  // и обратно в «скидку»
  await vc.patch('sp1', { priceBasis: 'catalog' }, SESSION);
  assert.equal(st.updated.priceBasis, 'catalog');
  assert.deepEqual(st.updated.verifyFlags, ['mistr_down', 'salon_up', 'cena_rucne', 'sleva_bez_karty']);
});

test('лента календаря: брони с причиной «меньшая работа» — одним запросом, сбой не роняет календарь', async () => {
  let asked = null;
  globalThis.strapi = {
    log: { warn() {} },
    documents: (uid) => ({
      findMany: async (q) => {
        assert.equal(uid, SP_UID);
        asked = q;
        // у документа две строки (черновик + опубликованная) — бронь в ответе одна
        return [{ booking: { documentId: 'bk1' } }, { booking: { documentId: 'bk1' } }, { booking: null }];
      },
    }),
  };
  assert.deepEqual(await vc.paidBasisBookingIds(['bk1', 'bk2', null]), ['bk1']);
  assert.deepEqual(asked.filters, { priceBasis: { $eq: 'paid' }, booking: { documentId: { $in: ['bk1', 'bk2'] } } });
  assert.equal(asked.status, 'draft');
  asked = null;
  assert.deepEqual(await vc.paidBasisBookingIds([]), []);
  assert.equal(asked, null, 'пустой день — без запроса');
  globalThis.strapi.documents = () => ({ findMany: async () => { throw new Error('column price_basis does not exist'); } });
  assert.deepEqual(await vc.paidBasisBookingIds(['bk1']), []);

  const eng = fs.readFileSync(path.join(root, 'api/booking-engine/services/booking-engine.ts'), 'utf8');
  assert.equal(eng.split('const withKc = await this._withPricingExtras(list);').length - 1, 2, 'день и неделя');
  assert.ok(eng.includes("...(paid.has(b.documentId) ? { priceBasis: 'paid' } : {}),"));
  assert.ok(eng.includes('redemptionKc: null, priceBasis: null, services };'), 'чужая бронь мастеру — без причины');
});

test('зеркала: lifecycle, самопроверка смены и перенос коррекции читают причину из записи', () => {
  const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
  const lc = read('api/service-provided/content-types/service-provided/lifecycles.ts');
  assert.ok(lc.includes("const priceBasis = pick('priceBasis')"));
  assert.ok(lc.includes('redemptionKc, korekce, priceBasis })'));
  const sc = read('api/shift-selfcheck/services/shift-selfcheck.ts');
  assert.ok(sc.includes("manualDeltaKc < 0 && item?.priceBasis === 'paid'"));
  assert.ok(sc.includes("'priceBasis',"));
  const kt = read('api/booking-engine/services/korekce-transfer.ts');
  assert.ok(kt.includes('priceBasis: row.price_basis') && kt.includes("'price_basis',"));
  assert.ok(kt.includes('priceBasis: rec?.priceBasis'));
  const schema = JSON.parse(read('api/service-provided/content-types/service-provided/schema.json'));
  assert.deepEqual(schema.attributes.priceBasis, { type: 'enumeration', enum: ['catalog', 'paid'] });
});
