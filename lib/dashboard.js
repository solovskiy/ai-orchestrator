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
const CAP_DIR = path.join(AI_HOME, 'capabilities');
const HTML_FILE = path.join(__dirname, 'dashboard.html');

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
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(data));
}

function error(res, code, msg) {
  json(res, { error: msg }, code);
}

// ------------------------------------------------------------------ API

function apiJobs(req, res) {
  const jobs = [];
  for (const dir of listJobDirs()) {
    const j = readJob(dir);
    if (!j) continue;
    jobs.push({
      id: j.id,
      task: j.task,
      status: j.status,
      model: j.model ? j.model.split('/').pop() : (j.runner || '?'),
      runner: j.runner,
      worktree: !!j.worktree,
      variant: j.variant || null,
      verifyStatus: j.verifyStatus || null,
      changedFiles: j.changedFiles,
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
  json(res, jobs);
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

  json(res, {
    ...j,
    resultMd: result,
    stderrTail: stderr,
    verifyLogTail: verifyLog,
    diagnosis: diagnosis || j.diagnosis || null,
    promptMd: prompt,
  });
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

  const byWt = new Map();
  for (const j of jobs) {
    const key = j.worktree ? 'coding' : 'research';
    if (!byWt.has(key)) byWt.set(key, []);
    byWt.get(key).push(j);
  }

  json(res, {
    all: agg(jobs),
    byModel: Object.fromEntries([...byModel.entries()].map(([k, v]) => [k, agg(v)])),
    byCapability: Object.fromEntries([...byWt.entries()].map(([k, v]) => [k, agg(v)])),
    byDay: Object.fromEntries([...byDay.entries()].sort().map(([k, v]) => [k, agg(v)])),
  });
}

function apiCapabilities(req, res) {
  const caps = {};
  try {
    for (const name of fs.readdirSync(CAP_DIR)) {
      const file = path.join(CAP_DIR, name, 'capability.json');
      const c = readJson(file);
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

    const file = path.join(CAP_DIR, name, 'capability.json');
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
    json(res, JSON.parse(fs.readFileSync(file, 'utf8')));
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
    agent.name = name;

    const file = path.join(AGENTS_DIR, name + '.json');
    try {
      fs.mkdirSync(AGENTS_DIR, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(agent, null, 2) + '\n');
      json(res, { ok: true, name });
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

    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
      return res.end();
    }

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

main();
