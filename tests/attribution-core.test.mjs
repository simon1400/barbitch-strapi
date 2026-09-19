// Юнит-тесты ядра источников брони (attribution-core.ts, s200) — без БД/Strapi.
// Запуск: cd strapi && node --test tests/attribution-core.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const file = path.resolve(import.meta.dirname, '../src/api/booking-engine/services/attribution-core.ts');
const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const core = await import('data:text/javascript;base64,' + Buffer.from(js, 'utf8').toString('base64'));
const { classifyTouch, sanitizeAttribution, bookingChannel, campaignOf } = core;

test('классификация касаний', () => {
  const cases = [
    [{ gclid: 'abc' }, 'google_ads'],
    [{ gbraid: 'x' }, 'google_ads'],
    [{ gad_source: '1', gad_campaignid: '2233' }, 'google_ads'],
    [{ utm_source: 'google', utm_medium: 'cpc' }, 'google_ads'],
    // gclid важнее органического referrer
    [{ gclid: 'a', referrer: 'https://www.google.com/' }, 'google_ads'],
    [{ utm_source: 'facebook', utm_medium: 'paid' }, 'meta_ads'],
    [{ utm_source: 'ig', utm_medium: 'paid_social', fbclid: 'f' }, 'meta_ads'],
    [{ fbclid: 'f' }, 'meta_click'],
    [{ fbclid: 'f', referrer: 'https://l.instagram.com/' }, 'meta_click'],
    [{ referrer: 'https://l.instagram.com/' }, 'meta_organic'],
    [{ referrer: 'https://m.facebook.com/' }, 'meta_organic'],
    [{ utm_source: 'instagram', utm_medium: 'bio' }, 'meta_organic'],
    [{ sznclid: 's' }, 'sklik'],
    [{ utm_source: 'sklik', utm_medium: 'cpc' }, 'sklik'],
    [{ referrer: 'https://search.seznam.cz/' }, 'seznam_organic'],
    [{ referrer: 'https://www.google.cz/' }, 'google_organic'],
    [{ referrer: 'https://www.google.com/' }, 'google_organic'],
    [{ referrer: 'https://www.bing.com/' }, 'other_search'],
    [{ utm_medium: 'email', utm_source: 'resend' }, 'email'],
    [{ utm_source: 'gbp', utm_medium: 'organic' }, 'utm_other'],
    [{ referrer: 'https://firmy.cz/detail/1' }, 'referral'],
    [{ landing: '/' }, 'direct'],
    [undefined, 'direct'],
  ];
  for (const [t, want] of cases) assert.equal(classifyTouch(t), want, JSON.stringify(t));
});

test('чистка: только известные ключи, обрезка, мусор → null', () => {
  assert.equal(sanitizeAttribution(null), null);
  assert.equal(sanitizeAttribution('x'), null);
  assert.equal(sanitizeAttribution({ first: {}, last: { evil: 'x' } }), null);
  const long = 'a'.repeat(1000);
  const a = sanitizeAttribution({
    first: { gclid: long, evil: '<script>', ts: '2026-09-19T10:00:00.000Z', landing: '/cenik', utm_source: 5 },
    last: { fbclid: '  f  ' },
    consent: false,
    inheritedFrom: 'hack',
  });
  assert.equal(a.first.gclid.length, 300);
  assert.equal(a.first.evil, undefined);
  assert.equal(a.first.utm_source, undefined);
  assert.equal(a.first.landing, '/cenik');
  assert.equal(a.last.fbclid, 'f');
  assert.equal(a.consent, false);
  assert.equal(a.inheritedFrom, undefined, 'браузер не может выдать себя за дозапись');
  assert.equal(sanitizeAttribution({ first: { ts: 'не дата', gclid: 'g' } }).first.ts, undefined);
});

test('канал брони: админ и Noona — свои, сайт — first/last касание', () => {
  const attr = { first: { referrer: 'https://www.google.cz/' }, last: { gclid: 'g' } };
  assert.equal(bookingChannel('admin', attr, 'first'), 'admin');
  assert.equal(bookingChannel('calendar', null, 'first'), 'admin');
  assert.equal(bookingChannel('online', null, 'first'), 'noona');
  assert.equal(bookingChannel('app', null, 'last'), 'noona');
  assert.equal(bookingChannel('site', null, 'first'), 'no_data');
  assert.equal(bookingChannel('site', attr, 'first'), 'google_organic');
  assert.equal(bookingChannel('site', attr, 'last'), 'google_ads');
  // только прямые заходы: last нет — берётся first
  assert.equal(bookingChannel('site', { first: { landing: '/' } }, 'last'), 'direct');
});

test('подпись кампании', () => {
  assert.equal(campaignOf({ utm_campaign: 'remarketing', gad_campaignid: '1' }), 'remarketing');
  assert.equal(campaignOf({ gclid: 'g', gad_campaignid: '2233' }), 'Google кампания #2233');
  assert.equal(campaignOf({ utm_source: 'gbp', utm_medium: 'organic' }), 'gbp / organic');
  assert.equal(campaignOf({ referrer: 'https://www.firmy.cz/x' }), 'firmy.cz');
  assert.equal(campaignOf(null), '');
});
