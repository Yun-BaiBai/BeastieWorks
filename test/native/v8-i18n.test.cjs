'use strict';
// A8 (老板 2026-11-21): the interface in Chinese or English. Every text passed to tr() has an English line, the words
// that change keep their places, and words saved earlier in either language are still recognised.
// Runs under the pinned Electron with ELECTRON_RUN_AS_NODE=1.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const ts = require('typescript');
const load = require('../load-ts.cjs');
const i18n = load('src/shared/i18n/index.ts');

const SRC = path.join(__dirname, '..', '..', 'src');
const EN = JSON.parse(fs.readFileSync(path.join(SRC, 'shared', 'i18n', 'en.json'), 'utf8'));

function keysInSource() {
  const keys = new Map();
  const walk = d => { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); if (fs.statSync(p).isDirectory()) walk(p); else if (/\.tsx?$/.test(n) && !/\.d\.ts$/.test(n)) scan(p); } };
  const scan = f => {
    const text = fs.readFileSync(f, 'utf8');
    if (!/\b(tr|anyLang)\(/.test(text)) return;
    const sf = ts.createSourceFile(f, text, ts.ScriptTarget.Latest, true, f.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const visit = n => {
      if (ts.isCallExpression(n) && /^(tr|anyLang)$/.test(n.expression.getText(sf)) && n.arguments[0]) {
        const a = n.arguments[0];
        assert.ok(ts.isStringLiteral(a), `${path.relative(SRC, f)}: ${n.expression.getText(sf)}() takes a plain string, so it can be looked up`);
        if (!keys.has(a.text)) keys.set(a.text, path.relative(SRC, f));
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  };
  walk(SRC);
  return keys;
}

test('every text shown through tr() has an English line with the same {…} places', () => {
  const keys = keysInSource();
  assert.ok(keys.size > 700, 'the interface goes through tr(): ' + keys.size);
  const places = s => (s.match(/\{\w+\}/g) ?? []).sort().join(',');
  const missing = [...keys].filter(([k]) => typeof EN[k] !== 'string').map(([k, f]) => `${f}: ${k}`);
  assert.deepEqual(missing, [], 'no English yet');
  const moved = [...keys.keys()].filter(k => places(k) !== places(EN[k]));
  assert.deepEqual(moved, [], 'the English keeps every {…}');
  const unused = Object.keys(EN).filter(k => !keys.has(k));
  assert.deepEqual(unused, [], 'English lines no code uses any more');
});

test('tr: Chinese by default; English when chosen, with the words filled in; Chinese where a line is missing', t => {
  t.after(() => i18n.setLanguage('zh'));
  assert.equal(i18n.tr('已叫停。'), '已叫停。');
  i18n.setLanguage('en');
  assert.equal(i18n.tr('已叫停。'), 'Stopped.');
  assert.equal(i18n.tr('已开工单 #{0}，状态：{1}。', [7, 'WORKING']), 'Opened ticket #7, state: WORKING.');
  assert.equal(i18n.tr('还没有这一句'), '还没有这一句');
  assert.deepEqual(i18n.anyLang('审查'), ['审查', 'Review']);
  assert.match(i18n.withLanguageRule('你是主理小怪。'), /in English/);
  i18n.setLanguage('zh');
  assert.equal(i18n.withLanguageRule('你是主理小怪。'), '你是主理小怪。', 'Chinese adds nothing to the agents\' instructions');
});

test('words saved in one language are still recognised in the other (review notes, prefixes)', () => {
  // The notes are matched by their first word, so each English note starts with the English of that word.
  for (const k of ['审查没通过：', '审查打回了 {0} 次，交给老板决定：{1}', '审查没给结论，直接交给老板：']) assert.ok(EN[k].startsWith(EN['审查']), k);
  assert.ok(EN['审查没给结论，直接交给老板：'].startsWith(EN['审查没给结论']));
  assert.ok(EN['没收下：这些文件在小怪干活期间你（或别的工单）改过了，怕覆盖掉，一个都没放进项目：{0}。可以打回让小怪按现在的版本重做。'].startsWith(EN['没收下']));
});

test('the language choice: Chinese, English, or the computer\'s own', () => {
  assert.equal(i18n.resolveLanguage('en', 'zh-CN'), 'en');
  assert.equal(i18n.resolveLanguage('zh', 'en-US'), 'zh');
  assert.equal(i18n.resolveLanguage('system', 'zh-CN'), 'zh');
  assert.equal(i18n.resolveLanguage(undefined, 'en-GB'), 'en');
});
