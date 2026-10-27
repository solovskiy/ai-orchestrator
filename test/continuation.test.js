'use strict';
// Продолжение сессии (send / heal / verify-heal) должно наследовать роль
// агента: agent и variant. Иначе claude запускается без --max-turns,
// системного промпта и deny-прав, а opencode — без --agent/--variant.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { resolveLineage, continuationPairs } = require('../lib/agent.js');

const ROOT = path.join(__dirname, '..');
const AGENT_JS = path.join(ROOT, 'lib', 'agent.js');
// В ротере остался один general без maxSteps, поэтому для теста нужна фикстура
// с числовым maxSteps — его значение подставляется в --max-turns.
const FIXTURE = 'fixture-cont';
const FIXTURE_FILE = path.join(ROOT, 'agents', FIXTURE + '.json');
const FIXTURE_MAX_STEPS = 60;
fs.writeFileSync(FIXTURE_FILE, JSON.stringify({
  name: FIXTURE,
  runner: '',
  model: 'claude-ds/deepseek-v4-pro',
  variant: 'medium',
  mode: 'primary',
  worktree: true,
  autoCommit: false,
  temperature: 0.2,
  maxSteps: FIXTURE_MAX_STEPS,
  timeout: 1800,
  description: 'Test fixture',
  systemPrompt: 'test',
  permissions: {},
}));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-continuation-'));
test.after(() => {
  fs.rmSync(FIXTURE_FILE, { force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
});

function cli(...args) {
  return execFileSync('node', [AGENT_JS, ...args], {
    encoding: 'utf8',
    env: { ...process.env, DEEPSEEK_API_KEY: 'dummy' },
  });
}

function mkJob(id, pairs) {
  const dir = path.join(tmp, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'prompt.md'), 'prompt of ' + id);
  cli('new', dir, `id=${id}`, 'task=t', 'repo=/r', 'cwd=/r', 'worktree=1', ...pairs);
  return dir;
}

function buildArgs(dir) {
  return cli('build-args', dir).split('\0').filter((x) => x !== '');
}

// создаёт продолжение ровно так, как это делают heal / verify-heal
function mkContinuation(id, parentDir) {
  const parent = JSON.parse(fs.readFileSync(path.join(parentDir, 'job.json'), 'utf8'));
  const dir = path.join(tmp, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'prompt.md'), 'continue');
  parent.sessionId = 'SESS';
  cli('new', dir, `id=${id}`, ...continuationPairs(parent, resolveLineage(parentDir)));
  return dir;
}

test('claude-ds: продолжение получает тот же --max-turns, промпт и запреты, что и корень', () => {
  assert.strictEqual(typeof FIXTURE_MAX_STEPS, 'number', 'в фикстуре нет числового maxSteps');
  const root = mkJob('ds-root', ['runner=claude-ds', 'model=claude-ds/deepseek-v4-pro', 'variant=medium', `agent=${FIXTURE}`]);
  const child = mkContinuation('ds-child', root);

  const a = buildArgs(root);
  const b = buildArgs(child);
  const val = (argv, flag) => argv[argv.indexOf(flag) + 1];

  assert.strictEqual(val(b, '--max-turns'), String(FIXTURE_MAX_STEPS));
  assert.strictEqual(val(b, '--max-turns'), val(a, '--max-turns'));
  assert.strictEqual(val(b, '--append-system-prompt'), val(a, '--append-system-prompt'));
  assert.strictEqual(val(b, '--disallowedTools'), val(a, '--disallowedTools'));
  assert.strictEqual(val(b, '--resume'), 'SESS');
});

test('opencode: продолжение получает --agent и --variant корня', () => {
  const root = mkJob('oc-root', ['runner=opencode', 'model=opencode/x', 'variant=medium', `agent=${FIXTURE}`]);
  const child = mkContinuation('oc-child', root);

  const b = buildArgs(child);
  assert.strictEqual(b[b.indexOf('--agent') + 1], FIXTURE);
  assert.strictEqual(b[b.indexOf('--variant') + 1], 'medium');
  assert.strictEqual(b[b.indexOf('--session') + 1], 'SESS');
});

test('продолжение продолжения: agent/variant не теряются по цепочке', () => {
  const root = mkJob('chain-root', ['runner=opencode', 'model=opencode/x', 'variant=high', `agent=${FIXTURE}`]);
  const c1 = mkContinuation('chain-c1', root);
  const c2 = mkContinuation('chain-c2', c1);

  const lin = resolveLineage(c2);
  assert.strictEqual(lin.agent, FIXTURE);
  assert.strictEqual(lin.variant, 'high');
  const b = buildArgs(c2);
  assert.strictEqual(b[b.indexOf('--agent') + 1], FIXTURE);
});

test('старая цепочка (родитель без agent) — значение берётся у корня', () => {
  mkJob('old-root', ['runner=opencode', 'model=opencode/x', 'variant=medium', `agent=${FIXTURE}`]);
  // продолжение, созданное прежней версией: без agent/variant, но с continuesJob
  const old = mkJob('old-mid', ['runner=opencode', 'model=opencode/x', 'sessionId=SESS', 'resume=true', 'continuesJob=old-root']);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(old, 'job.json'), 'utf8')).agent, undefined);

  // lineage-get — то, чем пользуется `agent send`
  assert.strictEqual(cli('lineage-get', old, 'agent'), FIXTURE);
  assert.strictEqual(cli('lineage-get', old, 'variant'), 'medium');
  assert.ok(continuationPairs(JSON.parse(fs.readFileSync(path.join(old, 'job.json'), 'utf8')), resolveLineage(old)).includes(`agent=${FIXTURE}`));
});

test('задача без agent: продолжение тоже без agent, пустые значения не превращаются в "null"', () => {
  const root = mkJob('bare-root', ['runner=opencode', 'model=opencode/x']);
  const child = mkContinuation('bare-child', root);
  const j = JSON.parse(fs.readFileSync(path.join(child, 'job.json'), 'utf8'));
  assert.strictEqual(j.agent, null);
  assert.strictEqual(j.variant, null);
  assert.ok(!buildArgs(child).includes('--agent'));
  assert.strictEqual(cli('lineage-get', child, 'agent'), '');
});

test('lineage-get: неизвестный ключ → код 2', () => {
  const root = mkJob('key-root', ['runner=opencode', 'model=opencode/x']);
  assert.throws(() => execFileSync('node', [AGENT_JS, 'lineage-get', root, 'pid'], { stdio: 'pipe' }), (e) => e.status === 2);
});
