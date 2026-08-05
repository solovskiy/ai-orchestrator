'use strict';

/**
 * Локальный веб-дашборд для .ai — просмотр задач, статистика, настройка
 * capability. Чистый Node.js HTTP, ноль зависимостей. Слушает только
 * localhost (127.0.0.1).
 *
 * Запуск: node lib/dashboard.js [--port N] [--open]
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const AI_HOME = path.resolve(__dirname, '..');
const JOBS_DIR = path.join(AI_HOME, 'jobs');
const CAP_DIR = path.join(AI_HOME, 'agents');
const HTML_FILE = path.join(__dirname, 'dashboard.html');
const { classifyJobHealth } = require('./agent.js');
const { toOpenCodeMd } = require('./deploy-agent.js');

// ------------------------------------------------------------------ утилиты

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
}

function listJobDirs() {
  try {
    return fs.readdirSync(JOBS_DIR)
      .filter(d => fs.statSync(path.join(JOBS_DIR, d)).isDirectory());
  } catch { return []; }
}

function readJob(dir) {
  return readJson(path.join(JOBS_DIR, dir, 'job.json'));
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
  if (isNaN(d)) return '---';
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

// ------------------------------------------------------------------ API

function apiJobs(req, res) {
  // Parse pagination params from query string
  const u = new URL(req.url, 'http://localhost');
  const limit = Math.min(parseInt(u.searchParams.get('limit'), 10) || 50, 200);
  const offset = Math.max(parseInt(u.searchParams.get('offset'), 10) || 0, 0);

  const allJobs = [];
  for (const dir of listJobDirs()) {
    const j = readJob(dir);
    if (!j) continue;
    const health = classifyJobHealth(j);
    allJobs.push({
      id: j.id,
      task: j.task,
      status: j.status,
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
      diagnosis: j.diagnosis || null,
      error: j.error || null,
      createdAt: j.createdAt,
      startedAt: j.startedAt,
      finishedAt: j.finishedAt,
      duration: fmtDuration(j.startedAt, j.finishedAt),
      autoCommitted: j.autoCommitted,
    });
  }
  allJobs.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
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
  const jobs = [];
  for (const dir of listJobDirs()) {
    const j = readJob(dir);
    if (!j || !j.status || j.status === 'pending') continue;
    jobs.push(j);
  }

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
    byCapability: Object.fromEntries([...byAgent.entries()].map(([k, v]) => [k, agg(v)])),
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

function apiCleanup(req, res) {
  const agentBin = path.join(AI_HOME, 'bin', 'agent');
  let output = '';

  try {
    // worktree-gc (dry-run first, then apply)
    const repos = new Set();
    for (const dir of listJobDirs()) {
      const j = readJob(dir);
      if (j && j.repo) repos.add(j.repo);
    }

    for (const repo of repos) {
      try {
        const r = execFileSync('bash', [agentBin, 'worktree-gc', '--repo', repo, '--apply'], {
          encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe']
        });
        output += '[worktree-gc ' + repo + ']\n' + r + '\n';
      } catch (e) {
        output += '[worktree-gc ' + repo + '] ERROR: ' + (e.stderr || e.message) + '\n';
      }
    }

    // clean old jobs
    try {
      const r = execFileSync('bash', [agentBin, 'clean', '--days', '7'], {
        encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe']
      });
      output += '[clean]\n' + r + '\n';
    } catch (e) {
      output += '[clean] ERROR: ' + (e.stderr || e.message) + '\n';
    }

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

function apiDeleteJob(req, res, jobId) {
  const dir = path.join(JOBS_DIR, jobId);
  if (!fs.existsSync(dir)) return error(res, 404, 'задача не найдена');

  // Попробовать убрать worktree (не фатально, если не получилось)
  const j = readJson(path.join(dir, 'job.json'));
  if (j && j.worktree && j.cwd && j.repo && fs.existsSync(j.cwd)) {
    try {
      execFileSync('git', ['-C', j.repo, 'worktree', 'remove', j.cwd], { stdio: 'ignore', timeout: 10000 });
    } catch (e) {
      // worktree не удаляется — продолжаем, удаляем директорию задачи
    }
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

function emitJobsUpdate(res) {
  const jobs = [];
  for (const dir of listJobDirs()) {
    const j = readJob(dir);
    if (!j) continue;
    const health = classifyJobHealth(j);
    jobs.push({
      id: j.id,
      task: j.task,
      status: j.status,
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
      diagnosis: j.diagnosis || null,
      error: j.error || null,
      createdAt: j.createdAt,
      startedAt: j.startedAt,
      finishedAt: j.finishedAt,
      duration: fmtDuration(j.startedAt, j.finishedAt),
      autoCommitted: j.autoCommitted,
    });
  }
  jobs.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  return jobs;
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

function apiModels(req, res) {
  if (modelsCache) return json(res, modelsCache);

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
    const { execSync } = require('child_process');
    // на Windows opencode не всегда на PATH у Node — ищем через where/which
    let cmd = 'opencode models 2>/dev/null';
    if (process.platform === 'win32') {
      try { const p = execSync('where opencode 2>NUL', { encoding: 'utf8', timeout: 3000 }).trim().split('\n')[0]; if (p) cmd = '"' + p + '" models'; }
      catch { /* fallback to 'opencode' */ }
    }
    const out = execSync(cmd, {
      encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'pipe'], shell: true,
    });
    const live = out.trim().split('\n').filter(l => l.includes('/')).map(l => {
      const id = l.trim().split(/\s+/)[0];
      const [provider, model] = id.split('/');
      return { provider, id, label: id };
    });
    if (live.length > 0) modelsCache = { models: live, source: 'opencode', cached: new Date().toISOString() };
  } catch { /* opencode unavailable, use defaults */ }

  if (!modelsCache) modelsCache = { models: defaults, source: 'defaults', cached: null };
  json(res, modelsCache);
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
    for (const f of fs.readdirSync(AGENTS_DIR)) {
      if (!f.endsWith('.json')) continue;
      const a = JSON.parse(fs.readFileSync(path.join(AGENTS_DIR, f), 'utf8'));

      // count running jobs for this agent
      let running = 0;
      for (const dir of listJobDirs()) {
        const j = readJob(dir);
        if (j && j.agent === a.name && j.status === 'running') running++;
      }

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

    try {
      const agentBin = path.join(AI_HOME, 'bin', 'agent');
      const result = execFileSync('bash', [
        agentBin, 'delegate',
        '--task', 'test-' + name,
        '--repo', repo,
        '--agent', name,
        '--prompt', prompt,
        '--timeout', '120',
      ], { encoding: 'utf8', timeout: 150000, stdio: ['ignore', 'pipe', 'pipe'] });
      json(res, { ok: true, output: result.slice(-2000) });
    } catch (e) {
      const out = (e.stdout || '') + '\n' + (e.stderr || '');
      json(res, { ok: false, output: out.slice(-2000), error: e.message });
    }
  });
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
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;

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

      // Delete single job
      const mDel = p.match(/^\/api\/jobs\/([^/]+)$/);
      if (mDel && req.method === 'DELETE') return apiDeleteJob(req, res, mDel[1]);

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
      if (p === '/api/cleanup' && req.method === 'POST') return apiCleanup(req, res);

      if (p === '/api/models') return apiModels(req, res);
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
}

// ------------------------------------------------------------------ main

function main() {
  const args = process.argv.slice(2);
  let port = 9191;
  let openBrowser = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1]) { port = parseInt(args[i + 1], 10); i++; }
    else if (args[i] === '--open') openBrowser = true;
  }

  const server = createServer();
  server.listen(port, '127.0.0.1', () => {
    const url = 'http://localhost:' + port;
    console.log('дашборд .ai: ' + url);
    console.log('  jobs:    ' + url + '/api/jobs');
    console.log('  stats:   ' + url + '/api/stats');
    console.log('  caps:    ' + url + '/api/capabilities');
    console.log('  Ctrl+C чтобы остановить');

    if (openBrowser) {
      const cmd = process.platform === 'win32' ? 'cmd' : (process.platform === 'darwin' ? 'open' : 'xdg-open');
      const args = process.platform === 'win32' ? ['/c', 'start', url] : [url];
      try { spawn(cmd, args, { detached: true, stdio: 'ignore' }); } catch {}
    }
  });
}

if (require.main === module || process.argv.length <= 1) {
  main();
}
module.exports = { createServer };
