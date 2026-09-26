'use strict';
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const AGENT_JS = path.join(__dirname, '..', 'lib', 'agent.js');

function test(desc, fn) {
  try { fn(); console.log(`  OK ${desc}`); }
  catch (e) { console.error(`  FAIL ${desc}: ${e.message}`); process.exitCode = 1; }
}

// ---------------------------------------------------------- вспомогательные

function agentJs(args) {
  return execFileSync(process.execPath, [AGENT_JS, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

/** Временный git-репозиторий с одним коммитом на ветке main. */
function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-wt-repo-'));
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  git(repo, ['config', 'user.email', 'test@test.local']);
  git(repo, ['config', 'user.name', 'Test']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'orig\n');
  git(repo, ['add', 'a.txt']);
  git(repo, ['commit', '-q', '-m', 'init']);
  return repo;
}

/** git worktree add в новый путь под уникальным именем — как делает bin/agent. */
function makeWorktree(repo, branch) {
  const wt = path.join(os.tmpdir(), `ai-wt-work-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  git(repo, ['worktree', 'add', wt, '-b', branch]);
  return wt;
}

/** Создаёт job.json через `agent.js new` — как это делает bin/agent cmd_start. */
function newJob(jobsDir, id, fields) {
  const jobDir = path.join(jobsDir, id);
  fs.mkdirSync(jobDir, { recursive: true });
  fs.writeFileSync(path.join(jobDir, 'prompt.md'), 'test\n');
  const pairs = Object.entries({ id, ...fields }).map(([k, v]) => `${k}=${v == null ? '' : v}`);
  agentJs(['new', jobDir, ...pairs]);
  return jobDir;
}

function readJobJson(jobDir) {
  return JSON.parse(fs.readFileSync(path.join(jobDir, 'job.json'), 'utf8'));
}

function cleanup(...dirs) {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
}

// ---------------------------------------------------------------- accept

test('accept: squash-мердж коммита ветки — новый коммит на base, worktree и ветка удалены, integration=accepted', () => {
  const repo = makeRepo();
  const baseCommit = git(repo, ['rev-parse', 'HEAD']);
  const branch = 'agent/accept-ok';
  const wt = makeWorktree(repo, branch);
  fs.writeFileSync(path.join(wt, 'a.txt'), 'orig\nadded-by-agent\n');
  git(wt, ['add', 'a.txt']);
  git(wt, ['commit', '-q', '-m', 'agent change']);

  const jobsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-wt-jobs-'));
  const jobDir = newJob(jobsDir, 'accept-ok-job', {
    task: 'accept-ok', repo, cwd: wt, worktree: 1,
    branch, baseBranch: 'main', baseCommit,
  });
  fs.writeFileSync(path.join(jobDir, 'result.md'), '# Сделано\nДобавил строку в a.txt.\n');

  const out = agentJs(['accept', jobDir]);
  assert.ok(/^принято:/.test(out.trim()), `вывод: ${out}`);

  assert.strictEqual(fs.existsSync(wt), false, 'worktree должен быть удалён');
  assert.strictEqual(git(repo, ['branch', '--list', branch]), '', 'ветка должна быть удалена');

  const subject = git(repo, ['log', '-1', '--format=%s']);
  assert.ok(subject.startsWith('agent(accept-ok):'), `subject: ${subject}`);

  const content = fs.readFileSync(path.join(repo, 'a.txt'), 'utf8');
  assert.strictEqual(content.replace(/\r\n/g, '\n'), 'orig\nadded-by-agent\n');

  const job = readJobJson(jobDir);
  assert.strictEqual(job.integration, 'accepted');
  assert.ok(job.acceptedCommit, 'acceptedCommit должен быть записан');

  cleanup(repo, jobsDir);
});

test('accept: конфликт squash-мерджа — ничего не удаляется, репозиторий остаётся чистым', () => {
  const repo = makeRepo();
  const baseCommit = git(repo, ['rev-parse', 'HEAD']);
  const branch = 'agent/accept-conflict';
  const wt = makeWorktree(repo, branch);

  fs.writeFileSync(path.join(wt, 'a.txt'), 'changed-in-branch\n');
  git(wt, ['add', 'a.txt']);
  git(wt, ['commit', '-q', '-m', 'branch change']);

  // Основной репозиторий расходится по той же строке того же файла.
  fs.writeFileSync(path.join(repo, 'a.txt'), 'changed-in-main\n');
  git(repo, ['add', 'a.txt']);
  git(repo, ['commit', '-q', '-m', 'main change']);

  const jobsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-wt-jobs-'));
  const jobDir = newJob(jobsDir, 'accept-conflict-job', {
    task: 'accept-conflict', repo, cwd: wt, worktree: 1,
    branch, baseBranch: 'main', baseCommit,
  });

  let threw = false;
  try {
    agentJs(['accept', jobDir]);
  } catch (e) {
    threw = true;
    assert.notStrictEqual(e.status, 0, 'accept должен вернуть ненулевой код');
  }
  assert.ok(threw, 'accept должен провалиться при конфликте squash-мерджа');

  assert.strictEqual(fs.existsSync(wt), true, 'worktree должен остаться');
  assert.ok(git(repo, ['branch', '--list', branch]).includes(branch), 'ветка должна остаться');
  assert.strictEqual(git(repo, ['status', '--porcelain']), '', 'репозиторий должен остаться чистым после reset --merge');

  const job = readJobJson(jobDir);
  assert.strictEqual(job.integration, null, 'integration не должен быть выставлен при провале');

  git(repo, ['worktree', 'remove', '--force', wt]);
  git(repo, ['branch', '-D', branch]);
  cleanup(repo, jobsDir);
});

test('accept: отказывает, если текущая ветка репозитория не совпадает с baseBranch', () => {
  const repo = makeRepo();
  const baseCommit = git(repo, ['rev-parse', 'HEAD']);
  const branch = 'agent/accept-wrongbranch';
  const wt = makeWorktree(repo, branch);
  fs.writeFileSync(path.join(wt, 'a.txt'), 'orig\nchange\n');
  git(wt, ['add', 'a.txt']);
  git(wt, ['commit', '-q', '-m', 'change']);

  git(repo, ['checkout', '-q', '-b', 'other']);

  const jobsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-wt-jobs-'));
  const jobDir = newJob(jobsDir, 'accept-wrongbranch-job', {
    task: 'accept-wrongbranch', repo, cwd: wt, worktree: 1,
    branch, baseBranch: 'main', baseCommit,
  });

  let stderr = '';
  let threw = false;
  try {
    agentJs(['accept', jobDir]);
  } catch (e) {
    threw = true;
    stderr = e.stderr || '';
  }
  assert.ok(threw, 'accept должен отказать на несовпадающей текущей ветке');
  assert.ok(stderr.includes('switch main'), `stderr: ${stderr}`);
  assert.strictEqual(fs.existsSync(wt), true, 'worktree не должен трогаться при отказе');

  git(repo, ['checkout', '-q', 'main']);
  git(repo, ['worktree', 'remove', '--force', wt]);
  git(repo, ['branch', '-D', branch]);
  git(repo, ['branch', '-D', 'other']);
  cleanup(repo, jobsDir);
});

test('accept: находит ветку через continuesJob, если у дочерней задачи нет своих branch-полей', () => {
  const repo = makeRepo();
  const baseCommit = git(repo, ['rev-parse', 'HEAD']);
  const branch = 'agent/lineage-test';
  const wt = makeWorktree(repo, branch);
  fs.writeFileSync(path.join(wt, 'a.txt'), 'orig\nchange\n');
  git(wt, ['add', 'a.txt']);
  git(wt, ['commit', '-q', '-m', 'change']);

  const jobsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-wt-jobs-'));
  newJob(jobsDir, 'lineage-root', {
    task: 'lineage', repo, cwd: wt, worktree: 1,
    branch, baseBranch: 'main', baseCommit,
  });
  // Дочерняя задача — как её создают send/heal: без своих branch-полей,
  // только continuesJob на корень.
  const childDir = newJob(jobsDir, 'lineage-child', {
    task: 'lineage', repo, cwd: wt, worktree: 1,
    continuesJob: 'lineage-root',
  });

  const out = agentJs(['accept', childDir]);
  assert.ok(/^принято:/.test(out.trim()), `вывод: ${out}`);
  assert.strictEqual(fs.existsSync(wt), false);
  assert.strictEqual(git(repo, ['branch', '--list', branch]), '');

  cleanup(repo, jobsDir);
});

// --------------------------------------------------------------- discard

test('discard: удаляет worktree и ветку независимо от статуса изменений, integration=discarded', () => {
  const repo = makeRepo();
  const baseCommit = git(repo, ['rev-parse', 'HEAD']);
  const branch = 'agent/discard-test';
  const wt = makeWorktree(repo, branch);
  fs.writeFileSync(path.join(wt, 'a.txt'), 'orig\nchange\n');
  git(wt, ['add', 'a.txt']);
  git(wt, ['commit', '-q', '-m', 'change']);

  const jobsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-wt-jobs-'));
  const jobDir = newJob(jobsDir, 'discard-test-job', {
    task: 'discard-test', repo, cwd: wt, worktree: 1,
    branch, baseBranch: 'main', baseCommit,
  });

  const out = agentJs(['discard', jobDir]);
  assert.ok(out.includes('отброшено'), `вывод: ${out}`);
  assert.strictEqual(fs.existsSync(wt), false);
  assert.strictEqual(git(repo, ['branch', '--list', branch]), '');

  const job = readJobJson(jobDir);
  assert.strictEqual(job.integration, 'discarded');

  cleanup(repo, jobsDir);
});

// ---------------------------------------------------------- worktree-finish

test('worktree-finish: без коммитов сверх base — worktree и ветка удаляются сами, integration=empty', () => {
  const repo = makeRepo();
  const baseCommit = git(repo, ['rev-parse', 'HEAD']);
  const branch = 'agent/finish-empty';
  const wt = makeWorktree(repo, branch);

  const jobsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-wt-jobs-'));
  const jobDir = newJob(jobsDir, 'finish-empty-job', {
    task: 'finish-empty', repo, cwd: wt, worktree: 1,
    branch, baseBranch: 'main', baseCommit,
  });

  const out = agentJs(['worktree-finish', jobDir]);
  assert.ok(out.includes('изменений нет'), `вывод: ${out}`);
  assert.strictEqual(fs.existsSync(wt), false);
  assert.strictEqual(git(repo, ['branch', '--list', branch]), '');

  const job = readJobJson(jobDir);
  assert.strictEqual(job.integration, 'empty');

  cleanup(repo, jobsDir);
});

test('worktree-finish: с коммитами — печатает подсказку accept/discard, ничего не удаляет', () => {
  const repo = makeRepo();
  const baseCommit = git(repo, ['rev-parse', 'HEAD']);
  const branch = 'agent/finish-withwork';
  const wt = makeWorktree(repo, branch);
  fs.writeFileSync(path.join(wt, 'a.txt'), 'orig\nchange\n');
  git(wt, ['add', 'a.txt']);
  git(wt, ['commit', '-q', '-m', 'change']);

  const jobsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-wt-jobs-'));
  const jobDir = newJob(jobsDir, 'finish-withwork-job', {
    task: 'finish-withwork', repo, cwd: wt, worktree: 1,
    branch, baseBranch: 'main', baseCommit,
  });

  const out = agentJs(['worktree-finish', jobDir]);
  assert.ok(out.includes('agent accept finish-withwork-job'), `вывод: ${out}`);
  assert.ok(out.includes('agent discard finish-withwork-job'), `вывод: ${out}`);
  assert.strictEqual(fs.existsSync(wt), true);
  assert.ok(git(repo, ['branch', '--list', branch]).includes(branch));

  git(repo, ['worktree', 'remove', '--force', wt]);
  git(repo, ['branch', '-D', branch]);
  cleanup(repo, jobsDir);
});

// ----------------------------------------------------------- worktree-gc

test('worktree-gc: распознаёт squash-смердженную ветку как безопасную (dry-run)', () => {
  const repo = makeRepo();
  const branch = 'agent/squash-detect';
  const wt = makeWorktree(repo, branch);
  fs.writeFileSync(path.join(wt, 'a.txt'), 'orig\nadded\n');
  git(wt, ['add', 'a.txt']);
  git(wt, ['commit', '-q', '-m', 'branch change']);

  // Имитируем то, что эта работа уже была squash-смерджена в main отдельным
  // коммитом (без буквального git merge --squash — просто тот же итоговый
  // контент): merge-tree(base, branch) не добавит ничего нового к base.
  fs.writeFileSync(path.join(repo, 'a.txt'), 'orig\nadded\n');
  git(repo, ['add', 'a.txt']);
  git(repo, ['commit', '-q', '-m', 'squash of branch change']);

  const out = agentJs(['worktree-gc', repo]);
  const line = out.split('\n').find((l) => l.includes(branch));
  assert.ok(line, `нет строки про ветку в выводе: ${out}`);
  assert.ok(line.startsWith('[удалить]'), `строка: ${line}`);
  assert.ok(line.includes('squash'), `строка: ${line}`);

  git(repo, ['worktree', 'remove', '--force', wt]);
  git(repo, ['branch', '-D', branch]);
  cleanup(repo);
});

if (!process.exitCode) {
  console.log('\nworktree-lifecycle: OK');
}
