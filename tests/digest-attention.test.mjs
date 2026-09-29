// Дополнения дайджеста для управляющей (services/digest-attention.ts, s230): администратор
// смены, Ke schválení, ваучеры, сроки документов, дни рождения. Чистое форматирование.
// + проверка по исходнику, что digest.ts подключает разделы и не падает от сбоя источника.
//
// Запуск: cd strapi && node --test tests/digest-attention.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = path.resolve(import.meta.dirname, '..');
const file = path.join(root, 'src/api/digest/services/digest-attention.ts');
const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const A = await import('data:text/javascript;base64,' + Buffer.from(js, 'utf8').toString('base64'));

const TODAY = '2026-09-29'; // вторник
const text = (r) => [...(r.adminLine ? [r.adminLine] : []), ...r.sections.flat()].join('\n');

test('mondayOf / adminOnDate: понедельник недели и имя дня из графика', () => {
  assert.equal(A.mondayOf('2026-09-29'), '2026-09-28');
  assert.equal(A.mondayOf('2026-09-28'), '2026-09-28');
  assert.equal(A.mondayOf('2026-10-04'), '2026-09-28', 'воскресенье — та же неделя');
  const week = { days: { monday: 'Вика', tuesday: '  Юля  ', wednesday: '', sunday: 'Оля' } };
  assert.equal(A.adminOnDate(week, '2026-09-29'), 'Юля');
  assert.equal(A.adminOnDate(week, '2026-10-04'), 'Оля');
  assert.equal(A.adminOnDate(week, '2026-09-30'), '');
  assert.equal(A.adminOnDate(null, TODAY), '');
  assert.equal(A.adminOnDate({ days: null }, TODAY), '');
});

test('администратор: имя, «не указан», источник упал — строки нет', () => {
  assert.equal(A.buildAttention({ today: TODAY, admin: 'Юля' }).adminLine, '👩‍💼 Адміністратор сьогодні: <b>Юля</b>');
  assert.match(A.buildAttention({ today: TODAY, admin: '' }).adminLine, /у графіку не вказано/);
  assert.equal(A.buildAttention({ today: TODAY }).adminLine, null);
  assert.equal(A.buildAttention({ today: TODAY, admin: '<b>x</b>' }).adminLine.includes('<b>x</b>'), false, 'HTML экранирован');
});

test('Ke schválení: новый блок, правка блока, предложение по графику; счётчик', () => {
  const r = A.buildAttention({
    today: TODAY,
    pending: {
      items: [
        { kind: 'new', date: '2026-10-02', employeeName: 'Veronika', title: 'Lékař', startMin: 600, endMin: 720, createdByName: 'Yuliya' },
        { kind: 'change', date: '2026-10-03', employeeName: 'Zlata', startMin: 540, endMin: 600, proposedStartMin: 570, proposedEndMin: 630, proposedByName: 'Viktoriia' },
      ],
      planRequests: [{ date: '2026-10-05', employeeName: 'Karina', label: 'Volno', by: 'Yuliya' }],
    },
  });
  const t = text(r);
  assert.match(t, /Чекає підтвердження \(Ke schválení\): 3/);
  assert.match(t, /• 02\.10 <b>Veronika<\/b> — блок «Lékař» 10:00–12:00 · Yuliya/);
  assert.match(t, /• 03\.10 <b>Zlata<\/b> — зміна блоку 09:00–10:00 → 09:30–10:30 · Viktoriia/);
  assert.match(t, /• 05\.10 <b>Karina<\/b> — графік → Volno · Yuliya/);
  assert.equal(A.buildAttention({ today: TODAY, pending: { items: [], planRequests: [] } }).sections.length, 0, 'пусто — раздела нет');
});

test('длинный список обрезается с «і ще N»', () => {
  const items = Array.from({ length: A.MAX_ROWS + 3 }, (_, i) => ({ kind: 'new', date: '2026-10-02', employeeName: `M${i}` }));
  const sec = A.buildAttention({ today: TODAY, pending: { items, planRequests: [] } }).sections[0];
  assert.equal(sec.length, 1 + A.MAX_ROWS + 1);
  assert.equal(sec.at(-1), '• …і ще 3');
  assert.match(sec[0], new RegExp(`: ${A.MAX_ROWS + 3}<`), 'в заголовке — полное число');
});

test('ваучеры: оплаченные за 7 дней со строкой не оплаченных; только не оплаченные; пусто', () => {
  const paid = [{ name: ' Anna ', for: 'Eva', sum: 1500, datePay: '2026-09-27', idVoucher: 'BB-12' }];
  const t = text(A.buildAttention({ today: TODAY, vouchers: { paidRecent: paid, unpaid: [{}, {}] } }));
  assert.match(t, /Ваучери: оплачені за 7 днів — перевірте, що potvrzení надіслано \(1\)/);
  assert.match(t, /• <b>Anna<\/b> → Eva · 1 500 Kč · оплачено 27\.09 · № BB-12/);
  assert.match(t, /Не оплачено замовлень за 30 днів: 2/);
  assert.equal(text(A.buildAttention({ today: TODAY, vouchers: { paidRecent: [], unpaid: [{}] } })), '🎁 <b>Ваучери:</b> не оплачено замовлень за 30 днів: 1');
  assert.equal(A.buildAttention({ today: TODAY, vouchers: { paidRecent: [], unpaid: [] } }).sections.length, 0);
});

test('документы: срок впереди, сегодня, просрочен; без номеров документов', () => {
  const t = text(
    A.buildAttention({
      today: TODAY,
      staffDocs: [
        { name: 'Anna', title: 'Pas', validUntil: '2026-10-14', daysLeft: 15, documentNumber: 'AB123456' },
        { name: 'Bára', title: 'Zdravotní průkaz', validUntil: TODAY, daysLeft: 0 },
        { name: 'Cili', title: 'Povolení k pobytu', validUntil: '2026-09-26', daysLeft: -3 },
      ],
    })
  );
  assert.match(t, /Документи співробітників — терміни/);
  assert.match(t, /• <b>Anna<\/b> — Pas: до 14\.10 \(через 15 дн\.\)/);
  assert.match(t, /• <b>Bára<\/b> — Zdravotní průkaz: закінчується сьогодні/);
  assert.match(t, /• <b>Cili<\/b> — Povolení k pobytu: прострочено 3 дн\./);
  assert.ok(!t.includes('AB123456'), 'номер документа не выводится');
});

test('дни рождения: только ближайшие 7 дней, «сегодня», без года', () => {
  const t = text(
    A.buildAttention({
      today: TODAY,
      birthdays: [
        { name: 'Veronika', day: 29, month: 9, daysLeft: 0, next: '2026-09-29' },
        { name: 'Zlata', day: 6, month: 10, daysLeft: 7, next: '2026-10-06' },
        { name: 'Karina', day: 20, month: 10, daysLeft: 21, next: '2026-10-20' },
      ],
    })
  );
  assert.match(t, /Дні народження \(7 днів\)/);
  assert.match(t, /• 🎉 <b>Veronika<\/b> — сьогодні!/);
  assert.match(t, /• <b>Zlata<\/b> — 06\.10 \(через 7 дн\.\)/);
  assert.ok(!t.includes('Karina'), 'дальше 7 дней — не показывается');
  assert.ok(!/19\d\d|20\d\d/.test(t), 'года нет');
  assert.equal(A.buildAttention({ today: TODAY, birthdays: [{ name: 'K', day: 1, month: 1, daysLeft: 20 }] }).sections.length, 0);
});

test('digest.ts: разделы подключены, источники по отдельности в try/catch, документы — без владельца', () => {
  const src = fs.readFileSync(path.join(root, 'src/api/digest/services/digest.ts'), 'utf8');
  assert.match(src, /buildAttention\(attention\)/);
  assert.match(src, /const settle = async \(key, fn\) => \{\s*try \{\s*attention\[key\] = await fn\(\);\s*\} catch/);
  for (const k of ['admin', 'pending', 'vouchers', 'staffDocs', 'birthdays']) assert.match(src, new RegExp(`settle\\('${k}'`), k);
  assert.match(src, /reminders\(\{ session: \{ role: 'manager' \} \}\)/, 'карточки владельцев в чат не попадают');
  assert.match(src, /\.\.\.\(adminLine \? \[adminLine\] : \[\]\)/);
  assert.match(src, /for \(const sec of attentionSections\) lines\.push\('', \.\.\.sec\)/);
});
