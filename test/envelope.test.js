'use strict';

/**
 * Тест машинного конверта (--json): classifyJobError, buildEnvelope и
 * CLI-команды `envelope` / `envelope-error` (коды выхода 0 ok · 1 ошибка · 2 идёт).
 *
 * Запуск: node test/envelope.test.js
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { classifyJobError, buildEnvelope } = require('../lib/agent.js');

const AGENT_JS = path.join(__dirname, '..', 'lib', 'agent.js');

function test(desc, fn) {
  try { fn(); console.log(`  OK ${desc}`); }
  catch (e) { console.error(`  FAIL ${desc}: ${e.message}`); process.exitCode = 1; }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-envelope-test-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* нечего чистить */ } });

/** Создаёт jobs/<id>/job.json (+ result.md) во временной папке, возвращает путь. */
function makeJob(id, fields, resultText) {
  const dir = path.join(tmp, id);
  fs.mkdirSync(dir, { recursive: true });
  const job = {
    id, task: id, runner: 'claude-ds', model: 'claude-ds/x', agent: 'general', tier: 'medium', variant: 'medium',
    worktree: 0, status: 'completed', exitCode: 0, verifyCmd: null, verifyStatus: null, verifyExitCode: null,
    changedFiles: 0, diagnosis: { outcome: 'success' }, tokens: { total: 10 }, costSupported: false, cost: null,
    startedAt: '2026-10-25T10:00:00Z', finishedAt: '2026-10-25T10:00:12Z', continuesJob: null, sessionId: 's1',
    ...fields,
  };
  fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify(job));
  if (resultText != null) fs.writeFileSync(path.join(dir, 'result.md'), resultText);
  return dir;
}

function cli(args) {
  const r = spawnSync('node', [AGENT_JS, ...args], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}

// ---------------------------------------------------------- classifyJobError

test('успешная задача — кода ошибки нет', () => {
  assert.strictEqual(classifyJobError({ status: 'completed', exitCode: 0, diagnosis: { outcome: 'success' } }), null);
});

test('задача ещё идёт — кода ошибки нет', () => {
  assert.strictEqual(classifyJobError({ status: 'running', exitCode: null }), null);
  assert.strictEqual(classifyJobError({ status: 'pending' }), null);
});

test('killed → JOB_KILLED', () => {
  assert.strictEqual(classifyJobError({ status: 'killed' }).code, 'JOB_KILLED');
});

test('failed или ненулевой код выхода → RUNNER_FAILED, сообщение берётся из job.error', () => {
  const a = classifyJobError({ status: 'failed', exitCode: 1, error: 'HTTP 422' });
  assert.deepStrictEqual(a, { code: 'RUNNER_FAILED', msg: 'HTTP 422' });
  assert.strictEqual(classifyJobError({ status: 'completed', exitCode: 3 }).code, 'RUNNER_FAILED');
});

test('diagnosis.outcome ≠ success → код по таблице', () => {
  const code = (outcome) => classifyJobError({ status: 'completed', exitCode: 0, diagnosis: { outcome } }).code;
  assert.strictEqual(code('permission_rejected'), 'PERMISSION_REJECTED');
  assert.strictEqual(code('validation_error'), 'VALIDATION_ERROR');
  assert.strictEqual(code('abandoned'), 'ABANDONED');
  assert.strictEqual(code('no_events'), 'NO_EVENTS');
  assert.strictEqual(code('error'), 'RUNNER_ERROR');
  assert.strictEqual(code('что-то новое'), 'RUNNER_ERROR');
});

test('красный verify при чистом outcome → VERIFY_FAILED', () => {
  const e = classifyJobError({ status: 'completed', exitCode: 0, diagnosis: { outcome: 'success' }, verifyStatus: 'failed', verifyExitCode: 2 });
  assert.strictEqual(e.code, 'VERIFY_FAILED');
  assert.match(e.msg, /2/);
});

test('провал процесса приоритетнее outcome и verify', () => {
  const e = classifyJobError({ status: 'failed', exitCode: 1, diagnosis: { outcome: 'abandoned' }, verifyStatus: 'failed' });
  assert.strictEqual(e.code, 'RUNNER_FAILED');
});

// ------------------------------------------------------------- buildEnvelope

test('успешный конверт: ok, result, длительность, цепочка', () => {
  const dir = makeJob('ok1', {}, '  итог работы  \n');
  const e = buildEnvelope(dir);
  assert.strictEqual(e.ok, true);
  assert.strictEqual(e.done, true);
  assert.strictEqual(e.errorCode, null);
  assert.strictEqual(e.result, 'итог работы');
  assert.strictEqual(e.durationMs, 12000);
  assert.deepStrictEqual(e.chain, ['ok1']);
  assert.strictEqual(e.tier, 'medium');
  assert.strictEqual(e.cost, null, 'при costSupported=false стоимость не выдумываем');
  assert.strictEqual(e.worktree, null);
});

test('идущая задача: done=false, ok=false, кода ошибки нет', () => {
  const dir = makeJob('run1', { status: 'running', exitCode: null, finishedAt: null });
  const e = buildEnvelope(dir);
  assert.strictEqual(e.done, false);
  assert.strictEqual(e.ok, false);
  assert.strictEqual(e.errorCode, null);
  assert.strictEqual(e.durationMs, null);
  assert.strictEqual(e.result, '');
});

test('waitTimeout превращает идущую задачу в WAIT_TIMEOUT, но не трогает завершённую', () => {
  const running = buildEnvelope(makeJob('run2', { status: 'running', exitCode: null, finishedAt: null }), { waitTimeout: true });
  assert.strictEqual(running.errorCode, 'WAIT_TIMEOUT');
  const finished = buildEnvelope(makeJob('ok2', {}), { waitTimeout: true });
  assert.strictEqual(finished.ok, true);
  assert.strictEqual(finished.errorCode, null);
});

test('worktree-задача: ветка ждёт решения (pending) и есть готовые команды', () => {
  const dir = makeJob('wt1', { worktree: 1, branch: 'agent/wt1', baseBranch: 'master', repo: path.join(tmp, 'нет-такого-репо'), integration: null });
  const e = buildEnvelope(dir);
  assert.strictEqual(e.worktree.branch, 'agent/wt1');
  assert.strictEqual(e.worktree.pending, true);
  assert.strictEqual(e.worktree.commits, null, 'репозитория нет — число коммитов неизвестно, а не 0');
  assert.strictEqual(e.worktree.accept, 'agent accept wt1');
  assert.strictEqual(e.worktree.discard, 'agent discard wt1');
});

test('worktree-задача после discard/empty: pending=false', () => {
  const dir = makeJob('wt2', { worktree: 1, branch: 'agent/wt2', baseBranch: 'master', integration: 'discarded' });
  assert.strictEqual(buildEnvelope(dir).worktree.pending, false);
});

test('цепочка heal: chain идёт от корня к последней задаче, ветка наследуется', () => {
  makeJob('root', { worktree: 1, branch: 'agent/root', baseBranch: 'master' });
  const child = makeJob('child', { worktree: 1, continuesJob: 'root', branch: null });
  const e = buildEnvelope(child);
  assert.deepStrictEqual(e.chain, ['root', 'child']);
  assert.strictEqual(e.worktree.branch, 'agent/root');
});

test('стоимость выдаётся, когда раннер её считает', () => {
  const e = buildEnvelope(makeJob('cost1', { costSupported: true, cost: 0.0123 }));
  assert.strictEqual(e.cost, 0.0123);
});

test('verify попадает в конверт только если был задан', () => {
  assert.strictEqual(buildEnvelope(makeJob('v0', {})).verify, null);
  const e = buildEnvelope(makeJob('v1', { verifyCmd: 'npm test', verifyStatus: 'passed', verifyExitCode: 0 }));
  assert.deepStrictEqual(e.verify, { status: 'passed', exitCode: 0 });
});

// --------------------------------------------------------- CLI: коды выхода

test('CLI envelope: ok → код 0 и ровно одна JSON-строка', () => {
  const r = cli(['envelope', makeJob('cli-ok', {}, 'готово')]);
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.out.split('\n').length, 1);
  assert.strictEqual(JSON.parse(r.out).result, 'готово');
});

test('CLI envelope: ошибка → код 1', () => {
  const r = cli(['envelope', makeJob('cli-bad', { status: 'failed', exitCode: 1, error: 'boom' })]);
  assert.strictEqual(r.code, 1);
  assert.strictEqual(JSON.parse(r.out).errorCode, 'RUNNER_FAILED');
});

test('CLI envelope: задача идёт → код 2, с --wait-timeout это WAIT_TIMEOUT', () => {
  const dir = makeJob('cli-run', { status: 'running', exitCode: null, finishedAt: null });
  assert.strictEqual(cli(['envelope', dir]).code, 2);
  assert.strictEqual(JSON.parse(cli(['envelope', dir, '--wait-timeout']).out).errorCode, 'WAIT_TIMEOUT');
});

test('CLI envelope-error: START_FAILED с сообщением, код 1', () => {
  const r = cli(['envelope-error', 'START_FAILED', 'нет такого агента']);
  assert.strictEqual(r.code, 1);
  const e = JSON.parse(r.out);
  assert.deepStrictEqual([e.ok, e.done, e.jobId, e.errorCode, e.errorMsg], [false, true, null, 'START_FAILED', 'нет такого агента']);
});
