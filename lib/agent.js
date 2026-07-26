#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
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
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
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
  const parsed = runner.parse(parseStream(path.join(jobDir, 'out.jsonl')));

  if (parsed.sessionId) job.sessionId = parsed.sessionId;
  if (parsed.error) job.error = parsed.error;
  job.tokens = parsed.tokens;
  job.cost = parsed.cost;
  job.exitCode = exitCode;
  job.pid = null;

  // статус killed выставлен вручную — не затираем его
  if (job.status !== 'killed') {
    job.status = exitCode === 0 ? 'completed' : 'failed';
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
  row('исполнитель', j.runner + (j.model ? ` / ${j.model}` : ''));
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

  if (j.error) {
    console.log('');
    row('ошибка', j.error);
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
    case 'clean':           cmdClean(args[0], args[1] ?? 7); break;
    case 'remember':   cmdRemember(args); break;
    case 'recall':     cmdRecall(args[0] || ''); break;
    case 'forget':     cmdForget(args[0] || ''); break;
    case 'learn':      cmdLearn(args[0]); break;
    default:
      console.error(`agent.js: неизвестная команда: ${cmd}`);
      process.exit(2);
  }
}

try {
  main();
} catch (e) {
  console.error(`agent.js: ${e.message}`);
  process.exit(1);
}
