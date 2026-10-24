'use strict';

/**
 * Тест уровней (--tier): resolveTier (чистая логика), agent-read с уровнем
 * (5-я строка вывода) и передача variant как --effort в раннер claude.
 *
 * Запуск: node test/tiers.test.js
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { resolveTier, loadTiers } = require('../lib/agent.js');

const AGENT_JS = path.join(__dirname, '..', 'lib', 'agent.js');

function test(desc, fn) {
  try { fn(); console.log(`  OK ${desc}`); }
  catch (e) { console.error(`  FAIL ${desc}: ${e.message}`); process.exitCode = 1; }
}

const CFG = {
  defaultTier: 'medium',
  agents: ['general'],
  tiers: {
    light: { model: 'p/flash', variant: 'low' },
    medium: { model: 'p/pro', variant: 'medium' },
    heavy: { model: 'p/pro', variant: 'high', worktree: true },
  },
};
const AGENT = { model: 'p/old', variant: 'minimal', worktree: false };

// --------------------------------------------------------------- resolveTier

test('без --tier берётся defaultTier', () => {
  const r = resolveTier('general', AGENT, '', CFG);
  assert.deepStrictEqual(r, { tier: 'medium', model: 'p/pro', variant: 'medium', worktree: false });
});

test('light меняет модель и variant, worktree остаётся от агента', () => {
  const r = resolveTier('general', AGENT, 'light', CFG);
  assert.deepStrictEqual(r, { tier: 'light', model: 'p/flash', variant: 'low', worktree: false });
});

test('heavy включает worktree', () => {
  const r = resolveTier('general', AGENT, 'heavy', CFG);
  assert.strictEqual(r.worktree, true);
  assert.strictEqual(r.variant, 'high');
});

test('поле, которого нет в уровне, остаётся от агента', () => {
  const cfg = { ...CFG, tiers: { medium: { variant: 'medium' } } };
  const r = resolveTier('general', { model: 'p/own', worktree: true }, 'medium', cfg);
  assert.strictEqual(r.model, 'p/own');
  assert.strictEqual(r.worktree, true);
});

test('агент без уровней: настройки как есть, tier пустой', () => {
  const r = resolveTier('research', { model: 'p/r', variant: 'low', worktree: true }, '', CFG);
  assert.deepStrictEqual(r, { tier: '', model: 'p/r', variant: 'low', worktree: true });
});

test('--tier у агента без уровней — ошибка с перечнем агентов', () => {
  assert.throws(() => resolveTier('research', AGENT, 'heavy', CFG), /research не поддерживает --tier.*general/);
});

test('неизвестный уровень — ошибка с перечнем доступных', () => {
  assert.throws(() => resolveTier('general', AGENT, 'ultra', CFG), /неизвестный уровень: ultra.*light, medium, heavy/);
});

test('нет конфига уровней: агент работает как раньше', () => {
  const r = resolveTier('general', AGENT, '', null);
  assert.strictEqual(r.tier, '');
  assert.strictEqual(r.model, 'p/old');
});

// ------------------------------------------------------- боевой lib/tiers.json

test('lib/tiers.json валиден: у всех уровней есть модель и variant, defaultTier существует', () => {
  const cfg = loadTiers();
  assert.ok(cfg, 'lib/tiers.json не читается');
  assert.ok(cfg.tiers[cfg.defaultTier], `defaultTier ${cfg.defaultTier} нет среди уровней`);
  for (const [name, t] of Object.entries(cfg.tiers)) {
    assert.ok(t.model && t.model.includes('/'), `${name}: model должна быть вида провайдер/модель`);
    assert.ok(t.variant, `${name}: нужен variant`);
  }
  for (const a of cfg.agents) {
    assert.ok(fs.existsSync(path.join(__dirname, '..', 'agents', a + '.json')), `агент ${a} из tiers.json не существует`);
  }
});

// ------------------------------------------------------------ agent-read (CLI)

function readAgent(args) {
  const res = spawnSync('node', [AGENT_JS, 'agent-read', ...args], {
    encoding: 'utf8',
    env: { ...process.env, AI_DASHBOARD_URL: 'http://127.0.0.1:1' }, // дашборд недоступен → локальный файл
  });
  return { code: res.status, out: res.stdout.split('\n'), err: res.stderr.trim() };
}

test('agent-read general --tier heavy: 5 строк, worktree=1, уровень в конце', () => {
  const r = readAgent(['general', 'heavy']);
  assert.strictEqual(r.code, 0, r.err);
  assert.strictEqual(r.out[1], '1');
  assert.strictEqual(r.out[2], 'high');
  assert.strictEqual(r.out[4], 'heavy');
});

test('agent-read general без уровня → defaultTier', () => {
  const r = readAgent(['general']);
  assert.strictEqual(r.code, 0, r.err);
  assert.strictEqual(r.out[4], loadTiers().defaultTier);
});

test('agent-read research без уровня: 5-я строка пустая', () => {
  const r = readAgent(['research']);
  assert.strictEqual(r.code, 0, r.err);
  assert.strictEqual(r.out[4], '');
});

test('agent-read research --tier light → код 1 и понятная причина', () => {
  const r = readAgent(['research', 'light']);
  assert.strictEqual(r.code, 1);
  assert.match(r.err, /не поддерживает --tier/);
});

// ------------------------------------------------------- variant → claude --effort

test('claude-раннер добавляет --effort из variant', () => {
  const claude = require('../lib/runners/claude.js');
  const argsFor = (variant) => claude.buildArgs({ agent: 'nonexistent', model: 'claude-ds/x', variant }, 'prompt');
  const a = argsFor('high');
  assert.strictEqual(a[a.indexOf('--effort') + 1], 'high');
  assert.strictEqual(argsFor('minimal')[argsFor('minimal').indexOf('--effort') + 1], 'low');
  assert.ok(!argsFor('').includes('--effort'), 'без variant флага быть не должно');
  assert.ok(!argsFor('weird').includes('--effort'), 'неизвестный variant игнорируется');
});
