// Every word used on screen exists in French and English.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { dicts } = require('../i18n.js');

test('French and English have the same keys', () => {
  const fr = Object.keys(dicts.fr).sort(), en = Object.keys(dicts.en).sort();
  assert.deepStrictEqual(fr.filter(k => !en.includes(k)), [], 'missing in English');
  assert.deepStrictEqual(en.filter(k => !fr.includes(k)), [], 'missing in French');
});

test('every t("key") in app.js is defined', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  const used = new Set([...src.matchAll(/\bt\('([A-Za-z_]+)'/g)].map(m => m[1]).filter(k => !k.endsWith('_')));
  // keys built dynamically: tab_*, av_*, r_*, station names and their short forms
  ['schedule', 'team', 'needs', 'settings'].forEach(k => used.add('tab_' + k));
  ['all', 'custom', 'none'].forEach(k => used.add('av_' + k));
  ['kitchen', 'front', 'kitchenShort', 'frontShort'].forEach(k => used.add(k));
  const codes = fs.readFileSync(path.join(__dirname, '..', 'logic.js'), 'utf8').matchAll(/code: '(\w+)'/g);
  for (const m of codes) used.add('r_' + m[1]);
  const missing = [...used].filter(k => !(k in dicts.fr));
  assert.deepStrictEqual(missing, []);
});
