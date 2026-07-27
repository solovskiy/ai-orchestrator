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

// ------------------------------------------------------------------ self-commit integration test
//
// Сценарий: агент сам сделал git commit в процессе работы — рабочая
// директория снова чистая, pre-status.txt пуст. gitChangeSummary должен
// найти изменения через сравнение HEAD "до старта" с текущим HEAD
// (git diff --name-only startCommit..HEAD).

function testGitChangeSummarySelfCommit() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-selfcommit-test-'));
  const preDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-selfcommit-pre-'));

  try {
    execFileSync('git', ['init'], { cwd: tmpDir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir, stdio: 'pipe' });

    // Начальный коммит
    fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'v1');
    execFileSync('git', ['add', 'file.txt'], { cwd: tmpDir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: tmpDir, stdio: 'pipe' });

    // Зафиксировать startCommit — HEAD до старта задачи
    const startCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: tmpDir, encoding: 'utf8', stdio: 'pipe',
    }).trim();
    assert.ok(startCommit, 'startCommit should not be empty');

    // Снепшот pre-status — репозиторий чистый (никаких pre-existing изменений)
    fs.writeFileSync(path.join(preDir, 'pre-status.txt'), '');

    // Старт задачи
    const startedAt = new Date().toISOString();

    // Имитация работы агента: изменить файл и самому закоммитить
    fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'v2');
    execFileSync('git', ['add', 'file.txt'], { cwd: tmpDir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'agent: changed file'], { cwd: tmpDir, stdio: 'pipe' });

    // После коммита рабочая директория снова чистая
    const postStatus = execFileSync('git', ['status', '--porcelain'], {
      cwd: tmpDir, encoding: 'utf8', stdio: 'pipe',
    });
    assert.strictEqual(postStatus.trim(), '', 'working tree should be clean after agent self-commit');

    // gitChangeSummary должен найти изменение через committed-diff
    const result = gitChangeSummary(tmpDir, preDir, startedAt, startCommit);
    assert.ok(result !== null, 'gitChangeSummary should not return null');
    assert.strictEqual(result.changedFiles, 1,
      'should detect 1 changed file via commit diff (agent self-committed)');
    assert.ok(result.diffStat, 'diffStat should include committed summary');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(preDir, { recursive: true, force: true });
  }
}

testGitChangeSummarySelfCommit();

// ------------------------------------------------------------------ null startCommit backward compat
//
// Сценарий: startCommit === null (старая задача или не-git репозиторий) —
// gitChangeSummary не должен падать, должен вести себя как раньше
// (только porcelain + mtime).

function testGitChangeSummaryNullStartCommit() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-nullcommit-test-'));
  const preDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-nullcommit-pre-'));

  try {
    execFileSync('git', ['init'], { cwd: tmpDir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir, stdio: 'pipe' });

    fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'v1');
    execFileSync('git', ['add', 'file.txt'], { cwd: tmpDir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: tmpDir, stdio: 'pipe' });

    // Пустой pre-status (чистый репо до старта)
    fs.writeFileSync(path.join(preDir, 'pre-status.txt'), '');

    // Изменяем файл НЕ коммитя — dirt status
    fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'v2');

    // Вызов с startCommit === null — не должен падать
    const result = gitChangeSummary(tmpDir, preDir, null, null);
    assert.ok(result !== null, 'gitChangeSummary should not return null with null startCommit');
    assert.strictEqual(result.changedFiles, 1,
      'should detect uncommitted change (porcelain) even with null startCommit');
    assert.ok(result.diffStat, 'diffStat should be present');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(preDir, { recursive: true, force: true });
  }
}

testGitChangeSummaryNullStartCommit();

console.log('diff-status-lines: OK');
