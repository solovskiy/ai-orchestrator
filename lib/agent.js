#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');

// ---------------------------------------------------------------- утилиты

function jobFile(jobDir) {
  return path.join(jobDir, 'job.json');
}

function readJob(jobDir) {
  return JSON.parse(fs.readFileSync(jobFile(jobDir), 'utf8'));
}

/** Запись через временный файл + rename: недописанный job.json невозможен. */
function writeJob(jobDir, job) {
  const tmp = path.join(jobDir, `job.json.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(job, null, 2));
  fs.renameSync(tmp, jobFile(jobDir));
}

/** "key=value" -> job[key] = value, с приведением очевидных типов. */
function applyPairs(job, pairs) {
  for (const pair of pairs) {
    const i = pair.indexOf('=');
    if (i < 0) continue;
    const key = pair.slice(0, i);
    const raw = pair.slice(i + 1);
    let value = raw;

    if (raw === 'true') value = true;
    else if (raw === 'false') value = false;
    else if (raw === 'null' || raw === '') value = null;
    else if (/^-?\d+(\.\d+)?$/.test(raw)) value = Number(raw);

    job[key] = value;
  }
}

const MODELS_MAP = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'models.json'), 'utf8'));
  } catch {
    return { deepseek: 'opencode', openai: 'opencode', claude: 'claude', google: 'gemini', codex: 'codex' };
  }
})();

function detectRunner(model) {
  if (!model) return null;
  const prefix = model.split('/')[0].toLowerCase();
  return MODELS_MAP[prefix] || null;
}

function loadRunner(name) {
  const file = path.join(__dirname, 'runners', `${name || 'opencode'}.js`);
  if (!fs.existsSync(file)) {
    throw new Error(`неизвестный исполнитель: ${name} (нет ${file})`);
  }
  return require(file);
}

/** Читает JSONL терпимо: битые/незавершённые строки просто пропускаются. */
function parseStream(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const events = [];
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s[0] !== '{') continue;
    try {
      events.push(JSON.parse(s));
    } catch {
      /* оборванная строка — поток ещё пишется */
    }
  }
  return events;
}

/**
 * Сравнивает два набора строк `git status --porcelain` (до/после) и
 * возвращает только то, что появилось или изменилось ПОСЛЕ снепшота.
 * Чистая функция без I/O — доступна для юнит-тестов.
 */
function diffStatusLines(preLines, postLines) {
  const nonEmpty = (lines) => lines.filter(l => l.trim());
  const preSet = new Set(nonEmpty(preLines));
  const changed = nonEmpty(postLines).filter(l => !preSet.has(l));
  return changed;
}

/**
 * Сводка изменений в рабочей директории задачи. Ловит коварный случай
 * «verify: passed, но агент ничего не тронул» — пустой дифф при пройденных
 * тестах (тесты гоняются на неизменённом коде). changedFiles берётся из
 * `git status --porcelain` — считает и новые (untracked) файлы, которых нет
 * в `git diff`. Никогда не бросает: не git / нет директории → null.
 *
 * Второй аргумент jobDir — каталог задачи (.ai/jobs/<id>/), где лежит
 * pre-status.txt (снепшот «до старта»). Если файла нет (старая задача или
 * не git) — preLines считается пустым, поведение как раньше.
 */
function gitChangeSummary(cwd, jobDir, startedAt, startCommit) {
  if (!cwd || !fs.existsSync(cwd)) return null;
  const git = (args) =>
    execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  try {
    const postStatusLines = git(['status', '--porcelain'])
      .split(/\r?\n/)
      .filter((l) => l.trim());

    // прочитать снепшот "до старта" — если нет, preLines пуст (обратная совместимость)
    let preLines = [];
    if (jobDir) {
      try {
        const preRaw = fs.readFileSync(path.join(jobDir, 'pre-status.txt'), 'utf8');
        preLines = preRaw.split(/\r?\n/).filter((l) => l.trim());
      } catch { /* нет файла — старая задача или не git */ }
    }

    const changed = diffStatusLines(preLines, postStatusLines);

    // Дополнительная проверка: если файл уже был изменён до старта задачи
    // (та же строка статуса в pre и post) — проверить время модификации.
    // Если файл менялся физически ПОСЛЕ старта задачи — считаем его изменённым.
    if (startedAt) {
      const startedMs = Date.parse(startedAt);
      if (Number.isFinite(startedMs)) {
        const preSet = new Set(preLines.filter(l => l.trim()));
        for (const line of postStatusLines) {
          // Файл уже был в preLines с такой же строкой статуса И не попал в changed
          if (preSet.has(line) && !changed.includes(line)) {
            const filePath = line.slice(3).trim();
            if (filePath) {
              try {
                const fullPath = path.join(cwd, filePath);
                const stat = fs.statSync(fullPath);
                if (stat.mtimeMs > startedMs) {
                  changed.push(line);
                }
              } catch {
                // файл мог быть удалён — пропускаем
              }
            }
          }
        }
      }
    }

    // файлы, которые агент изменил и сам закоммитил — не видны через
    // git status (рабочая директория снова чистая), поэтому сравниваем
    // HEAD "до старта" с текущим HEAD отдельно
    let committedFiles = [];
    if (startCommit) {
      try {
        const currentHead = git(['rev-parse', 'HEAD']).trim();
        if (currentHead && currentHead !== startCommit) {
          committedFiles = git(['diff', '--name-only', `${startCommit}..HEAD`])
            .split(/\r?\n/)
            .filter((l) => l.trim());
        }
      } catch { /* startCommit невалиден (force-push/rebase в задаче?) — пропускаем */ }
    }

    const changedPaths = new Set(
      changed.map((l) => l.slice(3).trim()).filter(Boolean),
    );
    for (const f of committedFiles) changedPaths.add(f);

    const changedFiles = changedPaths.size;
    const untracked = changed.filter((l) => l.startsWith('??')).length;

    let diffStat = '';
    try {
      const lines = git(['diff', '--stat', 'HEAD']).trim().split(/\r?\n/);
      diffStat = lines[lines.length - 1] || '';
    } catch {
      /* нет HEAD (пустой репозиторий) — оставляем пусто */
    }
    if (startCommit && committedFiles.length > 0) {
      try {
        const committedStatLines = git(['diff', '--stat', `${startCommit}..HEAD`])
          .trim().split(/\r?\n/);
        const committedSummary = committedStatLines[committedStatLines.length - 1] || '';
        if (committedSummary) {
          diffStat = diffStat ? `${diffStat} + ${committedSummary}` : committedSummary;
        }
      } catch { /* пропускаем */ }
    }
    if (untracked > 0) {
      diffStat += (diffStat ? ' + ' : '') + `${untracked} нов. файл(ов)`;
    }
    return { changedFiles, diffStat: diffStat.slice(0, 300) };
  } catch {
    return null; // не git-репозиторий
  }
}

function fmtDuration(from, to) {
  if (!from) return '—';
  const ms = (to ? new Date(to) : new Date()) - new Date(from);
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}с`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}м ${s % 60}с`;
  return `${Math.floor(m / 60)}ч ${m % 60}м`;
}

function fmtCost(job) {
  if (job.costSupported === false) return 'n/a';
  if (typeof job.cost !== 'number') return '—';
  return job.cost === 0 ? '$0' : `$${job.cost.toFixed(4)}`;
}

function pad(s, n) {
  s = String(s == null ? '' : s);
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

/**
 * Проверяет "здоровье" задачи — вычисляет предупреждения о скрытых проблемах,
 * которые не видны по статусу/verifyStatus.
 *
 * Сейчас детектит:
 *   - `no_changes`        — verifyStatus === 'passed' && changedFiles === 0
 *   - `not_autocommitted` — autoCommitted === false
 *
 * @param {object} job  объект задачи (из job.json)
 * @returns {{ warnings: string[] }}  массив кодов предупреждений (пуст, если всё чисто)
 */
function classifyJobHealth(job) {
  const warnings = [];
  if (job.verifyStatus === 'passed' && job.changedFiles === 0) {
    warnings.push('no_changes');
  }
  if (job.autoCommitted === false) {
    warnings.push('not_autocommitted');
  }
  return { warnings };
}

function listJobDirs(jobsDir) {
  if (!fs.existsSync(jobsDir)) return [];
  return fs
    .readdirSync(jobsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(jobsDir, d.name))
    .filter((d) => fs.existsSync(jobFile(d)));
}

// --------------------------------------------------------------- команды

function cmdNew(jobDir, pairs) {
  const job = {
    id: path.basename(jobDir),
    task: null,
    runner: 'opencode',
    repo: null,
    cwd: null,
    worktree: 0,
    branch: null,
    model: null,
    resume: false,
    sessionId: null,
    continuesJob: null,
    status: 'pending',
    pid: null,
    exitCode: null,
    error: null,
    verifyCmd: null,
    verifyStatus: null,
    verifyExitCode: null,
    changedFiles: null,
    diffStat: null,
    startCommit: null,
    diagnosis: null,
    healedAt: null,
    verifyRetryCount: 0,
    tokens: null,
    cost: null,
    costSupported: null,
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
  };
  const hadExplicitRunner = pairs.some(p => p.startsWith('runner='));
  applyPairs(job, pairs);
  if (!hadExplicitRunner && job.model) {
    const detected = detectRunner(job.model);
    if (detected) job.runner = detected;
  }
  writeJob(jobDir, job);
}

function cmdSet(jobDir, pairs) {
  const job = readJob(jobDir);
  applyPairs(job, pairs);
  writeJob(jobDir, job);
}

function cmdGet(jobDir, key) {
  const job = readJob(jobDir);
  const v = job[key];
  process.stdout.write(v == null ? '' : String(v));
}

function cmdBuildArgs(jobDir) {
  const job = readJob(jobDir);
  const runner = loadRunner(job.runner);
  const prompt = fs.readFileSync(path.join(jobDir, 'prompt.md'), 'utf8');
  const argv = runner.buildArgs(job, prompt);
  // NUL как разделитель: в аргументах бывают переводы строк и пробелы
  process.stdout.write(argv.join('\0') + '\0');
}

function cmdFinalize(jobDir, exitCode) {
  const job = readJob(jobDir);
  const runner = loadRunner(job.runner);
  job.costSupported = runner.capabilities.cost;
  const events = parseStream(path.join(jobDir, 'out.jsonl'));
  const parsed = runner.parse(events);

  if (parsed.sessionId) job.sessionId = parsed.sessionId;
  if (parsed.error) job.error = parsed.error;
  job.tokens = parsed.tokens;
  job.cost = parsed.cost;
  job.exitCode = exitCode;
  job.pid = null;

  // статус killed выставлен вручную — не затираем его
  // exitCode===0 не гарантирует реальный успех: раннер может обнаружить
  // провал на уровне API (напр. пустой шаг с 0 токенов у opencode — см.
  // runners/opencode.js) и вернуть error даже при живом процессе. Такое
  // не помечаем completed — иначе тихий провал уходит незамеченным.
  if (job.status !== 'killed') {
    job.status = (exitCode === 0 && !parsed.error) ? 'completed' : 'failed';
  }

  // сводка изменений — чтобы «passed при пустом диффе» был виден в status
  const summary = gitChangeSummary(job.cwd, jobDir, job.startedAt, job.startCommit);
  if (summary) {
    job.changedFiles = summary.changedFiles;
    job.diffStat = summary.diffStat || null;
  }

  // діагностика: класифікація причин провалу
  const { buildDiagnosis } = require('./diagnosis.js');
  const diagnosis = buildDiagnosis(events, job);
  job.diagnosis = diagnosis;
  if (diagnosis.outcome !== 'success') {
    fs.writeFileSync(
      path.join(jobDir, 'diagnosis.json'),
      JSON.stringify(diagnosis, null, 2),
    );
  }

  fs.writeFileSync(
    path.join(jobDir, 'result.md'),
    parsed.resultText || '(агент не выдал текстового ответа)',
  );
  writeJob(jobDir, job);
}

function cmdList(jobsDir) {
  const jobs = listJobDirs(jobsDir)
    .map((d) => {
      try {
        return readJob(d);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

  if (!jobs.length) {
    console.log('задач пока нет');
    return;
  }

  console.log(
    pad('ID', 34) + pad('СТАТУС', 11) + pad('МОДЕЛЬ', 22) +
    pad('ПРОВЕРКА', 10) + pad('ВРЕМЯ', 10) + pad('СТОИМОСТЬ', 11) + 'ТОКЕНЫ',
  );
  console.log('-'.repeat(116));

  for (const j of jobs) {
    const modelLabel = j.model ? j.model.split('/').pop() || j.model : j.runner;
    console.log(
      pad(j.id, 34) +
      pad(j.status, 11) +
      pad(modelLabel, 22) +
      pad(j.verifyStatus || '—', 10) +
      pad(fmtDuration(j.startedAt, j.finishedAt), 10) +
      pad(fmtCost(j), 11) +
      (j.tokens && j.tokens.total ? String(j.tokens.total) : '—'),
    );
  }
}

function cmdShow(jobDir) {
  const j = readJob(jobDir);
  const row = (k, v) => console.log(pad(k, 20) + (v == null || v === '' ? '—' : v));

  row('ID', j.id);
  row('статус', j.status + (j.exitCode != null ? ` (код ${j.exitCode})` : ''));
  row('исполнитель', j.runner + (j.model ? ` / ${j.model}` : '') + (j.variant ? ` (variant: ${j.variant})` : ''));
  row('директория', j.cwd);
  if (j.worktree) row('ветка', j.branch);
  row('сессия', j.sessionId);
  if (j.continuesJob) row('продолжает', j.continuesJob);
  row('запущена', j.startedAt);
  row('длительность', fmtDuration(j.startedAt, j.finishedAt));
  row('стоимость', fmtCost(j));
  if (j.tokens) row('токены', `всего ${j.tokens.total} (вход ${j.tokens.input}, выход ${j.tokens.output})`);

  if (j.verifyCmd) {
    console.log('');
    row('проверка', j.verifyCmd);
    row('результат', j.verifyStatus + (j.verifyExitCode != null ? ` (код ${j.verifyExitCode})` : ''));
    if (j.verifyStatus === 'failed') {
      console.log(`\nхвост verify.log:`);
      try {
        const log = fs.readFileSync(path.join(jobDir, 'verify.log'), 'utf8');
        console.log(log.split(/\r?\n/).slice(-25).join('\n'));
      } catch {
        console.log('(лог проверки недоступен)');
      }
    }
  }

  if (j.changedFiles != null) {
    console.log('');
    row('изменения', `${j.changedFiles} файл(ов)${j.diffStat ? ` — ${j.diffStat}` : ''}`);
  }

  const _health = classifyJobHealth(j);
  for (const _w of _health.warnings) {
    if (_w === 'no_changes') {
      console.log('  ⚠ проверка passed, но рабочая директория не изменилась — агент, вероятно, ничего не сделал');
    } else if (_w === 'not_autocommitted') {
      console.log('  ⚠ у worktree лишились незакомічені зміни, і авто-коміт обгортки теж не вдався — перевір вручну (`git status` у робочій директорії задачі)');
    }
  }

  if (j.autoCommitted === true) {
    console.log('  ⚠ модель не закомітила зміни сама — коміт зроблено обгорткою (run-job.sh, наприкінці задачі)');
  }

  if (j.error) {
    console.log('');
    row('ошибка', j.error);
  }

  if (j.diagnosis && j.diagnosis.outcome && j.diagnosis.outcome !== 'success') {
    let detail = j.diagnosis.outcome;
    if (j.diagnosis.lastErrorMessage) {
      const short = j.diagnosis.lastErrorMessage.slice(0, 60);
      detail += ` (${short})`;
    }
    console.log('');
    row('діагноз', detail);
  }
}

function cmdTail(jobDir, n) {
  const job = readJob(jobDir);
  const runner = loadRunner(job.runner);
  const parsed = runner.parse(parseStream(path.join(jobDir, 'out.jsonl')));
  const text = parsed.resultText || '';
  if (!text) {
    console.log('(вывода пока нет)');
    return;
  }
  console.log(text.split(/\r?\n/).slice(-Number(n || 20)).join('\n'));
}

function cmdRunningCount(jobsDir) {
  const count = listJobDirs(jobsDir)
    .map((d) => {
      try {
        return readJob(d);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .filter((j) => j.status === 'running')
    .length;
  process.stdout.write(String(count));
}

/**
 * Печатает "1", если какая-то задача продолжает ЭТУ сессию прямо сейчас
 * (status=running), иначе "0". Нужно cmd_send: два параллельных продолжения
 * одного sessionId ломают историю сессии (гонка записи на диск).
 */
function cmdSessionBusy(jobsDir, sessionId) {
  if (!sessionId || sessionId === 'null') {
    process.stdout.write('0');
    return;
  }
  const busy = listJobDirs(jobsDir)
    .map((d) => {
      try {
        return readJob(d);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .some((j) => j.sessionId === sessionId && j.status === 'running');
  process.stdout.write(busy ? '1' : '0');
}

/**
 * Ищет worktree в <repo>/.claude/worktrees/*, не связанные ни с одной
 * известной задачей (job.json к этому моменту мог быть уже вычищен
 * командой `clean`, поэтому единственный надёжный признак «безопасно
 * удалять» — состояние самого git, не job.json):
 *   - рабочая копия чистая (0 незакоммиченных изменений)
 *   - ветка worktree УЖЕ СМЕРДЖЕНА в базовую ветку репозитория
 * Смерджено проверяется как ancestor-check (merge-base --is-ancestor),
 * а не по имени ветки — так безопаснее.
 *
 * По умолчанию (apply=false) — только отчёт, ничего не трогает. Найдено
 * 2026-07-27: наивная эвристика «нет job.json → удалить» снесла бы 3 из
 * 4 реальных worktree с несмерджённой уникальной работой.
 */
function cmdWorktreeGc(repo, apply) {
  const base = execFileSync('git', ['-C', repo, 'branch', '--show-current'], {
    encoding: 'utf8',
  }).trim();
  if (!base) {
    console.error('worktree-gc: не удалось определить базовую ветку (detached HEAD?)');
    process.exit(1);
  }

  const porcelain = execFileSync('git', ['-C', repo, 'worktree', 'list', '--porcelain'], {
    encoding: 'utf8',
  });
  const entries = [];
  let cur = null;
  for (const line of porcelain.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      cur = { path: line.slice('worktree '.length) };
      entries.push(cur);
    } else if (cur && line.startsWith('branch ')) {
      cur.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    }
  }

  const mainPath = path.resolve(repo);
  let removed = 0, kept = 0;

  for (const e of entries) {
    if (!e.branch || path.resolve(e.path) === mainPath) continue; // сам репозиторий, не worktree-задача

    let clean = false, merged = false;
    try {
      const status = execFileSync('git', ['-C', e.path, 'status', '--porcelain'], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      });
      clean = status.trim() === '';
    } catch { /* worktree-директория пропала физически — не трогаем, git сам разберётся */ }

    try {
      execFileSync('git', ['-C', repo, 'merge-base', '--is-ancestor', e.branch, base], {
        stdio: 'ignore',
      });
      merged = true;
    } catch { /* не ancestor — не смерджена */ }

    const safe = clean && merged;
    const verdict = safe
      ? 'безопасно: чисто + смерджена'
      : !clean
        ? 'ОСТАВИТЬ: есть незакоммиченные изменения'
        : 'ОСТАВИТЬ: ветка НЕ смерджена в ' + base;

    console.log(`${safe ? '[удалить]' : '[оставить]'} ${e.branch} (${e.path}) — ${verdict}`);

    if (safe) {
      removed++;
      if (apply) {
        try {
          execFileSync('git', ['-C', repo, 'worktree', 'remove', e.path], { stdio: 'ignore' });
          // -d (не -D): вторая независимая проверка «смерджена» от самого git
          execFileSync('git', ['-C', repo, 'branch', '-d', e.branch], { stdio: 'ignore' });
        } catch (err) {
          console.log(`  не удалось удалить: ${err.message.split('\n')[0]}`);
        }
      }
    } else {
      kept++;
    }
  }

  console.log('');
  console.log(apply
    ? `удалено: ${removed}, оставлено: ${kept}`
    : `безопасно удалить: ${removed}, оставить: ${kept} — это отчёт (dry-run); повторить с --apply, чтобы реально удалить`);
}

function cmdClean(jobsDir, days) {
  const cutoff = Date.now() - Number(days) * 86400000;
  let removed = 0;
  let kept = 0;

  for (const dir of listJobDirs(jobsDir)) {
    let job;
    try {
      job = readJob(dir);
    } catch {
      continue;
    }

    const ts = new Date(job.finishedAt || job.createdAt).getTime();
    if (!Number.isFinite(ts) || ts > cutoff) continue;
    if (job.status === 'running' || job.status === 'pending') continue;

    // worktree убираем БЕЗ --force: git сам откажется, если там есть
    // незакоммиченные изменения — и мы ничего молча не потеряем.
    if (job.worktree && job.cwd && job.repo && fs.existsSync(job.cwd)) {
      try {
        execFileSync('git', ['-C', job.repo, 'worktree', 'remove', job.cwd], {
          stdio: 'pipe',
        });
      } catch (e) {
        console.log(`пропущена ${job.id}: worktree не удаляется (есть незакоммиченные изменения?)`);
        kept++;
        continue;
      }
    }

    fs.rmSync(dir, { recursive: true, force: true });
    removed++;
  }

  console.log(`удалено задач: ${removed}${kept ? `, пропущено: ${kept}` : ''}`);
}

// -------------------------------------------------------------- heal

function cmdHeal(jobDir) {
  const job = readJob(jobDir);
  const jobsDir = path.dirname(jobDir);

  // прочитати diagnosis (може бути вже в job.json або в окремому файлі)
  let diagnosis = job.diagnosis;
  if (!diagnosis) {
    try {
      diagnosis = JSON.parse(fs.readFileSync(path.join(jobDir, 'diagnosis.json'), 'utf8'));
    } catch {
      diagnosis = null;
    }
  }

  const outcome = diagnosis?.outcome || null;
  if (!['validation_error', 'abandoned'].includes(outcome)) {
    console.log(`heal: задача не потребує відновлення (outcome=${outcome || 'unknown'})`);
    return;
  }

  if (!job.sessionId) {
    console.error('heal: немає sessionId, продовжити неможливо');
    process.exit(1);
  }

  if (job.healedAt) {
    console.error(`heal: уже було відновлення о ${job.healedAt}, повторно не запускаю (захист від нескінченного циклу)`);
    process.exit(1);
  }

  const busy = listJobDirs(jobsDir)
    .map((d) => { try { return readJob(d); } catch { return null; } })
    .filter(Boolean)
    .some((j) => j.sessionId === job.sessionId && j.status === 'running');
  if (busy) {
    console.error(`heal: сесія ${job.sessionId} вже виконується в іншій задачі — паралельне продовження ОДНІЄЇ сесії ламає її історію. Зачекай завершення (agent list)`);
    process.exit(1);
  }

  const lastErrorToolCall = (diagnosis.toolCalls || []).filter(t => t.status === 'error').pop();
  const message = [
    'The previous tool call was rejected or the session ended without completing the task.',
    '',
    `Tool: ${lastErrorToolCall?.tool || 'unknown'}`,
    `Error: ${diagnosis.lastErrorMessage || 'unknown'}`,
    '',
    'Retry the tool call using the same tool with corrected arguments.',
    'Do not finish the task until the tool succeeds or you need clarification.',
    'If you already tried and it still fails, explain what is blocking you in your final text response — do not end silently.',
  ].join('\n');

  // створити дочірню задачу-продовження (аналогічно cmd_send у bin/agent)
  const ts = new Date().toISOString().replace(/[T:.]/g, '-').slice(0, 19);
  const childId = `${job.task}-${ts}-heal`;
  const childDir = path.join(jobsDir, childId);
  if (fs.existsSync(childDir)) {
    console.error(`heal: коллизия jobId ${childId}`);
    process.exit(1);
  }
  fs.mkdirSync(childDir, { recursive: true });
  fs.writeFileSync(path.join(childDir, 'prompt.md'), message);

  cmdNew(childDir, [
    `id=${childId}`,
    `task=${job.task}`,
    `runner=${job.runner}`,
    `repo=${job.repo}`,
    `cwd=${job.cwd}`,
    `worktree=${job.worktree ? 1 : 0}`,
    `model=${job.model}`,
    `verifyCmd=${job.verifyCmd || ''}`,
    `sessionId=${job.sessionId}`,
    'resume=true',
    `continuesJob=${job.id}`,
  ]);

  // позначити оригінал як уже відновлений
  const healedAt = new Date().toISOString();
  cmdSet(jobDir, [`healedAt=${healedAt}`]);

  // запустити run-job.sh від'єднано (як bin/agent робить для start/send)
  const runJobSh = path.join(__dirname, 'run-job.sh');
  const child = require('child_process').spawn('bash', [runJobSh, childDir], {
    stdio: 'ignore',
    detached: true,
    env: { ...process.env },
  });
  child.unref();

  console.log(childId);
  console.log(`  восстановление задачи ${job.id} (сессия ${job.sessionId})`);
}

// ---------------------------------------------------------- verify-heal

/**
 * В отличие от cmdHeal (реагирует на diagnosis.outcome — агент сам
 * сломался/сдался), verify-heal реагирует на verifyStatus === 'failed' —
 * агент отработал и что-то закоммитил, но прогон тестов/проверки красный.
 * Продолжает ту же сессию с хвостом verify.log, чтобы агент, уже зная
 * контекст задачи, исправил причину, а не гонял тесты вслепую заново.
 * Ограничено verifyRetryCount <= maxRetries, чтобы не уйти в бесконечный
 * цикл, если агент не может починить проверку.
 */
function cmdVerifyHeal(jobDir, maxRetriesArg) {
  const job = readJob(jobDir);
  const jobsDir = path.dirname(jobDir);
  const maxRetries = Number(maxRetriesArg) || 2;

  if (job.verifyStatus !== 'failed') {
    console.log(`verify-heal: задача не потребує відновлення (verifyStatus=${job.verifyStatus || 'unknown'})`);
    return;
  }

  const retryCount = job.verifyRetryCount || 0;
  if (retryCount >= maxRetries) {
    console.error(`verify-heal: досягнуто ліміт спроб (${maxRetries}), не пробую знову`);
    process.exit(1);
  }

  if (!job.sessionId) {
    console.error('verify-heal: немає sessionId, продовжити неможливо');
    process.exit(1);
  }

  const busy = listJobDirs(jobsDir)
    .map((d) => { try { return readJob(d); } catch { return null; } })
    .filter(Boolean)
    .some((j) => j.sessionId === job.sessionId && j.status === 'running');
  if (busy) {
    console.error(`verify-heal: сесія ${job.sessionId} вже виконується в іншій задачі — паралельне продовження ОДНІЄЇ сесії ламає її історію. Зачекай завершення (agent list)`);
    process.exit(1);
  }

  let verifyLogTail = '';
  try {
    verifyLogTail = fs.readFileSync(path.join(jobDir, 'verify.log'), 'utf8').split('\n').slice(-80).join('\n');
  } catch { /* лога может не быть */ }

  const message = [
    `Проверка (verify) провалилась: \`${job.verifyCmd}\` (код выхода ${job.verifyExitCode}).`,
    `Попытка исправить: ${retryCount + 1} из ${maxRetries}.`,
    '',
    'Вывод (последние строки):',
    '```',
    verifyLogTail || '(лог пуст или недоступен)',
    '```',
    '',
    'Исправь код так, чтобы эта команда проходила. Не меняй саму команду',
    'проверки и не подгоняй тесты под текущее (возможно неверное) поведение —',
    'чини причину сбоя. Заверши текстовым резюме: что было не так и что исправлено.',
  ].join('\n');

  const ts = new Date().toISOString().replace(/[T:.]/g, '-').slice(0, 19);
  const childId = `${job.task}-${ts}-verify-heal`;
  const childDir = path.join(jobsDir, childId);
  if (fs.existsSync(childDir)) {
    console.error(`verify-heal: коллизия jobId ${childId}`);
    process.exit(1);
  }
  fs.mkdirSync(childDir, { recursive: true });
  fs.writeFileSync(path.join(childDir, 'prompt.md'), message);

  cmdNew(childDir, [
    `id=${childId}`,
    `task=${job.task}`,
    `runner=${job.runner}`,
    `repo=${job.repo}`,
    `cwd=${job.cwd}`,
    `worktree=${job.worktree ? 1 : 0}`,
    `model=${job.model}`,
    `verifyCmd=${job.verifyCmd || ''}`,
    `sessionId=${job.sessionId}`,
    'resume=true',
    `continuesJob=${job.id}`,
    `verifyRetryCount=${retryCount + 1}`,
  ]);

  const runJobSh = path.join(__dirname, 'run-job.sh');
  const child = require('child_process').spawn('bash', [runJobSh, childDir], {
    stdio: 'ignore',
    detached: true,
    env: { ...process.env },
  });
  child.unref();

  console.log(childId);
  console.log(`  восстановление после провала verify (попытка ${retryCount + 1}/${maxRetries}), сесія ${job.sessionId}`);
}

// ------------------------------------------------------------ capability

/**
 * capabilities/<name>/capability.json — дефолты (model, worktree) для
 * задачи, чтобы вызывающий думал «research»/«coding», а не именем модели.
 * Явно переданные --model/--worktree в cmd_start приоритетнее этих дефолтов.
 */
function cmdCapability(name) {
  if (!name) {
    console.error('capability: нужно имя (напр. research, coding)');
    process.exit(1);
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
    console.error('capability: недопустимое имя');
    process.exit(1);
  }
  const file = path.join(__dirname, '..', 'capabilities', name, 'capability.json');
  let cap;
  try {
    cap = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error(`capability: не удалось прочитать ${file}: ${e.message}`);
    process.exit(1);
  }
  process.stdout.write(`${cap.model || ''}\n${cap.worktree ? '1' : '0'}\n${cap.variant || ''}\n`);
}

// ---------------------------------------------------------------- память

const MEMORY_FILE = path.join(__dirname, '..', 'memory', 'index.json');

function readMemory() {
  try {
    return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeMemory(data) {
  const dir = path.dirname(MEMORY_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = MEMORY_FILE + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, MEMORY_FILE);
}

function cmdRemember(pairs) {
  const data = readMemory();
  let key = '', value = '', tags = '', source = '';
  for (const pair of pairs) {
    const i = pair.indexOf('=');
    if (i < 0) continue;
    const k = pair.slice(0, i);
    const v = pair.slice(i + 1);
    if (k === 'key') key = v;
    else if (k === 'value') value = v;
    else if (k === 'tags') tags = v;
    else if (k === 'source') source = v;
  }
  if (!key || !value) {
    console.error('agent.js: remember нужны key= и value=');
    process.exit(1);
  }
  const now = new Date().toISOString();
  if (data[key]) {
    data[key].value = value;
    data[key].updated = now;
    if (tags) data[key].tags = tags.split(',').map(t => t.trim()).filter(Boolean);
    if (source) data[key].source = source;
  } else {
    data[key] = {
      value,
      tags: tags ? tags.split(',').map(t => t.trim()).filter(Boolean) : [],
      source: source || null,
      created: now,
      updated: now,
    };
  }
  writeMemory(data);
  console.log(`remembered: ${key}`);
}

function cmdRecall(pattern) {
  const data = readMemory();
  if (!pattern || pattern === '*') {
    // показать всё
    for (const [key, entry] of Object.entries(data)) {
      console.log(`\n${key}:`);
      console.log(`  ${entry.value.slice(0, 200)}`);
      if (entry.tags && entry.tags.length) console.log(`  теги: ${entry.tags.join(', ')}`);
    }
    if (!Object.keys(data).length) console.log('(память пуста)');
    return;
  }
  // точный ключ или поиск по тегу/значению
  const lower = pattern.toLowerCase();
  let found = false;
  for (const [key, entry] of Object.entries(data)) {
    if (
      key === pattern ||
      key.toLowerCase().includes(lower) ||
      entry.value.toLowerCase().includes(lower) ||
      (entry.tags || []).some(t => t.toLowerCase().includes(lower))
    ) {
      console.log(`\n${key}:`);
      console.log(`  ${entry.value}`);
      if (entry.tags && entry.tags.length) console.log(`  теги: ${entry.tags.join(', ')}`);
      if (entry.source) console.log(`  источник: ${entry.source}`);
      console.log(`  записано: ${entry.created}`);
      found = true;
    }
  }
  if (!found) console.log('(ничего не найдено)');
}

function cmdForget(key) {
  const data = readMemory();
  if (data[key]) {
    delete data[key];
    writeMemory(data);
    console.log(`forgotten: ${key}`);
  } else {
    console.log(`(нет ключа: ${key})`);
  }
}

function cmdLearn(jobDir) {
  const j = readJob(jobDir);
  if (j.status !== 'completed') {
    console.error(`задача ${j.id} не завершена (статус: ${j.status})`);
    process.exit(1);
  }
  const resultFile = path.join(jobDir, 'result.md');
  let resultText = '';
  try {
    resultText = fs.readFileSync(resultFile, 'utf8').trim();
  } catch {
    resultText = '';
  }
  if (!resultText || resultText === '(агент не выдал текстового ответа)') {
    console.log('(в задаче нет результата для запоминания)');
    return;
  }
  // извлекаем ключ из первых строк — предполагаем формат "key: значение"
  const lines = resultText.split('\n').slice(0, 10);
  let key = null;
  let value = resultText.slice(0, 1000);
  for (const line of lines) {
    const m = line.match(/^#+\s*(.+)/);
    if (m) { key = m[1].trim().toLowerCase().replace(/\s+/g, '-'); break; }
  }
  if (!key) {
    key = j.task + '-' + j.id.split('-').slice(-2).join('-');
  }
  const data = readMemory();
  const now = new Date().toISOString();
  data[key] = {
    value,
    tags: [j.task],
    source: j.id,
    created: now,
    updated: now,
  };
  writeMemory(data);
  console.log(`learned from ${j.id}: ${key}`);
}

/**
 * Читает конфиг агента: сначала пробует HTTP-дашборд (AI_DASHBOARD_URL),
 * при недоступности — fallback на локальный файл agents/<name>.json.
 *
 * Вывод (stdout, 4 строки): model, worktree (1/0), variant, runner.
 * Именно этого формата ожидает bin/agent (cmd_start).
 */
function cmdAgentRead(name) {
  if (!name) {
    console.error('agent-read: нужно имя агента');
    process.exit(1);
  }

  const writeOutput = (agent) => {
    process.stdout.write(
      `${agent.model || ''}\n${agent.worktree ? '1' : '0'}\n${agent.variant || ''}\n${agent.runner || ''}\n`,
    );
  };

  const readLocal = () => {
    const file = path.join(__dirname, '..', 'agents', name + '.json');
    try {
      const agent = JSON.parse(fs.readFileSync(file, 'utf8'));
      writeOutput(agent);
    } catch (e) {
      console.error('agent-read: агент не найден: ' + name);
      process.exit(1);
    }
  };

  // --- пробуем дашборд ---
  const dashboardUrl = process.env.AI_DASHBOARD_URL || 'http://localhost:9191';
  const req = http.get(`${dashboardUrl}/api/agents/${name}`, { timeout: 3000 }, (res) => {
    if (res.statusCode !== 200) {
      res.resume(); // прочитать остаток ответа и отпустить соединение
      readLocal();
      return;
    }
    let data = '';
    res.on('data', (chunk) => {
      data += chunk;
    });
    res.on('end', () => {
      try {
        const agent = JSON.parse(data);
        writeOutput(agent);
      } catch (e) {
        readLocal();
      }
    });
  });

  req.on('error', () => readLocal());
  req.on('timeout', () => {
    req.destroy();
    readLocal();
  });
}

// ---------------------------------------------------------------- agent CRUD

function cmdAgentList(agentsDir) {
  const agents = [];
  try {
    for (const f of fs.readdirSync(agentsDir)) {
      if (!f.endsWith('.json')) continue;
      const a = JSON.parse(fs.readFileSync(path.join(agentsDir, f), 'utf8'));
      agents.push({
        name: a.name || f.replace('.json', ''),
        description: (a.description || '').slice(0, 80),
        mode: a.mode || 'primary',
        model: (a.model || '').split('/').pop(),
        variant: a.variant || '---',
        worktree: !!a.worktree,
        permissions: a.permissions ? Object.keys(a.permissions).filter(k => a.permissions[k] === 'allow').join(',') : 'all',
      });
    }
  } catch (e) { /* agentsDir doesn't exist yet */ }

  if (agents.length === 0) {
    console.log('агентов нет (agents/*.json)');
    return;
  }

  console.log(pad('АГЕНТ', 16) + pad('MODE', 10) + pad('MODEL', 26) + pad('VARIANT', 10) + 'WORKTREE  TOOLS');
  console.log('-'.repeat(100));
  for (const a of agents.sort((x, y) => x.name.localeCompare(y.name))) {
    console.log(
      pad(a.name, 16) +
      pad(a.mode, 10) +
      pad(a.model, 26) +
      pad(a.variant, 10) +
      pad(a.worktree ? 'да' : 'нет', 10) +
      a.permissions.slice(0, 60)
    );
  }
}

function cmdAgentShow(agentsDir, name) {
  if (!name) { console.error('agent show: нужно имя'); process.exit(1); }
  const file = path.join(agentsDir, name + '.json');
  if (!fs.existsSync(file)) { console.error('агент не найден: ' + name); process.exit(1); }
  console.log(fs.readFileSync(file, 'utf8'));
}

function cmdAgentCreate(agentsDir, name) {
  if (!name) { console.error('agent create: нужно имя'); process.exit(1); }
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    console.error('agent create: имя — латиница, цифры, дефис, начинать с буквы');
    process.exit(1);
  }
  const file = path.join(agentsDir, name + '.json');
  if (fs.existsSync(file)) { console.error('агент уже существует: ' + name); process.exit(1); }

  const agent = {
    name,
    description: '',
    mode: 'primary',
    model: 'opencode/deepseek-v4-flash-free',
    variant: 'medium',
    worktree: false,
    timeout: 1800,
    autoCommit: false,
    systemPrompt: '',
    permissions: {
      bash: 'allow', read: 'allow', edit: 'allow',
      glob: 'allow', grep: 'allow',
      webfetch: 'deny', websearch: 'deny', task: 'deny',
    },
  };

  fs.mkdirSync(agentsDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(agent, null, 2) + '\n');
  console.log('создан агент: ' + name + ' (' + file + ')');
}

function cmdAgentDelete(agentsDir, name) {
  if (!name) { console.error('agent delete: нужно имя'); process.exit(1); }
  const file = path.join(agentsDir, name + '.json');
  if (!fs.existsSync(file)) { console.error('агент не найден: ' + name); process.exit(1); }
  fs.unlinkSync(file);
  console.log('удалён агент: ' + name);
}

// ---------------------------------------------------------------- stats

function cmdStats(jobsDir, opts) {
  const asJson = /(^|\s)--json(\s|$)/.test(String(opts));
  const days = (() => {
    const m = String(opts || '').match(/--days[ =](\d+)/);
    return m ? Number(m[1]) : 0;
  })();
  const cutoff = days > 0 ? Date.now() - days * 86400000 : 0;

  const jobs = [];
  for (const dir of listJobDirs(jobsDir)) {
    let job;
    try { job = readJob(dir); } catch { continue; }
    if (!job.status || job.status === 'pending') continue;
    const ts = new Date(job.finishedAt || job.createdAt).getTime();
    if (cutoff > 0 && ts < cutoff) continue;
    jobs.push(job);
  }

  if (jobs.length === 0) {
    console.log('нет завершённых задач');
    return;
  }

  // агрегация
  const agg = (list) => {
    const total = list.length;
    const completed = list.filter(j => j.status === 'completed').length;
    const failed = list.filter(j => j.status === 'failed').length;
    const killed = list.filter(j => j.status === 'killed').length;
    const tokens = { input: 0, output: 0, total: 0 };
    let cost = 0;
    for (const j of list) {
      if (j.tokens) {
        tokens.input += j.tokens.input || 0;
        tokens.output += j.tokens.output || 0;
        tokens.total += j.tokens.total || 0;
      }
      if (typeof j.cost === 'number') cost += j.cost;
    }
    return { total, completed, failed, killed, tokens, cost };
  };

  const all = agg(jobs);

  // группировка по модели
  const byModel = new Map();
  for (const j of jobs) {
    const m = j.model ? j.model.split('/').pop() : (j.runner || 'unknown');
    if (!byModel.has(m)) byModel.set(m, []);
    byModel.get(m).push(j);
  }
  const modelRows = [...byModel.entries()]
    .map(([m, list]) => ({ model: m, ...agg(list) }))
    .sort((a, b) => b.tokens.total - a.tokens.total);

  // группировка по worktree (0=research, 1=coding)
  const byWt = new Map();
  for (const j of jobs) {
    const key = j.worktree ? 'coding' : 'research';
    if (!byWt.has(key)) byWt.set(key, []);
    byWt.get(key).push(j);
  }
  const capRows = [...byWt.entries()]
    .map(([cap, list]) => ({ capability: cap, ...agg(list) }));

  if (asJson) {
    console.log(JSON.stringify({
      all,
      byModel: Object.fromEntries(modelRows.map(r => [r.model, r])),
      byCapability: Object.fromEntries(capRows.map(r => [r.capability, r])),
    }, null, 2));
    return;
  }

  // текстовый вывод
  const ft = (n) => n > 0 ? String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') : '0';
  const fp = (n, d) => (100 * n / d).toFixed(0);

  const header = days > 0 ? `статистика за ${days} дн. (${jobs.length} задач)` : `статистика (${jobs.length} задач)`;
  console.log(header);
  console.log('');

  // сводка
  console.log(`${' '.repeat(18)} tasks  success   tokens      cost`);
  console.log(`${pad('всего', 18)} ${pad(String(all.total), 5)}  ${pad(fp(all.completed, all.total) + '%', 5)}   ${pad(ft(all.tokens.total), 8)}  ${pad(fmtCost({ cost: all.cost, costSupported: all.cost > 0 ? true : null }), 7)}`);

  for (const r of capRows) {
    console.log(`${pad('  ' + r.capability, 18)} ${pad(String(r.total), 5)}  ${pad(fp(r.completed, r.total) + '%', 5)}   ${pad(ft(r.tokens.total), 8)}  ${pad(fmtCost({ cost: r.cost, costSupported: r.cost > 0 ? true : null }), 7)}`);
  }

  console.log('');
  console.log('по моделям:');
  for (const r of modelRows) {
    console.log(`${pad('  ' + r.model, 30)} ${pad(String(r.total), 4)}  ${pad(fp(r.completed, r.total) + '%', 4)}   ${pad(ft(r.tokens.total), 8)}  ${pad(fmtCost({ cost: r.cost, costSupported: r.cost > 0 ? true : null }), 7)}`);
  }
}

// ------------------------------------------------------------------ main

function main() {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case 'new':        cmdNew(args[0], args.slice(1)); break;
    case 'set':        cmdSet(args[0], args.slice(1)); break;
    case 'get':        cmdGet(args[0], args[1]); break;
    case 'build-args': cmdBuildArgs(args[0]); break;
    case 'finalize':   cmdFinalize(args[0], Number(args[1] ?? 0)); break;
    case 'list':       cmdList(args[0]); break;
    case 'show':       cmdShow(args[0]); break;
    case 'tail':       cmdTail(args[0], args[1]); break;
    case 'running-count':   cmdRunningCount(args[0]); break;
    case 'session-busy':    cmdSessionBusy(args[0], args[1]); break;
    case 'clean':           cmdClean(args[0], args[1] ?? 7); break;
    case 'worktree-gc':     cmdWorktreeGc(args[0], args[1] === '--apply'); break;
    case 'remember':   cmdRemember(args); break;
    case 'recall':     cmdRecall(args[0] || ''); break;
    case 'forget':     cmdForget(args[0] || ''); break;
    case 'learn':      cmdLearn(args[0]); break;
    case 'heal':       cmdHeal(args[0]); break;
    case 'verify-heal': cmdVerifyHeal(args[0], args[1]); break;
    case 'capability': cmdCapability(args[0]); break;
    case 'stats':      cmdStats(args[0], args[1] || ''); break;
    case 'agent-read': cmdAgentRead(args[0]); break;
    case 'agent-list': cmdAgentList(args[0]); break;
    case 'agent-show': cmdAgentShow(args[0], args[1]); break;
    case 'agent-create': cmdAgentCreate(args[0], args[1]); break;
    case 'agent-delete': cmdAgentDelete(args[0], args[1]); break;
    default:
      console.error(`agent.js: неизвестная команда: ${cmd}`);
      process.exit(2);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error(`agent.js: ${e.message}`);
    process.exit(1);
  }
}
module.exports = { diffStatusLines, pad, gitChangeSummary, classifyJobHealth };
