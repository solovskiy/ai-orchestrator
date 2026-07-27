'use strict';
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { classifyOutcome, buildDiagnosis } = require('../lib/diagnosis.js');

const JOBS_DIR = path.join(__dirname, '..', 'jobs');
const FIXTURES_DIR = path.join(__dirname, 'fixtures');

function loadEvents(jobIdOrFixture) {
  // спершу пробуємо реальну jobs/<id>/out.jsonl
  const realFile = path.join(JOBS_DIR, jobIdOrFixture, 'out.jsonl');
  if (fs.existsSync(realFile)) {
    const text = fs.readFileSync(realFile, 'utf8');
    return text.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  }
  // потім test/fixtures/<name>/out.jsonl
  const fixtureFile = path.join(FIXTURES_DIR, jobIdOrFixture, 'out.jsonl');
  if (fs.existsSync(fixtureFile)) {
    const text = fs.readFileSync(fixtureFile, 'utf8');
    return text.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  }
  return null;
}

function test(desc, fn) {
  try {
    fn();
    console.log(`  OK ${desc}`);
  } catch (e) {
    console.error(`  FAIL ${desc}: ${e.message}`);
    process.exitCode = 1;
  }
}

const namedFixtures = [
  ['fop-tax-research-20260727-135956-1394-5083', 'validation_error'],
  ['rozshyrbak-research-20260727-125449-1511-0e41', 'permission_rejected'],
  ['fop-tax-research-20260727-135713-1654-1d4a', 'abandoned'],
  ['fop-tax-research-20260727-140210-1393-7f9d', 'success'],
];

let realFound = 0;
for (const [jobId, expectedOutcome] of namedFixtures) {
  const events = loadEvents(jobId);
  if (events === null) {
    console.log(`  SKIP ${jobId} — каталог відсутній (можливо, прибраний agent clean)`);
    continue;
  }
  realFound++;
  const result = classifyOutcome(events);
  test(`${jobId} → ${expectedOutcome}`, () => {
    assert.strictEqual(result, expectedOutcome);
  });
}

if (realFound === 0) {
  console.log('  жодного реального job-каталогу не знайдено — використовую синтетичні фікстури з test/fixtures/');
}

// синтетичні фікстури (завжди доступні)
test('validation_error (synthetic)', () => {
  assert.strictEqual(
    classifyOutcome(loadEvents('validation_error')),
    'validation_error',
  );
});

test('permission_rejected (synthetic)', () => {
  assert.strictEqual(
    classifyOutcome(loadEvents('permission_rejected')),
    'permission_rejected',
  );
});

test('abandoned (synthetic)', () => {
  assert.strictEqual(
    classifyOutcome(loadEvents('abandoned')),
    'abandoned',
  );
});

test('success (synthetic)', () => {
  assert.strictEqual(
    classifyOutcome(loadEvents('success')),
    'success',
  );
});

test('no_events — empty array', () => {
  assert.strictEqual(classifyOutcome([]), 'no_events');
});

test('no_events — null/undefined', () => {
  assert.strictEqual(classifyOutcome(null), 'no_events');
  assert.strictEqual(classifyOutcome(undefined), 'no_events');
});

test('buildDiagnosis — validation_error fields', () => {
  const events = loadEvents('validation_error');
  const diag = buildDiagnosis(events, {});
  assert.strictEqual(diag.outcome, 'validation_error');
  assert.strictEqual(diag.lastErrorMessage, 'invalid arguments: content is required');
  assert.strictEqual(diag.toolCalls.length, 1);
  assert.strictEqual(diag.toolCalls[0].tool, 'write');
  assert.strictEqual(diag.toolCalls[0].status, 'error');
  assert.strictEqual(diag.resumedAfterError, false);
});

test('buildDiagnosis — permission_rejected fields', () => {
  const events = loadEvents('permission_rejected');
  const diag = buildDiagnosis(events, {});
  assert.strictEqual(diag.outcome, 'permission_rejected');
  assert.strictEqual(diag.toolCalls[0].tool, 'read');
  assert.ok(diag.lastErrorMessage.includes('external_directory'));
});

test('buildDiagnosis — abandoned has no errors', () => {
  const events = loadEvents('abandoned');
  const diag = buildDiagnosis(events, {});
  assert.strictEqual(diag.outcome, 'abandoned');
  assert.strictEqual(diag.lastErrorMessage, null);
  assert.strictEqual(diag.resumedAfterError, false);
});

test('buildDiagnosis — success', () => {
  const events = loadEvents('success');
  const diag = buildDiagnosis(events, {});
  assert.strictEqual(diag.outcome, 'success');
  assert.strictEqual(diag.lastErrorMessage, null);
});

test('buildDiagnosis — prompt extraction from events', () => {
  const events = loadEvents('validation_error');
  const diag = buildDiagnosis(events, {});
  assert.ok(diag.prompt);
  assert.ok(diag.prompt.includes('I need to write a file'));
});

test('buildDiagnosis — textAfterLastError', () => {
  // завантажуємо події, де після помилки ще є текст
  const events = [
    {"type":"tool_use","part":{"tool":"write","state":{"status":"error","error":"invalid arguments: content is required"}}},
    {"type":"text","part":{"text":"Let me fix the arguments"}},
    {"type":"tool_use","part":{"tool":"write","state":{"status":"success"}}},
  ];
  const diag = buildDiagnosis(events, {});
  assert.strictEqual(diag.outcome, 'validation_error');
  assert.ok(diag.textAfterLastError.includes('Let me fix the arguments'));
  assert.strictEqual(diag.resumedAfterError, true);
});

if (!process.exitCode) {
  console.log('\ndiagnosis: OK');
}
