'use strict';
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { diffStatusLines, gitChangeSummary } = require('../lib/agent.js');

assert.deepStrictEqual(
  diffStatusLines(['?? old-report.md'], ['?? old-report.md', '?? new-report.md']),
  ['?? new-report.md'],
  'pre-existing untracked file should NOT count as new',
);

assert.deepStrictEqual(
  diffStatusLines([], ['?? a.md', ' M b.ts']),
  ['?? a.md', ' M b.ts'],
  'empty pre (worktree, old behavior) — all lines are new',
);

assert.deepStrictEqual(
  diffStatusLines(['?? x.md'], ['?? x.md']),
  [],
  'nothing changed — empty result',
);

assert.deepStrictEqual(
  diffStatusLines([' M foo.ts', '?? old.md'], [' M foo.ts', '?? old.md', ' M bar.ts']),
  [' M bar.ts'],
  'only genuinely changed line appears',
);

assert.deepStrictEqual(
  diffStatusLines([], []),
  [],
  'both empty — empty result',
);

// ------------------------------------------------------------------ mtime integration test
//
// Сценарий: файл уже был изменён ДО старта задачи (грязный репозиторий),
// агент правит его снова — статусная строка не меняется (' M ...' → ' M ...'),
// но mtime файла > startedAt. gitChangeSummary (с mtime-проверкой) должен
// обнаружить изменение.

function testGitChangeSummaryMtime() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-mtime-test-'));
  const preDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-mtime-pre-'));

  try {
    execFileSync('git', ['init'], { cwd: tmpDir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir, stdio: 'pipe' });

    fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'v1');
    execFileSync('git', ['add', 'file.txt'], { cwd: tmpDir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: tmpDir, stdio: 'pipe' });

    // Первое изменение — до старта задачи (pre-existing dirty)
    fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'v2');

    // Старт задачи: startedAt — после первого изменения
    const startedAt = new Date().toISOString();

    // Снепшот pre-status — файл уже грязный
    const preStatus = execFileSync('git', ['status', '--porcelain'], {
      cwd: tmpDir, encoding: 'utf8', stdio: 'pipe',
    });
    fs.writeFileSync(path.join(preDir, 'pre-status.txt'), preStatus);

    // Второе изменение — во время задачи (та же статусная строка)
    fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'v3');

    // Проверяем, что статусная строка не изменилась
    const postStatus = execFileSync('git', ['status', '--porcelain'], {
      cwd: tmpDir, encoding: 'utf8', stdio: 'pipe',
    });
    assert.strictEqual(
      preStatus.trim(), postStatus.trim(),
      'porcelain line should be identical (both are " M file.txt")',
    );

    // gitChangeSummary с mtime-проверкой должен найти изменение
    const result = gitChangeSummary(tmpDir, preDir, startedAt);
    assert.ok(result !== null, 'gitChangeSummary should not return null');
    assert.strictEqual(result.changedFiles, 1,
      'should detect the modified file via mtime — same porcelain line but mtime > startedAt');
    assert.ok(result.diffStat, 'diffStat should be present');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(preDir, { recursive: true, force: true });
  }
}

testGitChangeSummaryMtime();

console.log('diff-status-lines: OK');
