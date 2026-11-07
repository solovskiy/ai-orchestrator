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
const { resolveTier, tierRunners, loadTiers, effectiveTier } = require('../lib/agent.js');

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
  const r = resolveTier('no-tier-agent', { model: 'p/r', variant: 'low', worktree: true }, '', CFG);
  assert.deepStrictEqual(r, { tier: '', model: 'p/r', variant: 'low', worktree: true });
});

test('--tier у агента без уровней — ошибка с перечнем агентов', () => {
  assert.throws(() => resolveTier('no-tier-agent', AGENT, 'heavy', CFG), /no-tier-agent не поддерживает --tier.*general/);
});

test('неизвестный уровень — ошибка с перечнем доступных', () => {
  assert.throws(() => resolveTier('general', AGENT, 'ultra', CFG), /неизвестный уровень: ultra.*light, medium, heavy/);
});

test('нет конфига уровней: агент работает как раньше', () => {
  const r = resolveTier('general', AGENT, '', null);
  assert.strictEqual(r.tier, '');
  assert.strictEqual(r.model, 'p/old');
});

// ------------------------------------------------------- раннер уровня

const RCFG = {
  defaultTier: 'medium',
  runner: 'ds',
  agents: ['general'],
  tiers: {
    light: { runners: { oc: { model: 'oc/flash', variant: 'low' }, ds: { model: 'ds/flash', variant: 'low' } } },
    medium: { runners: { oc: { model: 'oc/flash', variant: '' }, ds: { model: 'ds/pro', variant: 'medium' } } },
    heavy: { worktree: true, runners: { oc: { model: 'oc/pro', variant: 'high' }, ds: { model: 'ds/pro', variant: 'high' } } },
  },
};

test('активный раннер: модель и variant из его блока, runner в результате', () => {
  assert.deepStrictEqual(resolveTier('general', AGENT, 'medium', RCFG),
    { tier: 'medium', model: 'ds/pro', variant: 'medium', worktree: false, runner: 'ds' });
  const oc = resolveTier('general', AGENT, 'light', { ...RCFG, runner: 'oc' });
  assert.strictEqual(oc.model, 'oc/flash');
  assert.strictEqual(oc.runner, 'oc');
});

test('пустой variant раннера не подменяется variant агента', () => {
  const r = resolveTier('general', AGENT, 'medium', { ...RCFG, runner: 'oc' });
  assert.strictEqual(r.variant, '');
});

test('worktree уровня общий для раннеров', () => {
  assert.strictEqual(resolveTier('general', AGENT, 'heavy', RCFG).worktree, true);
  assert.strictEqual(resolveTier('general', AGENT, 'heavy', { ...RCFG, runner: 'oc' }).worktree, true);
});

test('раннера нет в блоке уровня — ошибка, а не чужая модель', () => {
  assert.throws(() => resolveTier('general', AGENT, 'light', { ...RCFG, runner: 'codex' }), /нет настроек для раннера codex.*oc, ds/);
});

test('tierRunners: только раннеры, описанные во всех уровнях', () => {
  assert.deepStrictEqual(tierRunners(RCFG), ['oc', 'ds']);
  const partial = { ...RCFG, tiers: { ...RCFG.tiers, heavy: { runners: { oc: { model: 'oc/pro', variant: 'high' } } } } };
  assert.deepStrictEqual(tierRunners(partial), ['oc']);
  assert.deepStrictEqual(tierRunners(CFG), []);
  assert.deepStrictEqual(tierRunners(null), []);
});

// ------------------------------------------------------- боевой lib/tiers.json

test('lib/tiers.json валиден: у каждого уровня и раннера есть модель и variant, defaultTier существует', () => {
  const cfg = loadTiers();
  assert.ok(cfg, 'lib/tiers.json не читается');
  assert.ok(cfg.tiers[cfg.defaultTier], `defaultTier ${cfg.defaultTier} нет среди уровней`);
  const runners = tierRunners(cfg);
  assert.ok(runners.length, 'не описан ни один раннер, общий для всех уровней');
  assert.ok(runners.includes(cfg.runner), `активный раннер ${cfg.runner} не описан во всех уровнях`);
  for (const [name, t] of Object.entries(cfg.tiers)) {
    for (const rn of runners) {
      const r = t.runners[rn];
      assert.ok(r.model && r.model.includes('/'), `${name}/${rn}: model должна быть вида провайдер/модель`);
      assert.strictEqual(typeof r.variant, 'string', `${name}/${rn}: variant должен быть строкой (пустая — без variant)`);
    }
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

// Временный агент без уровней: с ростером из одного general реального
// агента без --tier не осталось, поэтому CLI-тесты используют фикстуру.
const NOTIER = 'fixture-notier';
const NOTIER_FILE = path.join(__dirname, '..', 'agents', NOTIER + '.json');

function withNotierFixture(fn) {
  fs.writeFileSync(NOTIER_FILE, JSON.stringify({
    name: NOTIER,
    runner: '',
    model: 'claude-ds/x',
    variant: 'low',
    worktree: false,
  }, null, 2));
  try { fn(); }
  finally { fs.rmSync(NOTIER_FILE, { force: true }); }
}

test('agent-read general --tier heavy: 5 строк, worktree=1, уровень в конце', () => {
  const r = readAgent(['general', 'heavy']);
  assert.strictEqual(r.code, 0, r.err);
  assert.strictEqual(r.out[1], '1');
  // variant меняется через дашборд — сверяем с активным блоком раннера, а не с константой
  const cfg = loadTiers();
  assert.strictEqual(r.out[2], effectiveTier('heavy', cfg.tiers.heavy, cfg).variant || '');
  assert.strictEqual(r.out[4], 'heavy');
});

test('agent-read general без уровня → defaultTier', () => {
  const r = readAgent(['general']);
  assert.strictEqual(r.code, 0, r.err);
  assert.strictEqual(r.out[4], loadTiers().defaultTier);
});

test('agent-read: раннер (4-я строка) и модель — из активного раннера tiers.json', () => {
  const cfg = loadTiers();
  const r = readAgent(['general', 'heavy']);
  assert.strictEqual(r.code, 0, r.err);
  assert.strictEqual(r.out[0], cfg.tiers.heavy.runners[cfg.runner].model);
  assert.strictEqual(r.out[3], cfg.runner);
});

test('agent-read агента без уровней: 5-я строка пустая', () => {
  withNotierFixture(() => {
    const r = readAgent([NOTIER]);
    assert.strictEqual(r.code, 0, r.err);
    assert.strictEqual(r.out[4], '');
  });
});

test('agent-read агента без уровней --tier light → код 1 и понятная причина', () => {
  withNotierFixture(() => {
    const r = readAgent([NOTIER, 'light']);
    assert.strictEqual(r.code, 1);
    assert.match(r.err, /не поддерживает --tier/);
  });
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
