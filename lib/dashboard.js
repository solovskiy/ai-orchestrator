'use strict';

/**
 * Локальный веб-дашборд для .ai — просмотр задач, статистика, настройка
 * capability. Слушает только localhost (127.0.0.1).
 *
 * Запуск: node lib/dashboard.js [--port N] [--open]
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec, execFileSync, spawn } = require('child_process');
const { promisify } = require('util');
const { WebSocketServer } = require('ws');

const execP = promisify(exec);

const AI_HOME = path.resolve(__dirname, '..');
const JOBS_DIR = path.join(AI_HOME, 'jobs');
const CAP_DIR = path.join(AI_HOME, 'agents');
const HTML_FILE = path.join(__dirname, 'dashboard.html');
const { classifyJobHealth, classifyStopReason } = require('./agent.js');
const { toOpenCodeMd } = require('./deploy-agent.js');

// ------------------------------------------------------------------ утилиты

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
}

// withFileTypes — без отдельного stat на каждую папку (раньше: N синхронных
// stat при каждом опросе раз в 1.5 с).
function listJobDirs() {
  try {
    return fs.readdirSync(JOBS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch { return []; }
}

function readJob(dir) {
  return readJson(path.join(JOBS_DIR, dir, 'job.json'));
}

// Кэш job.json по mtime+size: опрос для WebSocket не должен перечитывать и
// парсить сотни файлов, пока ничего не менялось. Если файл в момент чтения
// битый (kill из дашборда пишет его без tmp+rename), отдаём прошлую удачную
// версию — иначе задача на миг «исчезала» бы из списка и тут же появлялась снова.
const jobCache = new Map(); // имя папки -> { mtimeMs, size, job }

function readJobCached(dir) {
  const file = path.join(JOBS_DIR, dir, 'job.json');
  let st;
  try { st = fs.statSync(file); } catch { jobCache.delete(dir); return null; }
  const hit = jobCache.get(dir);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.job;
  const job = readJson(file);
  if (!job) return hit ? hit.job : null;
  jobCache.set(dir, { mtimeMs: st.mtimeMs, size: st.size, job });
  return job;
}

// Все задачи как [{ dir, job }] — через кэш; удалённые папки из кэша вычищаются.
function readAllJobs() {
  const dirs = listJobDirs();
  const alive = new Set(dirs);
  for (const d of jobCache.keys()) if (!alive.has(d)) jobCache.delete(d);
  const out = [];
  for (const dir of dirs) {
    const job = readJobCached(dir);
    if (job) out.push({ dir, job });
  }
  return out;
}

// Первая строка ТЗ продолжения («допиши тесты…») — чтобы в таблице строки одной
// сессии отличались друг от друга. prompt.md после создания не меняется,
// поэтому читаем один раз.
const promptPreviewCache = new Map();

function promptPreview(dir) {
  if (promptPreviewCache.has(dir)) return promptPreviewCache.get(dir);
  const text = readFileSafe(path.join(JOBS_DIR, dir, 'prompt.md'), 0);
  if (text == null) return null; // файла ещё нет — не кэшируем, попробуем позже
  const line = (text.split(/\r?\n/).find(l => l.trim()) || '').trim().slice(0, 120);
  promptPreviewCache.set(dir, line || null);
  return line || null;
}

// Сводка задачи для таблицы (REST, WebSocket и SSE отдают один и тот же вид).
// Тяжёлые поля (полный diagnosis, логи) здесь намеренно не отдаются — они
// приходят в /api/jobs/:id по клику.
function jobSummary({ dir, job: j }) {
  const health = classifyJobHealth(j);
  return {
    id: j.id || dir,
    task: j.task,
    agent: j.agent || null,
    status: j.status,
    // причина остановки не по ошибке (лимит шагов) — UI показывает «пауза»
    stopReason: classifyStopReason(j),
    model: j.model ? j.model.split('/').pop() : (j.runner || '?'),
    runner: j.runner,
    worktree: !!j.worktree,
    variant: j.variant || null,
    verifyStatus: j.verifyStatus || null,
    verifyCmd: j.verifyCmd || null,
    changedFiles: j.changedFiles,
    healthWarnings: health.warnings,
    diagnosisOutcome: (j.diagnosis && j.diagnosis.outcome) || null,
    diagnosisError: (j.diagnosis && j.diagnosis.lastErrorMessage) || null,
    tokens: j.tokens || null,
    cost: typeof j.cost === 'number' ? j.cost : null,
    error: j.error || null,
    // связка задач одной сессии: UI рисует их цепочкой «1/3, 2/3, 3/3»
    sessionId: j.sessionId || null,
    continuesJob: j.continuesJob || null,
    promptPreview: j.continuesJob ? promptPreview(dir) : null,
    integration: j.integration || null,
    createdAt: j.createdAt,
    startedAt: j.startedAt,
    finishedAt: j.finishedAt,
    duration: fmtDuration(j.startedAt, j.finishedAt),
    autoCommitted: j.autoCommitted,
  };
}

function summarizeAllJobs() {
  return readAllJobs()
    .map(jobSummary)
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
}

// ---------------------------------------------------- запуск CLI без блокировки

// Асинхронный запуск `bash bin/agent …`. Раньше здесь был execFileSync: пока
// шёл test-run (до 150 с) или cleanup, весь процесс дашборда замирал — не
// отвечали ни страница, ни WebSocket. По 'exit' ждём 'close' лишь короткое
// время: фоновая задача, запущенная командой, может держать pipe открытым.
function runAgentCli(args, timeoutMs) {
  return new Promise((resolve) => {
    const bin = path.join(AI_HOME, 'bin', 'agent');
    let stdout = '', stderr = '', done = false, graceTimer = null;
    const child = spawn('bash', [bin, ...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(killTimer); clearTimeout(graceTimer);
      resolve({ code, stdout, stderr });
    };
    const killTimer = setTimeout(() => {
      stderr += '\nтаймаут ' + Math.round(timeoutMs / 1000) + ' с — процесс остановлен';
      try { child.kill(); } catch { /* уже завершился */ }
      finish(124);
    }, timeoutMs);
    child.stdout.on('data', c => { stdout += c; });
    child.stderr.on('data', c => { stderr += c; });
    child.on('error', e => { stderr += e.message; finish(127); });
    child.on('exit', code => { graceTimer = setTimeout(() => finish(code == null ? 1 : code), 300); });
    child.on('close', code => finish(code == null ? 1 : code));
  });
}

// ---------------------------------------------------- защита от чужих сайтов

// Сервер слушает 127.0.0.1, но любая открытая вкладка может слать запросы на
// localhost. Host ловит DNS-rebinding, Origin — кросс-сайтовые POST/DELETE
// (kill, delete, accept, test-run запускает агента!). Запросы без Origin
// (curl, тесты, CLI) пропускаем.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function isLocalHostHeader(req) {
  const host = String(req.headers.host || '');
  const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
  return LOCAL_HOSTS.has(name.toLowerCase());
}

function isSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

// Допустимы ли id задачи в аргументах CLI: без путей и без «-флагов».
function isSafeJobId(id) {
  return typeof id === 'string' && id.length > 0 && id.length < 300 &&
    !/[\\/\0]/.test(id) && !id.startsWith('-') && id !== '.' && id !== '..';
}

function readFileSafe(file, maxLines) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    if (!maxLines) return text;
    return text.split('\n').slice(-maxLines).join('\n');
  } catch { return null; }
}

function fmtDuration(from, to) {
  if (!from || !to) return '---';
  const d = new Date(to) - new Date(from);
  if (isNaN(d) || d < 0) return '---';
  const s = Math.floor(d / 1000);
  if (s < 60) return s + 'с';
  if (s < 3600) return Math.floor(s / 60) + 'м ' + (s % 60) + 'с';
  return Math.floor(s / 3600) + 'ч ' + Math.floor((s % 3600) / 60) + 'м';
}

function json(res, data, code) {
  res.writeHead(code || 200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Pragma': 'no-cache',
  });
  res.end(JSON.stringify(data));
}

function error(res, code, msg) {
  json(res, { error: msg }, code);
}

// ---------------------------------------------------------------- память

// ------------------------------------------------------------------ API

function apiJobs(req, res) {
  // Parse pagination params from query string
  const u = new URL(req.url, 'http://localhost');
  const limit = Math.min(parseInt(u.searchParams.get('limit'), 10) || 50, 200);
  const offset = Math.max(parseInt(u.searchParams.get('offset'), 10) || 0, 0);

  const allJobs = summarizeAllJobs();
  const total = allJobs.length;
  const jobs = allJobs.slice(offset, offset + limit);
  json(res, { jobs, total });
}

function apiJobDetail(req, res, jobId) {
  const dir = path.join(JOBS_DIR, jobId);
  if (!fs.existsSync(dir)) return error(res, 404, 'задача не найдена');

  const j = readJob(jobId);
  if (!j) return error(res, 500, 'не удалось прочитать job.json');

  const result = readFileSafe(path.join(dir, 'result.md'), 0);
  const stderr = readFileSafe(path.join(dir, 'stderr.log'), 100);
  const verifyLog = readFileSafe(path.join(dir, 'verify.log'), 50);
  const diagnosis = readJson(path.join(dir, 'diagnosis.json'));
  const prompt = readFileSafe(path.join(dir, 'prompt.md'), 0);

  const health = classifyJobHealth(j);
  json(res, {
    ...j,
    healthWarnings: health.warnings,
    stopReason: classifyStopReason(j),
    resultMd: result,
    stderrTail: stderr,
    verifyLogTail: verifyLog,
    diagnosis: diagnosis || j.diagnosis || null,
    promptMd: prompt,
  });
}

function apiSessionLog(req, res, jobId) {
  const dir = path.join(JOBS_DIR, jobId);
  if (!fs.existsSync(dir)) return error(res, 404, 'задача не найдена');

  const j = readJob(jobId);
  if (!j) return error(res, 500, 'не удалось прочитать job.json');

  const outFile = path.join(dir, 'out.jsonl');

  let raw = '';
  try {
    raw = fs.readFileSync(outFile, 'utf8');
  } catch {
    return json(res, { steps: [], totalSteps: 0 });
  }

  const u = new URL(req.url, 'http://localhost');
  const limitParam = parseInt(u.searchParams.get('limit'), 10);
  const limit = Math.min(limitParam || 500, 500);

  const lines = raw.split('\n');
  const allSteps = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      const step = transformStep(entry);
      if (step) allSteps.push(step);
    } catch {
      // broken/truncated JSON line — skip silently
      continue;
    }
  }

  const totalSteps = allSteps.length;
  const truncated = allSteps.length > limit;
  const steps = totalSteps > limit ? allSteps.slice(-limit) : allSteps;

  json(res, { steps, totalSteps, truncated });
}

function transformStep(entry) {
  if (!entry || !entry.type) return null;

  if (entry.type === 'tool_use') {
    const part = entry.part || {};
    const state = part.state || {};
    const time = state.time || {};
    const durationMs = (time.start && time.end) ? time.end - time.start : undefined;

    let output = state.output || '';
    let outputTruncated = false;
    if (output && output.length > 2000) {
      output = output.slice(0, 2000);
      outputTruncated = true;
    }

    return {
      type: 'tool_use',
      tool: part.tool || 'unknown',
      title: state.title || part.title || '',
      timestamp: entry.timestamp || 0,
      input: state.input || {},
      output: output,
      outputTruncated: outputTruncated,
      durationMs: durationMs,
      status: state.status || 'unknown',
    };
  }

  if (entry.type === 'step_finish') {
    const part = entry.part || {};
    return {
      type: 'step_finish',
      timestamp: entry.timestamp || 0,
      tokens: part.tokens || null,
      cost: typeof part.cost === 'number' ? part.cost : null,
    };
  }

  if (entry.type === 'step_start') {
    return {
      type: 'step_start',
      timestamp: entry.timestamp || 0,
    };
  }

  return null;
}

function apiStats(req, res) {
  const jobs = readAllJobs().map(x => x.job).filter(j => j.status && j.status !== 'pending');

  const agg = (list) => {
    const total = list.length;
    const completed = list.filter(j => j.status === 'completed').length;
    const failed = list.filter(j => j.status === 'failed').length;
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
    return { total, completed, failed, tokens, cost };
  };

  const byModel = new Map();
  const byDay = new Map();
  for (const j of jobs) {
    const m = j.model ? j.model.split('/').pop() : (j.runner || 'unknown');
    if (!byModel.has(m)) byModel.set(m, []);
    byModel.get(m).push(j);

    const day = (j.createdAt || '').slice(0, 10);
    if (day && !byDay.has(day)) byDay.set(day, []);
    if (day) byDay.get(day).push(j);
  }

  const byAgent = new Map();
  for (const j of jobs) {
    const key = j.agent || 'unknown';
    if (!byAgent.has(key)) byAgent.set(key, []);
    byAgent.get(key).push(j);
  }

  json(res, {
    all: agg(jobs),
    byModel: Object.fromEntries([...byModel.entries()].map(([k, v]) => [k, agg(v)])),
    byAgent: Object.fromEntries([...byAgent.entries()].map(([k, v]) => [k, agg(v)])),
    byDay: Object.fromEntries([...byDay.entries()].sort().map(([k, v]) => [k, agg(v)])),
  });
}

function apiCapabilities(req, res) {
  const caps = {};
  try {
    for (const fname of fs.readdirSync(CAP_DIR)) {
      if (!fname.endsWith('.json')) continue;
      const name = fname.replace(/\.json$/, '');
      const c = readJson(path.join(CAP_DIR, fname));
      if (c) caps[name] = { model: c.model, worktree: !!c.worktree, variant: c.variant || null };
    }
  } catch {}
  json(res, caps);
}

function apiUpdateCapability(req, res, name) {
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) return error(res, 400, 'недопустимое имя');

  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    let updates;
    try { updates = JSON.parse(body); } catch { return error(res, 400, 'некорректный JSON'); }

    const file = path.join(CAP_DIR, name + '.json');
    const cap = readJson(file);
    if (!cap) return error(res, 404, 'capability не найдена');

    if (updates.model !== undefined) cap.model = updates.model;
    if (updates.worktree !== undefined) cap.worktree = updates.worktree;
    if (updates.variant !== undefined) cap.variant = updates.variant;

    try {
      fs.writeFileSync(file, JSON.stringify(cap, null, 2) + '\n');
      json(res, { ok: true, capability: { name, model: cap.model, worktree: !!cap.worktree, variant: cap.variant || null } });
    } catch (e) {
      error(res, 500, 'не удалось записать: ' + e.message);
    }
  });
}

async function apiCleanup(req, res) {
  let output = '';

  try {
    // worktree-gc по каждому репозиторию, где были задачи
    const repos = new Set();
    for (const { job } of readAllJobs()) if (job.repo) repos.add(job.repo);

    for (const repo of repos) {
      const r = await runAgentCli(['worktree-gc', '--repo', repo, '--apply'], 10000);
      output += r.code === 0
        ? '[worktree-gc ' + repo + ']\n' + r.stdout + '\n'
        : '[worktree-gc ' + repo + '] ERROR: ' + (r.stderr || r.stdout) + '\n';
    }

    // чистка старых задач
    const c = await runAgentCli(['clean', '--days', '7'], 10000);
    output += c.code === 0 ? '[clean]\n' + c.stdout + '\n' : '[clean] ERROR: ' + (c.stderr || c.stdout) + '\n';

    json(res, { ok: true, output });
  } catch (e) {
    error(res, 500, 'ошибка очистки: ' + e.message);
  }
}

function apiKillJob(req, res, jobId) {
  const dir = path.join(JOBS_DIR, jobId);
  if (!fs.existsSync(dir)) return error(res, 404, 'задача не найдена');

  const j = readJson(path.join(dir, 'job.json'));
  if (!j) return error(res, 500, 'не удалось прочитать job.json');

  if (j.status !== 'running') return error(res, 400, 'можно убить только задачу в статусе running');

  const pid = j.pid;
  if (pid && pid !== 'null') {
    // Unix: SIGTERM
    try {
      process.kill(Number(pid), 'SIGTERM');
    } catch (e) {
      // Windows: taskkill /F /T /PID
      if (process.platform === 'win32') {
        try {
          execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore', timeout: 5000 });
        } catch (e2) {
          // процесс уже мёртв — не фатально
        }
      }
    }
  }

  j.status = 'killed';
  j.finishedAt = new Date().toISOString();
  try {
    fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify(j, null, 2) + '\n');
    json(res, { ok: true, status: 'killed' });
  } catch (e) {
    error(res, 500, 'не удалось обновить статус: ' + e.message);
  }
}

async function apiDeleteJob(req, res, jobId) {
  const dir = path.join(JOBS_DIR, jobId);
  if (!fs.existsSync(dir)) return error(res, 404, 'задача не найдена');

  // Попробовать убрать worktree (не фатально, если не получилось). Асинхронно:
  // git worktree remove на большом репозитории может идти секундами.
  const j = readJson(path.join(dir, 'job.json'));
  if (j && j.worktree && j.cwd && j.repo && fs.existsSync(j.cwd)) {
    await new Promise((resolve) => {
      require('child_process').execFile('git', ['-C', j.repo, 'worktree', 'remove', j.cwd],
        { timeout: 10000, windowsHide: true }, () => resolve()); // ошибку игнорируем — удаляем директорию задачи в любом случае
    });
  }

  try {
    fs.rmSync(dir, { recursive: true, force: true });
    json(res, { ok: true });
  } catch (e) {
    error(res, 500, 'не удалось удалить задачу: ' + e.message);
  }
}

// ------------------------------------------------------------------ SSE

function sendSSEEvent(res, eventType, data) {
  if (!res.writableEnded) {
    res.write(`event: ${eventType}\n`);
    res.write('data: ' + JSON.stringify(data) + '\n');
    res.write('\n');
  }
}

// Сводка всех задач для SSE/WebSocket (раньше — дубль apiJobs).
function emitJobsUpdate() {
  return summarizeAllJobs();
}

function apiEvents(req, res) {
  // Local state for each SSE connection
  let lastJobsSnapshot = null;
  let sseInterval = null;

  // Set SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  // Send initial comment to keep connection alive
  res.write(':ok\n\n');

  // Send initial snapshot
  const initialJobs = emitJobsUpdate(res);
  sendSSEEvent(res, 'init', initialJobs);
  lastJobsSnapshot = JSON.stringify(initialJobs);

  // Set up interval to check for changes
  sseInterval = setInterval(() => {
    const currentJobs = emitJobsUpdate(res);
    const currentSnapshot = JSON.stringify(currentJobs);
    
    if (currentSnapshot !== lastJobsSnapshot) {
      // Find changed jobs
      const changes = [];
      if (!lastJobsSnapshot) {
        // First update after init
        changes.push(...currentJobs);
      } else {
        const lastJobs = JSON.parse(lastJobsSnapshot);
        const currentMap = new Map(currentJobs.map(j => [j.id, j]));
        const lastMap = new Map(lastJobs.map(j => [j.id, j]));
        
        // Check for new or changed jobs
        for (const [id, job] of currentMap) {
          const lastJob = lastMap.get(id);
          if (!lastJob || JSON.stringify(lastJob) !== JSON.stringify(job)) {
            changes.push(job);
          }
        }
        
        // Check for deleted jobs
        for (const [id] of lastMap) {
          if (!currentMap.has(id)) {
            changes.push({ id, status: 'deleted' });
          }
        }
      }
      
      if (changes.length > 0) {
        sendSSEEvent(res, 'job-update', changes);
        lastJobsSnapshot = currentSnapshot;
      }
    }
  }, 1500); // Check every 1.5 seconds

  // Handle client disconnection
  req.on('close', () => {
    if (sseInterval) {
      clearInterval(sseInterval);
      sseInterval = null;
    }
    res.end();
  });

  // Handle client abort
  req.on('abort', () => {
    if (sseInterval) {
      clearInterval(sseInterval);
      sseInterval = null;
    }
    res.end();
  });
}

// ------------------------------------------------------------------ models

let modelsCache = null;
let modelsPromise = null; // один общий запрос, если /api/models дёрнули несколько раз подряд

async function apiModels(req, res) {
  if (modelsCache) return json(res, modelsCache);
  if (!modelsPromise) modelsPromise = loadModels().finally(() => { modelsPromise = null; });
  json(res, await modelsPromise);
}

async function loadModels() {
  const defaults = [
    // бесплатные
    { provider: 'free', id: 'opencode/deepseek-v4-flash-free', label: '🆓 DeepSeek V4 Flash (free)' },
    { provider: 'free', id: 'openrouter/google/gemma-4-26b-a4b-it:free', label: '🆓 Gemma 4 26B (OR free)' },
    // DeepSeek
    { provider: 'deepseek', id: 'deepseek/deepseek-v4-flash', label: 'DeepSeek V4 Flash' },
    { provider: 'deepseek', id: 'deepseek/deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
    { provider: 'deepseek', id: 'deepseek/deepseek-chat', label: 'DeepSeek Chat' },
    { provider: 'deepseek', id: 'deepseek/deepseek-reasoner', label: 'DeepSeek Reasoner (R1)' },
    // OpenRouter
    { provider: 'openrouter', id: 'openrouter/anthropic/claude-sonnet-5', label: 'Claude Sonnet 5 (OR)' },
    { provider: 'openrouter', id: 'openrouter/anthropic/claude-haiku-4.5', label: 'Claude Haiku 4.5 (OR)' },
    { provider: 'openrouter', id: 'openrouter/openai/gpt-5.1-codex', label: 'GPT-5.1 Codex (OR)' },
    { provider: 'openrouter', id: 'openrouter/google/gemini-2.5-pro', label: 'Gemini 2.5 Pro (OR)' },
    // OpenAI
    { provider: 'openai', id: 'openai/gpt-5.1-codex', label: 'GPT-5.1 Codex (OpenAI)' },
  ];

  try {
    // на Windows opencode не всегда на PATH у Node — ищем через where/which
    let cmd = 'opencode models 2>/dev/null';
    if (process.platform === 'win32') {
      try {
        const { stdout } = await execP('where opencode 2>NUL', { encoding: 'utf8', timeout: 3000, windowsHide: true });
        const p = stdout.trim().split('\n')[0];
        if (p) cmd = '"' + p.trim() + '" models';
      } catch { /* fallback to 'opencode' */ }
    }
    const { stdout: out } = await execP(cmd, { encoding: 'utf8', timeout: 8000, windowsHide: true });
    const live = out.trim().split('\n').filter(l => l.includes('/')).map(l => {
      const id = l.trim().split(/\s+/)[0];
      const [provider] = id.split('/');
      return { provider, id, label: id };
    });
    if (live.length > 0) modelsCache = { models: live, source: 'opencode', cached: new Date().toISOString() };
  } catch { /* opencode unavailable, use defaults */ }

  if (!modelsCache) modelsCache = { models: defaults, source: 'defaults', cached: null };
  return modelsCache;
}

// Раннер opencode — шлюз к множеству моделей разных провайдеров (см. /api/models).
// Остальные раннеры — это конкретный CLI со своим фиксированным каталогом моделей,
// поэтому для них список курируется вручную (см. research/*-cli-headless.md).
const RUNNER_MODELS = {
  claude: ['claude-sonnet-5', 'claude-opus-4-8', 'claude-haiku-4-5-20251001', 'claude-fable-5'],
  codex: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini'],
  gemini: [], // experimental — не тестирован, точный каталог не проверен
};

function apiRunners(req, res) {
  const dir = path.join(__dirname, 'runners');
  let names = [];
  try {
    names = fs.readdirSync(dir).filter(f => f.endsWith('.js')).map(f => f.replace(/\.js$/, ''));
  } catch {}
  const runners = names.map(name => ({
    name,
    models: name === 'opencode' ? null : (RUNNER_MODELS[name] || []),
  }));
  json(res, { runners });
}

// ------------------------------------------------------------------ agents API

const AGENTS_DIR = path.join(AI_HOME, 'agents');

function apiAgents(req, res) {
  const agents = [];
  try {
    // счётчик running по агентам — один проход по задачам, а не по разу на агента
    const runningByAgent = new Map();
    for (const { job } of readAllJobs()) {
      if (job.status === 'running' && job.agent) {
        runningByAgent.set(job.agent, (runningByAgent.get(job.agent) || 0) + 1);
      }
    }

    for (const f of fs.readdirSync(AGENTS_DIR)) {
      if (!f.endsWith('.json')) continue;
      const a = JSON.parse(fs.readFileSync(path.join(AGENTS_DIR, f), 'utf8'));
      const running = runningByAgent.get(a.name) || 0;

      agents.push({
        name: a.name,
        description: a.description || '',
        mode: a.mode || 'primary',
        model: a.model || '',
        runner: a.runner || '',
        variant: a.variant || null,
        worktree: !!a.worktree,
        timeout: a.timeout || 1800,
        autoCommit: !!a.autoCommit,
        temperature: a.temperature,
        maxSteps: a.maxSteps || null,
        color: a.color || '#2563eb',
        permissions: a.permissions || {},
        systemPrompt: a.systemPrompt || '',
        mcp: a.mcp || [],
        running,
      });
    }
  } catch {}
  json(res, agents);
}

function apiAgentDetail(req, res, name) {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) return error(res, 400, 'недопустимое имя');
  const file = path.join(AGENTS_DIR, name + '.json');
  if (!fs.existsSync(file)) return error(res, 404, 'агент не найден');
  try {
    const agent = JSON.parse(fs.readFileSync(file, 'utf8'));
    agent._mtime = Math.floor(fs.statSync(file).mtimeMs); // время модификации файла — для защиты от stale-записи
    json(res, agent);
  } catch (e) {
    error(res, 500, 'не удалось прочитать агента');
  }
}

function apiAgentSave(req, res, name) {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) return error(res, 400, 'недопустимое имя');
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    let agent;
    try { agent = JSON.parse(body); } catch { return error(res, 400, 'некорректный JSON'); }

    const file = path.join(AGENTS_DIR, name + '.json');

    // Защита от перезаписи устаревшими данными: если клиент прислал _loadedAt
    // (время загрузки формы) и файл на диске новее — отказываем, 409 Conflict.
    if (agent._loadedAt != null) {
      try {
        const stat = fs.statSync(file);
        if (Math.floor(stat.mtimeMs) > agent._loadedAt) {
          return error(res, 409,
            'файл изменился с момента открытия — обнови и попробуй снова');
        }
      } catch { /* файла ещё нет — ок, создадим */ }
    }

    // clean service fields before writing to file
    delete agent._loadedAt;
    delete agent._mtime;
    agent.name = name;

    try {
      fs.mkdirSync(AGENTS_DIR, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(agent, null, 2) + '\n');

      // Generate .md once, then deploy to both local and global folders
      let md;
      try {
        md = toOpenCodeMd(agent);
      } catch {
        md = null;
      }

      if (md) {
        // auto-deploy to local .opencode/agents/<name>.md
        try {
          const deployDir = path.join(AI_HOME, '.opencode', 'agents');
          fs.mkdirSync(deployDir, { recursive: true });
          fs.writeFileSync(path.join(deployDir, name + '.md'), md);
        } catch (deployErr) {
          console.error('deploy-agent: не удалось задеплоить ' + name + ': ' + deployErr.message);
          // не прерываем ответ — JSON уже сохранён
        }

        // auto-deploy to global ~/.config/opencode/agents/<name>.md
        // (same path as deploy-agent.js --target --global)
        try {
          const home = process.env.HOME || process.env.USERPROFILE || '';
          if (home) {
            const globalAgentsDir = path.join(home, '.config', 'opencode', 'agents');
            fs.mkdirSync(globalAgentsDir, { recursive: true });
            fs.writeFileSync(path.join(globalAgentsDir, name + '.md'), md);
          }
        } catch (globalDeployErr) {
          console.error('deploy-agent(global): не удалось задеплоить ' + name + ': ' + globalDeployErr.message);
          // не прерываем ответ — JSON уже сохранён
        }
      }

      json(res, { ok: true, name, deployed: true });
    } catch (e) {
      error(res, 500, 'не удалось сохранить: ' + e.message);
    }
  });
}

function apiAgentDelete(req, res, name) {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) return error(res, 400, 'недопустимое имя');
  const file = path.join(AGENTS_DIR, name + '.json');
  if (!fs.existsSync(file)) return error(res, 404, 'агент не найден');
  try {
    fs.unlinkSync(file);
    json(res, { ok: true, name });
  } catch (e) {
    error(res, 500, 'не удалось удалить: ' + e.message);
  }
}

function apiAgentExport(req, res, name) {
  const file = path.join(AGENTS_DIR, name + '.json');
  if (!fs.existsSync(file)) return error(res, 404, 'агент не найден');
  try {
    const agent = JSON.parse(fs.readFileSync(file, 'utf8'));
    // inline deploy-agent logic
    const fm = {};
    if (agent.description) fm.description = agent.description;
    if (agent.mode) fm.mode = agent.mode;
    if (agent.model) fm.model = agent.model;
    if (agent.temperature != null) fm.temperature = agent.temperature;
    if (agent.color) fm.color = agent.color;
    if (agent.maxSteps) fm.maxSteps = agent.maxSteps;
    if (agent.permissions && Object.keys(agent.permissions).length > 0) {
      fm.permission = agent.permissions;
    }
    let yaml = '';
    for (const [k, v] of Object.entries(fm)) {
      if (v === null || v === undefined) continue;
      if (typeof v === 'object') {
        yaml += k + ':\n';
        for (const [pk, pv] of Object.entries(v)) yaml += '  ' + pk + ': ' + pv + '\n';
      } else {
        yaml += k + ': ' + v + '\n';
      }
    }
    const md = '---\n' + yaml + '---\n\n' + (agent.systemPrompt || '') + '\n';
    res.writeHead(200, {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': 'attachment; filename="' + name + '.md"',
    });
    res.end(md);
  } catch (e) {
    error(res, 500, 'export error: ' + e.message);
  }
}

function apiAgentTestRun(req, res, name) {
  const file = path.join(AGENTS_DIR, name + '.json');
  if (!fs.existsSync(file)) return error(res, 404, 'агент не найден');

  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    let params;
    try { params = JSON.parse(body); } catch { return error(res, 400, 'некорректный JSON'); }
    const prompt = params.prompt || 'echo ok';
    const repo = params.repo || AI_HOME;

    runAgentCli([
      'delegate',
      '--task', 'test-' + name,
      '--repo', repo,
      '--agent', name,
      '--prompt', prompt,
      '--timeout', '120',
    ], 150000).then((r) => {
      if (r.code === 0) return json(res, { ok: true, output: r.stdout.slice(-2000) });
      const out = r.stdout + '\n' + r.stderr;
      json(res, { ok: false, output: out.slice(-2000), error: 'код выхода ' + r.code });
    }).catch(e => error(res, 500, e.message));
  });
}

// ------------------------------------------------------------------ действия над задачей

// Общая часть для send/accept/discard: id безопасен, задача существует.
function jobForAction(res, jobId) {
  if (!isSafeJobId(jobId)) { error(res, 400, 'недопустимый id задачи'); return null; }
  if (!fs.existsSync(path.join(JOBS_DIR, jobId))) { error(res, 404, 'задача не найдена'); return null; }
  const j = readJob(jobId);
  if (!j) { error(res, 500, 'не удалось прочитать job.json'); return null; }
  return j;
}

// Текст ошибки CLI для показа в тосте: stderr, без хвоста стека.
function cliError(r) {
  return ((r.stderr || r.stdout || 'ошибка').trim().split('\n').slice(0, 4).join('\n')).slice(0, 600);
}

// POST /api/jobs/:id/send {message} — продолжить сессию новой задачей (agent send).
// Тот же механизм, что у `agent send`: новая задача резюмирует сессию агента.
function apiSendToJob(req, res, jobId) {
  const j = jobForAction(res, jobId);
  if (!j) return;
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    let data;
    try { data = JSON.parse(body); } catch { return error(res, 400, 'некорректный JSON'); }
    const message = String(data.message || '').trim();
    if (!message) return error(res, 400, 'пустое сообщение');
    if (message.length > 20000) return error(res, 400, 'сообщение длиннее 20000 символов');
    if (j.status === 'running') return error(res, 409, 'задача ещё выполняется — дождись завершения или останови её');
    if (!j.sessionId) return error(res, 400, 'у задачи нет сессии — продолжать нечего');

    runAgentCli(['send', jobId, message], 30000).then((r) => {
      if (r.code !== 0) return error(res, 409, cliError(r));
      // первая строка stdout — id новой задачи (см. cmd_send)
      json(res, { ok: true, jobId: r.stdout.trim().split(/\r?\n/)[0], output: r.stdout.trim() });
    }).catch(e => error(res, 500, e.message));
  });
}

// POST /api/jobs/:id/accept | /discard — squash-мердж ветки задачи или выброс
// (agent accept / agent discard). Все проверки безопасности — в самом CLI.
function apiIntegrateJob(req, res, jobId, action) {
  const j = jobForAction(res, jobId);
  if (!j) return;
  if (!j.worktree) return error(res, 400, 'задача не в worktree — ' + (action === 'accept' ? 'принимать' : 'отбрасывать') + ' нечего');
  if (j.status === 'running') return error(res, 409, 'задача ещё выполняется');

  runAgentCli([action, jobId], 60000).then((r) => {
    if (r.code !== 0) return error(res, 409, cliError(r));
    json(res, { ok: true, output: r.stdout.trim() });
  }).catch(e => error(res, 500, e.message));
}

// ------------------------------------------------------------------ MCP servers

function apiMcpServers(req, res) {
  const configFile = path.join(os.homedir(), '.config', 'opencode', 'opencode.json');
  try {
    const raw = fs.readFileSync(configFile, 'utf8');
    const config = JSON.parse(raw);
    const mcpSection = config && config.mcp;
    if (!mcpSection || typeof mcpSection !== 'object') return json(res, []);

    const servers = [];
    for (const [name, def] of Object.entries(mcpSection)) {
      if (!def || typeof def !== 'object') continue;
      servers.push({
        name,
        type: def.type || 'unknown',
        enabled: !!def.enabled,
      });
    }
    json(res, servers);
  } catch {
    // файла нет или невалидный JSON — не ошибка
    json(res, []);
  }
}

// ------------------------------------------------------------------ сервер

function serveHtml(res) {
  try {
    const html = fs.readFileSync(HTML_FILE, 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('dashboard.html не найден: ' + e.message);
  }
}

function createServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;

    // Защита от чужих сайтов: чужой Host (DNS-rebinding) и кросс-сайтовые
    // изменяющие запросы отклоняем сразу.
    if (!isLocalHostHeader(req)) return error(res, 403, 'недопустимый Host');
    if (req.method !== 'GET' && req.method !== 'HEAD' && !isSameOrigin(req)) {
      return error(res, 403, 'недопустимый Origin');
    }

    // Асинхронные обработчики: необработанный reject не должен оставлять
    // запрос висеть без ответа.
    const run = (promise) => Promise.resolve(promise).catch((e) => {
      if (!res.headersSent) error(res, 500, 'internal error: ' + e.message);
      else res.end();
    });

    try {
      if (p === '/' || p === '/index.html') return serveHtml(res);

      // API routes
      const m = p.match(/^\/api\/jobs\/([^/]+)\/result$/);
      if (m) {
        const j = readJob(m[1]);
        if (!j) return error(res, 404, 'задача не найдена');
        const txt = readFileSafe(path.join(JOBS_DIR, m[1], 'result.md'), 0) || '';
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end(txt);
      }

      const ms = p.match(/^\/api\/jobs\/([^/]+)\/stderr$/);
      if (ms) {
        const j = readJob(ms[1]);
        if (!j) return error(res, 404, 'задача не найдена');
        const txt = readFileSafe(path.join(JOBS_DIR, ms[1], 'stderr.log'), 100) || '';
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end(txt);
      }

      // Session log
      const mSess = p.match(/^\/api\/jobs\/([^/]+)\/session-log$/);
      if (mSess) return apiSessionLog(req, res, mSess[1]);

      // Kill running job
      const mKill = p.match(/^\/api\/jobs\/([^/]+)\/kill$/);
      if (mKill && req.method === 'POST') return apiKillJob(req, res, mKill[1]);

      // Продолжить сессию / принять или отбросить worktree-ветку
      const mSend = p.match(/^\/api\/jobs\/([^/]+)\/send$/);
      if (mSend && req.method === 'POST') return apiSendToJob(req, res, mSend[1]);
      const mInt = p.match(/^\/api\/jobs\/([^/]+)\/(accept|discard)$/);
      if (mInt && req.method === 'POST') return apiIntegrateJob(req, res, mInt[1], mInt[2]);

      // Delete single job
      const mDel = p.match(/^\/api\/jobs\/([^/]+)$/);
      if (mDel && req.method === 'DELETE') return run(apiDeleteJob(req, res, mDel[1]));

      if (p === '/api/jobs') return apiJobs(req, res);
      if (p.match(/^\/api\/jobs\//)) {
        const jid = p.split('/')[3];
        return apiJobDetail(req, res, jid);
      }
      if (p === '/api/stats') return apiStats(req, res);
      if (p === '/api/capabilities') return apiCapabilities(req, res);
      if (p.match(/^\/api\/capabilities\//) && req.method === 'POST') {
        const cname = p.split('/')[3];
        return apiUpdateCapability(req, res, cname);
      }
      if (p === '/api/cleanup' && req.method === 'POST') return run(apiCleanup(req, res));

      if (p === '/api/mcp-servers') return apiMcpServers(req, res);
      if (p === '/api/models') return run(apiModels(req, res));
      if (p === '/api/runners') return apiRunners(req, res);

      if (p === '/api/events') return apiEvents(req, res);

      // agents
      if (p === '/api/agents' && req.method === 'GET') return apiAgents(req, res);
      if (p.match(/^\/api\/agents\//)) {
        const parts = p.split('/');
        const aname = parts[3];
        const action = parts[4];
        if (action === 'export') return apiAgentExport(req, res, aname);
        if (action === 'test-run' && req.method === 'POST') return apiAgentTestRun(req, res, aname);
        if (req.method === 'GET') return apiAgentDetail(req, res, aname);
        if (req.method === 'POST' || req.method === 'PUT') return apiAgentSave(req, res, aname);
        if (req.method === 'DELETE') return apiAgentDelete(req, res, aname);
      }

      error(res, 404, 'not found');
    } catch (e) {
      error(res, 500, 'internal error: ' + e.message);
    }
  });

  // --- WebSocket server for live job updates ---
  const wss = new WebSocketServer({
    server,
    // та же защита, что у HTTP: сокет не открываем чужим сайтам
    verifyClient: ({ req }) => isLocalHostHeader(req) && isSameOrigin(req),
  });

  // Общая для всех клиентов база для диффа: id -> { json, job }. Пока клиентов
  // нет — сбрасывается, чтобы первый подключившийся получил свежее состояние,
  // а не дифф от устаревшего снимка. При подключении НЕ перезаписывается:
  // раньше новое подключение затирало базу, и другие вкладки теряли изменения,
  // случившиеся между опросами (пока не нажмёшь F5).
  let wssBase = null;

  const takeSnapshot = () => {
    const snap = new Map();
    for (const job of emitJobsUpdate()) snap.set(job.id, { json: JSON.stringify(job), job });
    return snap;
  };

  // Один общий опрос на всех клиентов
  const wsPollInterval = setInterval(() => {
    if (wss.clients.size === 0) { wssBase = null; return; }

    const cur = takeSnapshot();
    const prev = wssBase;
    wssBase = cur;
    if (!prev) return;

    const changes = [];
    for (const [id, c] of cur) {
      const p = prev.get(id);
      if (!p || p.json !== c.json) changes.push({ type: 'job_updated', job: c.job });
    }
    for (const id of prev.keys()) {
      if (!cur.has(id)) changes.push({ type: 'job_deleted', jobId: id });
    }

    if (changes.length > 0) {
      const data = JSON.stringify(changes);
      for (const client of wss.clients) {
        if (client.readyState === 1 /* OPEN */) client.send(data);
      }
    }
  }, 1500); // Check every 1.5 seconds
  wsPollInterval.unref();

  // Пинг раз в 30 с: после сна ноутбука или обрыва сети «мёртвые» соединения
  // иначе висят вечно — вкладка считает себя подключённой и не обновляется.
  const wsPingInterval = setInterval(() => {
    for (const client of wss.clients) {
      if (client.isAlive === false) { client.terminate(); continue; }
      client.isAlive = false;
      try { client.ping(); } catch { /* сокет уже закрывается */ }
    }
  }, 30000);
  wsPingInterval.unref();

  // On new WebSocket connection
  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('error', () => { /* обрыв клиента не должен ронять процесс */ });

    // Полное текущее состояние. Клиент по первому сообщению сверяет свой кэш
    // (убирает задачи, удалённые за время обрыва).
    const cur = takeSnapshot();
    if (!wssBase) wssBase = cur;
    ws.send(JSON.stringify([...cur.values()].map(c => ({ type: 'job_updated', job: c.job }))));
  });

  // Cleanup polling on server close
  server.on('close', () => {
    clearInterval(wsPollInterval);
    clearInterval(wsPingInterval);
  });

  // Expose wss for testing
  server._wss = wss;

  return server;
}

// ------------------------------------------------------------------ main

function main() {
  const args = process.argv.slice(2);
  let port = 9191;
  let openBrowser = false;
  let idleExitMin = 0;
  let background = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1]) { port = parseInt(args[i + 1], 10); i++; }
    else if (args[i] === '--open') openBrowser = true;
    else if (args[i] === '--idle-exit' && args[i + 1]) { idleExitMin = parseFloat(args[i + 1]) || 0; i++; }
    else if (args[i] === '--background') background = true;
  }

  const url = 'http://localhost:' + port;
  const openUrl = () => {
    const cmd = process.platform === 'win32' ? 'cmd' : (process.platform === 'darwin' ? 'open' : 'xdg-open');
    const cargs = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
    try { spawn(cmd, cargs, { detached: true, stdio: 'ignore', windowsHide: true }).unref(); } catch {}
  };

  // --background: перезапускаем себя отвязанным процессом без окна и сразу
  // выходим — чтобы ярлык не оставлял висеть консоль.
  if (background) {
    const childArgs = [__filename, ...args.filter(a => a !== '--background')];
    spawn(process.execPath, childArgs, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    return;
  }

  const server = createServer();

  // Сервер уже запущен (порт занят) — не падаем, просто открываем браузер.
  // WebSocketServer пере-эмитит ошибки http-сервера на себе — без своего
  // обработчика процесс падает раньше, чем сработает обработчик ниже.
  server._wss.on('error', () => {});
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.log('дашборд уже запущен: ' + url);
      if (openBrowser) openUrl();
      process.exit(0);
    }
    throw e;
  });

  // --idle-exit N: выключиться через N минут, когда не осталось ни одной
  // открытой вкладки (WebSocket/SSE) и не было HTTP-запросов.
  if (idleExitMin > 0) {
    let lastActivity = Date.now();
    let sseClients = 0;
    server.on('request', (req) => {
      lastActivity = Date.now();
      if (req.url.startsWith('/api/events')) {
        sseClients++;
        req.on('close', () => { sseClients--; lastActivity = Date.now(); });
      }
    });
    server._wss.on('connection', (ws) => {
      ws.on('close', () => { lastActivity = Date.now(); });
    });
    setInterval(() => {
      if (server._wss.clients.size > 0 || sseClients > 0) { lastActivity = Date.now(); return; }
      if (Date.now() - lastActivity > idleExitMin * 60000) {
        console.log('нет открытых вкладок ' + idleExitMin + ' мин — выключаюсь');
        process.exit(0);
      }
    }, 15000).unref();
  }

  server.listen(port, '127.0.0.1', () => {
    console.log('дашборд .ai: ' + url);
    console.log('  jobs:    ' + url + '/api/jobs');
    console.log('  stats:   ' + url + '/api/stats');
    console.log('  caps:    ' + url + '/api/capabilities');
    if (idleExitMin > 0) console.log('  автовыключение через ' + idleExitMin + ' мин без открытых вкладок');
    console.log('  Ctrl+C чтобы остановить');

    if (openBrowser) openUrl();
  });
}

if (require.main === module || process.argv.length <= 1) {
  main();
}
module.exports = { createServer };
