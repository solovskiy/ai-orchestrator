'use strict';
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { WebSocket } = require('ws');
const { createServer } = require('../lib/dashboard.js');

const AGENTS_DIR = path.join(__dirname, '..', 'agents');
const os = require('node:os');

let passed = 0;
let failed = 0;

async function test(desc, fn) {
  try {
    await fn();
    console.log(`  OK ${desc}`);
    passed++;
  } catch (e) {
    console.error(`  FAIL ${desc}: ${e.message}`);
    failed++;
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------- хелперы

let baseUrl;

function get(path) {
  return new Promise((resolve, reject) => {
    http.get(baseUrl + path, { timeout: 5000 }, (res) => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, headers: res.headers, body, json: JSON.parse(body) });
        } catch {
          resolve({ status: res.statusCode, headers: res.headers, body });
        }
      });
    }).on('error', reject);
  });
}

function req(method, path, data) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const opts = {
      hostname: u.hostname, port: u.port, path: u.pathname,
      method, timeout: 5000,
      headers: data ? { 'Content-Type': 'application/json' } : {},
    };
    const r = http.request(opts, (res) => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, headers: res.headers, body, json: JSON.parse(body) });
        } catch {
          resolve({ status: res.statusCode, headers: res.headers, body });
        }
      });
    });
    r.on('error', reject);
    if (data) r.write(JSON.stringify(data));
    r.end();
  });
}

// ---------------------------------------------------------- startup

function startServer() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve(srv);
    });
    srv.on('error', reject);
  });
}

// ---------------------------------------------------------- тесты

async function runTests() {
  const server = await startServer();

  try {

  // ---------------------------------------------------------------- models

  await test('GET /api/models — возвращает массив моделей', async () => {
    const r = await get('/api/models');
    assert.strictEqual(r.status, 200);
    assert.ok(r.json && r.json.models, 'должен быть ключ models');
    assert.ok(Array.isArray(r.json.models), 'models должен быть массивом');
    assert.ok(r.json.models.length > 0, 'должен быть хотя бы один model');
    const m = r.json.models[0];
    assert.ok(m.id, `модель должна иметь id: ${JSON.stringify(m)}`);
    assert.ok(r.json.source, 'должен быть указан source (defaults или opencode)');
  });

  // ---------------------------------------------------------------- agents

  await test('GET /api/agents — возвращает список агентов', async () => {
    const r = await get('/api/agents');
    assert.strictEqual(r.status, 200);
    assert.ok(Array.isArray(r.json), 'должен быть массивом');
    const names = r.json.map(a => a.name);
    assert.ok(names.includes('coding'), `должен быть coding среди: ${names.join(', ')}`);
    assert.ok(names.includes('research'), `должен быть research среди: ${names.join(', ')}`);
    const coding = r.json.find(a => a.name === 'coding');
    assert.ok(coding.model, 'у агента должна быть модель');
    assert.strictEqual(coding.worktree, true, 'coding должен быть worktree');
    assert.ok(coding.permissions, 'должны быть permissions');
    assert.ok(typeof coding.running === 'number', 'running должен быть числом');
  });

  await test('GET /api/agents/coding — возвращает одного агента', async () => {
    const r = await get('/api/agents/coding');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.name, 'coding');
    assert.ok(r.json.model, 'должна быть модель');
    assert.ok(r.json.systemPrompt, 'должен быть systemPrompt');
    assert.ok(r.json.permissions, 'должны быть permissions');
  });

  await test('GET /api/agents/nonexistent — 404', async () => {
    const r = await get('/api/agents/nonexistent');
    assert.strictEqual(r.status, 404);
    assert.ok(r.json.error, 'должна быть ошибка');
  });

  // ---------------------------------------------------------------- agent CRUD через API

  const testAgentName = 'test-api-temp';
  const testAgentFile = path.join(AGENTS_DIR, testAgentName + '.json');
  const testAgentMd = path.join(AGENTS_DIR, '..', '.opencode', 'agents', testAgentName + '.md');

  try {

  await test('POST /api/agents/:name — создаёт нового агента и деплоит .md', async () => {
    const r = await req('POST', `/api/agents/${testAgentName}`, {
      name: testAgentName,
      description: 'API-тестовый агент',
      mode: 'primary',
      model: 'deepseek/deepseek-v4-flash',
      variant: 'low',
      worktree: false,
      timeout: 600,
      autoCommit: false,
      systemPrompt: 'Тестовый промпт.',
      permissions: { bash: 'allow', read: 'allow' },
    });
    assert.strictEqual(r.status, 200, `должен быть 200: ${r.body}`);
    assert.strictEqual(r.json.ok, true);
    assert.strictEqual(r.json.name, testAgentName);
    assert.strictEqual(r.json.deployed, true, 'должен быть авто-деплой .md');

    // .md файл должен существовать
    assert.ok(fs.existsSync(testAgentMd), `должен существовать ${testAgentMd}`);
    const md = fs.readFileSync(testAgentMd, 'utf8');
    assert.ok(md.startsWith('---'), 'должен быть YAML frontmatter');
    assert.ok(md.includes('description: API-тестовый агент'), 'должен быть description');
    assert.ok(md.includes('model: deepseek/deepseek-v4-flash'), 'должна быть модель');
    assert.ok(md.endsWith('Тестовый промпт.\n'), 'должен быть systemPrompt в теле');
  });

  await test('GET /api/agents/:name — читает только что созданного', async () => {
    const r = await get(`/api/agents/${testAgentName}`);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.name, testAgentName);
    assert.strictEqual(r.json.description, 'API-тестовый агент');
    assert.strictEqual(r.json.model, 'deepseek/deepseek-v4-flash');
  });

  await test('POST /api/agents/:name — обновляет существующего', async () => {
    const r = await req('POST', `/api/agents/${testAgentName}`, {
      name: testAgentName,
      description: 'Обновлённое описание',
      model: 'deepseek/deepseek-v4-pro',
      variant: 'medium',
      worktree: true,
      timeout: 1200,
      systemPrompt: 'Обновлённый промпт.',
      permissions: { bash: 'allow', read: 'allow', edit: 'allow' },
    });
    assert.strictEqual(r.status, 200, `должен быть 200: ${r.body}`);
    assert.strictEqual(r.json.ok, true);

    const r2 = await get(`/api/agents/${testAgentName}`);
    assert.strictEqual(r2.json.description, 'Обновлённое описание');
    assert.strictEqual(r2.json.model, 'deepseek/deepseek-v4-pro');
    assert.strictEqual(r2.json.worktree, true);
    assert.strictEqual(r2.json.timeout, 1200);
  });

  await test('DELETE /api/agents/:name — удаляет агента', async () => {
    const r = await req('DELETE', `/api/agents/${testAgentName}`);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.ok, true);
    assert.strictEqual(r.json.name, testAgentName);

    const r2 = await get(`/api/agents/${testAgentName}`);
    assert.strictEqual(r2.status, 404);
  });

  await test('DELETE /api/agents/:name — 404 для несуществующего', async () => {
    const r = await req('DELETE', '/api/agents/nonexistent-xyz');
    assert.strictEqual(r.status, 404);
  });

  } finally {
    // cleanup напрямую через fs, в обход API — чтобы файлы не остались
    // в РЕАЛЬНОЙ agents/ проекта, даже если тест упал между create и delete
    // (createServer() использует настоящий AGENTS_DIR, не временную директорию)
    try { fs.unlinkSync(testAgentFile); } catch {}
    try { fs.unlinkSync(testAgentMd); } catch {}
  }

  // ---------------------------------------------------------------- agent save → global deploy

  const testGlobalAgentName = 'test-global-deploy';
  const testGlobalAgentFile = path.join(AGENTS_DIR, testGlobalAgentName + '.json');
  const testGlobalAgentMd = path.join(AGENTS_DIR, '..', '.opencode', 'agents', testGlobalAgentName + '.md');
  const origHome = process.env.HOME;
  let tmpHomeDir;

  try {
    // Создаём временный HOME и направляем глобальный деплой туда
    tmpHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-dashboard-global-home-'));
    process.env.HOME = tmpHomeDir;

    await test('POST /api/agents/:name — деплоит .md в глобальную ~/.config/opencode/agents/', async () => {
      const r = await req('POST', `/api/agents/${testGlobalAgentName}`, {
        name: testGlobalAgentName,
        description: 'Глобальный тестовый агент',
        model: 'deepseek/deepseek-v4-pro',
        variant: 'medium',
        worktree: false,
        systemPrompt: 'Глобальный промпт.',
        permissions: { bash: 'allow', read: 'allow' },
      });
      assert.strictEqual(r.status, 200, `должен быть 200: ${r.body}`);
      assert.strictEqual(r.json.ok, true);
      assert.strictEqual(r.json.deployed, true, 'должен быть авто-деплой .md');

      // Локальный .md должен существовать
      assert.ok(fs.existsSync(testGlobalAgentMd), `должен существовать локальный ${testGlobalAgentMd}`);

      // Глобальный .md должен существовать во временном HOME
      const globalMd = path.join(tmpHomeDir, '.config', 'opencode', 'agents', testGlobalAgentName + '.md');
      assert.ok(fs.existsSync(globalMd), `должен существовать глобальный ${globalMd}`);

      const mdContent = fs.readFileSync(globalMd, 'utf8');
      assert.ok(mdContent.startsWith('---'), 'должен быть YAML frontmatter');
      assert.ok(mdContent.includes('description: Глобальный тестовый агент'), 'должен быть description');
      assert.ok(mdContent.includes('model: deepseek/deepseek-v4-pro'), 'должна быть модель');
      assert.ok(mdContent.endsWith('Глобальный промпт.\n'), 'должен быть systemPrompt в теле');
    });

  } finally {
    // Восстанавливаем реальный HOME и чистим временные файлы
    process.env.HOME = origHome;
    try { fs.rmSync(tmpHomeDir, { recursive: true, force: true }); } catch {}
    try { fs.unlinkSync(testGlobalAgentFile); } catch {}
    try { fs.unlinkSync(testGlobalAgentMd); } catch {}
  }

  // ---------------------------------------------------------------- безопасное сохранение агента
  // Регрессия «промпт пропадает при сохранении»: создание поверх существующего,
  // не-объектное тело, обрезанный файл и устаревшая форма не должны ломать агента.

  const guardName = 'test-api-guard';
  const guardFile = path.join(AGENTS_DIR, guardName + '.json');
  const guardMd = path.join(AGENTS_DIR, '..', '.opencode', 'agents', guardName + '.md');
  const brokenFile = path.join(AGENTS_DIR, 'test-api-broken.json');
  const guardAgent = {
    name: guardName, description: 'guard', mode: 'primary', model: 'deepseek/deepseek-v4-flash',
    systemPrompt: 'ВАЖНЫЙ ПРОМПТ, который нельзя потерять', permissions: { bash: 'allow' }, mcp: ['context7'],
  };
  let guardHome;
  const guardOrigHome = process.env.HOME;

  // сырой запрос: req() выше не умеет слать не-объектное тело (null, [], "x")
  function rawBodyReq(method, urlPath, rawBody) {
    return new Promise((resolve, reject) => {
      const u = new URL(baseUrl + urlPath);
      const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method, timeout: 5000,
        headers: { 'Content-Type': 'application/json' } }, (res) => {
        let body = '';
        res.on('data', c => { body += c; });
        res.on('end', () => { let j; try { j = JSON.parse(body); } catch {} resolve({ status: res.statusCode, body, json: j }); });
      });
      r.on('error', reject);
      r.write(rawBody);
      r.end();
    });
  }

  try {
    guardHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-dashboard-guard-home-')); // глобальный деплой — во временный HOME
    process.env.HOME = guardHome;

    await test('POST с _create поверх существующего агента — 409 exists, файл не тронут', async () => {
      assert.strictEqual((await req('POST', `/api/agents/${guardName}`, guardAgent)).status, 200);
      const before = fs.readFileSync(guardFile, 'utf8');
      const r = await req('POST', `/api/agents/${guardName}`, { name: guardName, systemPrompt: '', _create: true });
      assert.strictEqual(r.status, 409, r.body);
      assert.strictEqual(r.json.code, 'exists');
      assert.strictEqual(fs.readFileSync(guardFile, 'utf8'), before, 'файл агента изменился');
      assert.ok(JSON.parse(before).systemPrompt.startsWith('ВАЖНЫЙ ПРОМПТ'));
    });

    await test('POST с _create для нового имени — создаёт, служебные поля в файл не попадают', async () => {
      fs.unlinkSync(guardFile);
      const r = await req('POST', `/api/agents/${guardName}`, { ...guardAgent, _create: true, _loadedAt: 1 });
      assert.strictEqual(r.status, 200, r.body);
      const saved = JSON.parse(fs.readFileSync(guardFile, 'utf8'));
      for (const k of ['_create', '_loadedAt', '_mtime']) assert.ok(!(k in saved), `в файле остался ${k}`);
      assert.strictEqual(saved.systemPrompt, guardAgent.systemPrompt);
    });

    await test('POST с устаревшим _loadedAt — 409 stale, файл не тронут; со свежим — сохраняет', async () => {
      const before = fs.readFileSync(guardFile, 'utf8');
      const detail = (await get(`/api/agents/${guardName}`)).json;
      const stale = await req('POST', `/api/agents/${guardName}`, { ...guardAgent, systemPrompt: '', _loadedAt: detail._mtime - 5000 });
      assert.strictEqual(stale.status, 409, stale.body);
      assert.strictEqual(stale.json.code, 'stale');
      assert.strictEqual(fs.readFileSync(guardFile, 'utf8'), before);

      const fresh = await req('POST', `/api/agents/${guardName}`, { ...guardAgent, description: 'новое', _loadedAt: detail._mtime });
      assert.strictEqual(fresh.status, 200, fresh.body);
      assert.strictEqual(JSON.parse(fs.readFileSync(guardFile, 'utf8')).description, 'новое');
    });

    await test('POST с телом null / [] / "x" — 400, сервер жив, файл не тронут', async () => {
      const before = fs.readFileSync(guardFile, 'utf8');
      for (const raw of ['null', '[]', '"x"', '12']) {
        const r = await rawBodyReq('POST', `/api/agents/${guardName}`, raw);
        assert.strictEqual(r.status, 400, `${raw}: ${r.body}`);
      }
      assert.strictEqual(fs.readFileSync(guardFile, 'utf8'), before);
      assert.strictEqual((await get('/api/agents')).status, 200, 'сервер должен остаться живым');
    });

    await test('сохранение атомарное: после записи в agents/ нет .tmp, файл — валидный JSON', async () => {
      assert.strictEqual((await req('POST', `/api/agents/${guardName}`, guardAgent)).status, 200);
      const leftovers = fs.readdirSync(AGENTS_DIR).filter(f => f.startsWith(guardName) && f.endsWith('.tmp'));
      assert.deepStrictEqual(leftovers, []);
      const text = fs.readFileSync(guardFile, 'utf8');
      assert.ok(text.endsWith('}\n'));
      assert.strictEqual(JSON.parse(text).systemPrompt, guardAgent.systemPrompt);
      const mdLeft = fs.readdirSync(path.dirname(guardMd)).filter(f => f.startsWith(guardName) && f.endsWith('.tmp'));
      assert.deepStrictEqual(mdLeft, []);
    });

    await test('GET /api/agents — битый JSON одного агента не прячет остальных', async () => {
      fs.writeFileSync(brokenFile, '{"name":"test-api-broken","systemPrompt":"обрез');
      const r = await get('/api/agents');
      assert.strictEqual(r.status, 200);
      const names = r.json.map(a => a.name);
      assert.ok(names.includes('coding') && names.includes(guardName), `список: ${names.join(', ')}`);
      assert.ok(!names.includes('test-api-broken'));
    });

  } finally {
    process.env.HOME = guardOrigHome;
    try { fs.rmSync(guardHome, { recursive: true, force: true }); } catch {}
    for (const f of [guardFile, guardMd, brokenFile]) { try { fs.unlinkSync(f); } catch {} }
  }

  // ---------------------------------------------------------------- agent export

  await test('GET /api/agents/coding/export — возвращает markdown', async () => {
    const r = await get('/api/agents/coding/export');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers['content-type'], 'text/markdown; charset=utf-8');
    assert.ok(r.body.startsWith('---'), `должен начинаться с YAML frontmatter: ${r.body.slice(0, 50)}`);
    assert.ok(r.body.includes('model:'), 'должен содержать model:');
    assert.ok(r.body.includes('---\n'), 'должен содержать закрывающий ---');
  });

  // ---------------------------------------------------------------- jobs (данные из реальной jobs/)

  await test('GET /api/jobs — возвращает объект с jobs и total', async () => {
    const r = await get('/api/jobs');
    assert.strictEqual(r.status, 200);
    assert.ok(r.json, 'должен быть ответ');
    assert.ok(Array.isArray(r.json.jobs), 'jobs должен быть массивом');
    assert.strictEqual(typeof r.json.total, 'number', 'total должен быть числом');
    assert.ok(r.json.total >= r.json.jobs.length, 'total >= jobs.length');
    if (r.json.jobs.length > 0) {
      const j = r.json.jobs[0];
      assert.ok(j.id, 'задача должна иметь id');
      assert.ok(j.status, 'задача должна иметь status');
      assert.ok(j.createdAt, 'задача должна иметь createdAt');
    }
  });

  await test('GET /api/jobs — содержит verifyCmd в объектах задач', async () => {
    const r = await get('/api/jobs');
    assert.strictEqual(r.status, 200);
    assert.ok(Array.isArray(r.json.jobs), 'jobs должен быть массивом');
    if (r.json.jobs.length > 0) {
      const j = r.json.jobs[0];
      assert.ok('verifyCmd' in j, 'задача должна содержать поле verifyCmd');
    }
  });

  await test('GET /api/jobs?limit=5 — возвращает не больше limit задач', async () => {
    const r = await get('/api/jobs?limit=5');
    assert.strictEqual(r.status, 200);
    assert.ok(r.json.jobs.length <= 5, 'не больше 5 задач');
    assert.ok(typeof r.json.total === 'number', 'total есть');
  });

  await test('GET /api/jobs?limit=5&offset=0 — offset работает', async () => {
    const r1 = await get('/api/jobs?limit=5&offset=0');
    const r2 = await get('/api/jobs?limit=5&offset=5');
    assert.strictEqual(r1.status, 200);
    assert.strictEqual(r2.status, 200);
    // If there are at least 10 jobs, the pages should have different jobs
    if (r1.json.total >= 10) {
      const ids1 = r1.json.jobs.map(j => j.id);
      const ids2 = r2.json.jobs.map(j => j.id);
      const overlap = ids1.filter(id => ids2.includes(id));
      assert.strictEqual(overlap.length, 0, 'страницы не должны пересекаться');
    }
  });

  await test('GET /api/jobs — лимит по умолчанию 50', async () => {
    const r = await get('/api/jobs');
    assert.strictEqual(r.status, 200);
    assert.ok(r.json.jobs.length <= 50, 'по умолчанию не больше 50');
    assert.ok(r.json.total >= r.json.jobs.length, 'total >= jobs.length');
  });

  await test('GET /api/jobs?limit=0 — некорректный limit сбрасывается на 50', async () => {
    const r = await get('/api/jobs?limit=0');
    assert.strictEqual(r.status, 200);
    assert.ok(r.json.jobs.length <= 50, 'limit=0 даёт не больше 50');
  });

  await test('GET /api/jobs?offset=9999 — offset больше total даёт пустой массив', async () => {
    const r = await get('/api/jobs?offset=9999');
    assert.strictEqual(r.status, 200);
    assert.ok(Array.isArray(r.json.jobs), 'jobs должен быть массивом');
    assert.strictEqual(r.json.jobs.length, 0, 'пустой массив при offset > total');
    assert.ok(typeof r.json.total === 'number', 'total всё ещё число');
  });

  await test('GET /api/jobs/:id — 404 для несуществующей', async () => {
    const r = await get('/api/jobs/nonexistent-job-id-12345');
    assert.strictEqual(r.status, 404);
  });

  // ---------------------------------------------------------------- kill / delete

  await test('POST /api/jobs/:id/kill — 404 для несуществующей', async () => {
    const r = await req('POST', '/api/jobs/nonexistent-kill-test/kill');
    assert.strictEqual(r.status, 404);
    assert.ok(r.json.error, 'должна быть ошибка');
  });

  await test('DELETE /api/jobs/:id — 404 для несуществующей', async () => {
    const r = await req('DELETE', '/api/jobs/nonexistent-delete-test');
    assert.strictEqual(r.status, 404);
    assert.ok(r.json.error, 'должна быть ошибка');
  });

  // Создаём временную задачу, тестируем kill и delete
  const tmpJobId = 'test-kill-delete-temp';
  const tmpJobDir = path.join(__dirname, '..', 'jobs', tmpJobId);

  try {
    await test('POST /api/jobs/:id/kill — убивает задачу в статусе running', async () => {
      // создаём временную задачу
      fs.mkdirSync(tmpJobDir, { recursive: true });
      const job = {
        id: tmpJobId, task: 'test-kill-delete', status: 'running',
        model: 'test/model', runner: 'test', pid: '99999',
        createdAt: new Date().toISOString(),
      };
      fs.writeFileSync(path.join(tmpJobDir, 'job.json'), JSON.stringify(job, null, 2) + '\n');

      const r = await req('POST', '/api/jobs/' + tmpJobId + '/kill');
      assert.strictEqual(r.status, 200, `должен быть 200: ${r.body}`);
      assert.strictEqual(r.json.ok, true);
      assert.strictEqual(r.json.status, 'killed');

      // проверяем, что статус обновлён в файле
      const updated = JSON.parse(fs.readFileSync(path.join(tmpJobDir, 'job.json'), 'utf8'));
      assert.strictEqual(updated.status, 'killed');
      assert.ok(updated.finishedAt, 'должен быть finishedAt');
    });

    await test('POST /api/jobs/:id/kill — 400 для задачи не в running', async () => {
      const r = await req('POST', '/api/jobs/' + tmpJobId + '/kill');
      assert.strictEqual(r.status, 400, `должен быть 400: ${r.body}`);
      assert.ok(r.json.error, 'должна быть ошибка');
    });

    await test('DELETE /api/jobs/:id — удаляет задачу', async () => {
      const r = await req('DELETE', '/api/jobs/' + tmpJobId);
      assert.strictEqual(r.status, 200, `должен быть 200: ${r.body}`);
      assert.strictEqual(r.json.ok, true);
      assert.ok(!fs.existsSync(tmpJobDir), 'директория задачи должна быть удалена');
    });

  } finally {
    // cleanup на случай ошибки
    try { fs.rmSync(tmpJobDir, { recursive: true, force: true }); } catch {}
  }

  // ---------------------------------------------------------------- сессии, пауза по лимиту шагов, действия над задачей

  await test('classifyStopReason — лимит шагов отличается от настоящего сбоя', () => {
    const { classifyStopReason } = require('../lib/agent.js');
    assert.strictEqual(classifyStopReason({ status: 'failed', error: 'error_max_turns' }), 'max_steps');
    assert.strictEqual(classifyStopReason({ status: 'failed', error: 'Reached maximum number of turns (20)' }), 'max_steps');
    assert.strictEqual(classifyStopReason({ status: 'failed', error: 'API 500: upstream timeout' }), null);
    assert.strictEqual(classifyStopReason({ status: 'failed', error: null }), null);
    // не failed — причина остановки не нужна, даже если в error осталось слово из шаблона
    assert.strictEqual(classifyStopReason({ status: 'completed', error: 'error_max_turns' }), null);
    assert.strictEqual(classifyStopReason(null), null);
  });

  // fixtures пишем в реальную jobs/ (как и тесты выше) и убираем за собой
  const chainStamp = Date.now();
  const chainIds = {
    root: 'chain-test-root-' + chainStamp,
    child: 'chain-test-child-' + chainStamp,
    broken: 'chain-test-broken-' + chainStamp,
    running: 'chain-test-running-' + chainStamp,
    nosess: 'chain-test-nosess-' + chainStamp,
    wt: 'chain-test-wt-' + chainStamp,
  };
  const chainDirs = Object.values(chainIds).map(id => path.join(__dirname, '..', 'jobs', id));

  function mkChainJob(id, fields, prompt) {
    const dir = path.join(__dirname, '..', 'jobs', id);
    fs.mkdirSync(dir, { recursive: true });
    const job = { id, task: 'chain-test', model: 'claude-ds/deepseek-v4-pro', runner: 'claude-ds',
      createdAt: new Date().toISOString(), ...fields };
    fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify(job, null, 2) + '\n');
    if (prompt != null) fs.writeFileSync(path.join(dir, 'prompt.md'), prompt);
  }

  // запрос с произвольными заголовками (Host/Origin) — req() выше их не умеет
  function rawReq(method, p, headers) {
    return new Promise((resolve, reject) => {
      const u = new URL(baseUrl);
      const r = http.request({ hostname: u.hostname, port: u.port, path: p, method, headers, timeout: 5000 }, (res) => {
        let body = '';
        res.on('data', c => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      });
      r.on('error', reject);
      r.end();
    });
  }

  try {
    mkChainJob(chainIds.root, { status: 'failed', sessionId: 'sess-chain-' + chainStamp, error: 'error_max_turns' }, 'Реализуй авторизацию');
    mkChainJob(chainIds.child, { status: 'completed', sessionId: 'sess-chain-' + chainStamp, continuesJob: chainIds.root }, 'допиши тесты\nи документацию');
    mkChainJob(chainIds.broken, { status: 'failed', error: 'API 500: upstream timeout' }, 'x');
    mkChainJob(chainIds.running, { status: 'running', sessionId: 'sess-run-' + chainStamp }, 'x');
    mkChainJob(chainIds.nosess, { status: 'completed' }, 'x');
    mkChainJob(chainIds.wt, { status: 'completed', worktree: 0, sessionId: 'sess-wt-' + chainStamp }, 'x');

    await test('GET /api/jobs — сводка связывает задачи одной сессии и помечает паузу по лимиту шагов', async () => {
      const r = await get('/api/jobs?limit=200');
      assert.strictEqual(r.status, 200);
      const byId = Object.fromEntries(r.json.jobs.map(j => [j.id, j]));
      const root = byId[chainIds.root], child = byId[chainIds.child], broken = byId[chainIds.broken];
      assert.ok(root && child && broken, 'fixture-задачи должны быть в выдаче');
      assert.strictEqual(root.stopReason, 'max_steps', 'лимит шагов → max_steps');
      assert.strictEqual(root.status, 'failed', 'сырой статус не подменяется — это решает UI');
      assert.strictEqual(child.stopReason, null);
      assert.strictEqual(child.sessionId, root.sessionId, 'общая сессия');
      assert.strictEqual(child.continuesJob, chainIds.root);
      assert.strictEqual(child.promptPreview, 'допиши тесты', 'в превью — первая строка ТЗ продолжения');
      assert.strictEqual(root.promptPreview, null, 'у корня превью не нужно');
      assert.strictEqual(broken.stopReason, null, 'настоящий сбой остаётся сбоем');
    });

    await test('GET /api/jobs/:id — деталь содержит stopReason', async () => {
      const r = await get('/api/jobs/' + chainIds.root);
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.json.stopReason, 'max_steps');
    });

    await test('POST /api/jobs/:id/send — валидация: 404, пустое сообщение, running, нет сессии, небезопасный id', async () => {
      assert.strictEqual((await req('POST', '/api/jobs/nonexistent-send-test/send', { message: 'x' })).status, 404);
      assert.strictEqual((await req('POST', '/api/jobs/' + chainIds.child + '/send', { message: '   ' })).status, 400, 'пустое сообщение');
      assert.strictEqual((await req('POST', '/api/jobs/' + chainIds.running + '/send', { message: 'x' })).status, 409, 'running');
      assert.strictEqual((await req('POST', '/api/jobs/' + chainIds.nosess + '/send', { message: 'x' })).status, 400, 'нет sessionId');
      // id, начинающийся с «-», не должен дойти до CLI как флаг
      assert.strictEqual((await req('POST', '/api/jobs/--help/send', { message: 'x' })).status, 400, 'небезопасный id');
    });

    await test('POST /api/jobs/:id/accept|discard — валидация: 404, не worktree, running', async () => {
      for (const action of ['accept', 'discard']) {
        assert.strictEqual((await req('POST', '/api/jobs/nonexistent-' + action + '-test/' + action)).status, 404, action + ' 404');
        assert.strictEqual((await req('POST', '/api/jobs/' + chainIds.wt + '/' + action)).status, 400, action + ': не worktree');
      }
      // running + worktree → 409 (пишем job заново с worktree=1)
      mkChainJob(chainIds.running, { status: 'running', worktree: 1, sessionId: 'sess-run-' + chainStamp }, 'x');
      assert.strictEqual((await req('POST', '/api/jobs/' + chainIds.running + '/accept')).status, 409, 'running');
    });

    await test('защита: чужой Origin/Host отклоняются, свой Origin и запросы без Origin проходят', async () => {
      const u = new URL(baseUrl);
      const own = u.host;
      assert.strictEqual((await rawReq('POST', '/api/cleanup', { Host: own, Origin: 'http://evil.example' })).status, 403, 'чужой Origin на POST');
      assert.strictEqual((await rawReq('DELETE', '/api/jobs/x', { Host: own, Origin: 'http://evil.example' })).status, 403, 'чужой Origin на DELETE');
      assert.strictEqual((await rawReq('GET', '/api/jobs?limit=1', { Host: 'evil.example' })).status, 403, 'чужой Host (DNS-rebinding)');
      assert.strictEqual((await rawReq('GET', '/api/jobs?limit=1', { Host: own })).status, 200, 'без Origin');
      assert.strictEqual((await rawReq('POST', '/api/jobs/nonexistent-origin-test/kill', { Host: own, Origin: baseUrl })).status, 404, 'свой Origin проходит дальше');
    });

    await test('WebSocket — чужой Origin не принимается', async () => {
      const wsUrl = 'ws://' + new URL(baseUrl).host;
      await new Promise((resolve, reject) => {
        const c = new WebSocket(wsUrl, { headers: { Origin: 'http://evil.example' } });
        const timer = setTimeout(() => reject(new Error('таймаут')), 3000);
        c.on('open', () => { clearTimeout(timer); c.close(); reject(new Error('сокет открылся для чужого Origin')); });
        c.on('unexpected-response', (_q, res) => { clearTimeout(timer); assert.strictEqual(res.statusCode, 401); resolve(); });
        c.on('error', () => { clearTimeout(timer); resolve(); }); // отказ рукопожатия
      });
    });
  } finally {
    for (const d of chainDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  }

  // ---------------------------------------------------------------- session-log

  const sessJobId = 'test-session-log';
  const sessJobDir = path.join(__dirname, '..', 'jobs', sessJobId);

  try {

  await test('GET /api/jobs/:id/session-log — валидный out.jsonl возвращает шаги', async () => {
    // Создаём временную задачу с out.jsonl
    fs.mkdirSync(sessJobDir, { recursive: true });
    const job = {
      id: sessJobId, task: 'test-session-log', status: 'completed',
      model: 'test/model', runner: 'test', pid: '88888',
      createdAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(sessJobDir, 'job.json'), JSON.stringify(job, null, 2) + '\n');

    // Пишем валидный out.jsonl с несколькими tool_use, step_finish строками
    const now = Date.now();
    const outLines = [
      JSON.stringify({ type: 'tool_use', timestamp: now, sessionID: 's1', part: { type: 'tool', tool: 'read', title: 'read file.txt', state: { status: 'completed', input: { filePath: '/tmp/file.txt' }, output: 'hello world', time: { start: now, end: now + 100 }, title: 'read file.txt' } } }),
      JSON.stringify({ type: 'tool_use', timestamp: now + 200, sessionID: 's1', part: { type: 'tool', tool: 'bash', title: 'npm test', state: { status: 'completed', input: { command: 'npm test', workdir: '.' }, output: 'All tests passed!', time: { start: now + 200, end: now + 5000 }, title: 'npm test' } } }),
      JSON.stringify({ type: 'step_finish', timestamp: now + 6000, sessionID: 's1', part: { id: 'f1', reason: 'tool-calls', type: 'step-finish', tokens: { total: 5000, input: 3000, output: 2000, reasoning: 0 }, cost: 0.004160833 } }),
      JSON.stringify({ type: 'tool_use', timestamp: now + 7000, sessionID: 's1', part: { type: 'tool', tool: 'write', title: 'write foo.js', state: { status: 'completed', input: { filePath: '/tmp/foo.js' }, output: '', time: { start: now + 7000, end: now + 7100 }, title: 'write foo.js' } } }),
      JSON.stringify({ type: 'step_start', timestamp: now + 8000, sessionID: 's1', part: { id: 's2', type: 'step-start' } }),
    ];
    fs.writeFileSync(path.join(sessJobDir, 'out.jsonl'), outLines.join('\n') + '\n');

    const r = await get('/api/jobs/' + sessJobId + '/session-log');
    assert.strictEqual(r.status, 200, `должен быть 200: ${r.body}`);
    assert.ok(r.json.steps, 'должен быть массив steps');
    assert.ok(Array.isArray(r.json.steps), 'steps должен быть массивом');
    assert.ok(r.json.steps.length >= 4, `должно быть минимум 4 шага (step_start может быть опционален): ${r.json.steps.length}`);
    assert.strictEqual(typeof r.json.totalSteps, 'number', 'totalSteps должен быть числом');
    assert.strictEqual(typeof r.json.truncated, 'boolean', 'truncated должен быть boolean');

    // Проверяем первый tool_use
    const toolUses = r.json.steps.filter(s => s.type === 'tool_use');
    assert.ok(toolUses.length >= 3, `должно быть минимум 3 tool_use: ${toolUses.length}`);
    const read = toolUses.find(s => s.tool === 'read');
    assert.ok(read, 'должен быть tool_use read');
    assert.strictEqual(read.tool, 'read');
    assert.strictEqual(read.title, 'read file.txt');
    assert.strictEqual(read.status, 'completed');
    assert.ok(read.input.filePath, 'должен быть input.filePath');
    assert.strictEqual(read.output, 'hello world');
    assert.ok(typeof read.durationMs === 'number', 'durationMs должен быть числом');

    // Проверяем step_finish
    const finishes = r.json.steps.filter(s => s.type === 'step_finish');
    assert.strictEqual(finishes.length, 1, 'должен быть один step_finish');
    assert.ok(finishes[0].tokens, 'должны быть tokens');
    assert.strictEqual(finishes[0].tokens.total, 5000);
    assert.strictEqual(finishes[0].cost, 0.004160833);

    // Проверяем step_start
    const starts = r.json.steps.filter(s => s.type === 'step_start');
    assert.ok(starts.length >= 1, 'должен быть хотя бы один step_start');
  });

  await test('GET /api/jobs/:id/session-log — отсутствующий out.jsonl возвращает 200 с пустым массивом', async () => {
    // Удаляем out.jsonl, job.json остаётся
    try { fs.unlinkSync(path.join(sessJobDir, 'out.jsonl')); } catch {}
    assert.ok(!fs.existsSync(path.join(sessJobDir, 'out.jsonl')), 'out.jsonl должен отсутствовать');

    const r = await get('/api/jobs/' + sessJobId + '/session-log');
    assert.strictEqual(r.status, 200, `должен быть 200, а не 404: ${r.body}`);
    assert.ok(r.json.steps, 'должен быть массив steps');
    assert.ok(Array.isArray(r.json.steps), 'steps должен быть массивом');
    assert.strictEqual(r.json.steps.length, 0, 'массив должен быть пустым');
    assert.strictEqual(r.json.totalSteps, 0, 'totalSteps должен быть 0');
  });

  await test('GET /api/jobs/:id/session-log — несуществующая задача → 404', async () => {
    const r = await get('/api/jobs/nonexistent-session-log/session-log');
    assert.strictEqual(r.status, 404);
    assert.ok(r.json.error, 'должна быть ошибка');
  });

  await test('GET /api/jobs/:id/session-log — битые JSON-строки пропускаются', async () => {
    // Восстанавливаем out.jsonl с битыми строками
    const now = Date.now();
    const outLines = [
      '',  // пустая строка
      JSON.stringify({ type: 'tool_use', timestamp: now, sessionID: 's1', part: { type: 'tool', tool: 'grep', title: 'grep test', state: { status: 'completed', input: { pattern: 'foo' }, output: 'found 2 matches', time: { start: now, end: now + 50 }, title: 'grep test' } } }),
      '{ type: truncated',  // битый JSON (будто файл писался)
      '  "json": "also broken"',
      JSON.stringify({ type: 'step_finish', timestamp: now + 200, sessionID: 's1', part: { id: 'f2', reason: 'stop', type: 'step-finish', tokens: { total: 100, input: 60, output: 40 }, cost: 0.00005 } }),
    ];
    fs.writeFileSync(path.join(sessJobDir, 'out.jsonl'), outLines.join('\n') + '\n');

    const r = await get('/api/jobs/' + sessJobId + '/session-log');
    assert.strictEqual(r.status, 200, `должен быть 200: ${r.body}`);
    const steps = r.json.steps;
    assert.ok(Array.isArray(steps), 'steps должен быть массивом');
    // Должны быть только 2 валидные строки (grep tool_use и step_finish)
    assert.strictEqual(steps.length, 2, `должно быть 2 валидных шага (битые строки пропущены): ${steps.length}`);
    assert.strictEqual(steps[0].tool, 'grep');
    assert.strictEqual(steps[1].type, 'step_finish');
    assert.strictEqual(r.json.totalSteps, 2, 'totalSteps должен быть 2');
  });

  } finally {
    try { fs.rmSync(sessJobDir, { recursive: true, force: true }); } catch {}
  }

  // ---------------------------------------------------------------- stats

  await test('GET /api/stats — возвращает агрегированную статистику', async () => {
    const r = await get('/api/stats');
    assert.strictEqual(r.status, 200);
    assert.ok(r.json.all, 'должен быть all');
    assert.ok(typeof r.json.all.total === 'number', 'total должен быть числом');
    assert.ok(typeof r.json.all.completed === 'number', 'completed должен быть числом');
    assert.ok(typeof r.json.all.failed === 'number', 'failed должен быть числом');
    assert.ok(r.json.byModel, 'должен быть byModel');
    assert.ok(r.json.byAgent, 'должен быть byAgent');
  });

  // ---------------------------------------------------------------- capabilities

  await test('GET /api/capabilities — возвращает capabilities', async () => {
    const r = await get('/api/capabilities');
    assert.strictEqual(r.status, 200);
    assert.ok(typeof r.json === 'object', 'должен быть объектом');
  });

  // ---------------------------------------------------------------- HTML

  await test('GET / — возвращает dashboard HTML', async () => {
    const r = await get('/');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers['content-type'], 'text/html; charset=utf-8');
    assert.ok(r.body.includes('<!DOCTYPE') || r.body.includes('<html'),
      `должен быть HTML: ${r.body.slice(0, 100)}`);
  });

  // ---------------------------------------------------------------- 404

  await test('GET /api/unknown-route — 404', async () => {
    const r = await get('/api/unknown-route');
    assert.strictEqual(r.status, 404);
    assert.ok(r.json.error, 'должна быть ошибка');
  });

  // ---------------------------------------------------------------- agent test-run (dry)

  await test('POST /api/agents/:name/test-run — 404 для несуществующего', async () => {
    const r = await req('POST', '/api/agents/nonexistent-xyz/test-run', { prompt: 'echo ok' });
    assert.strictEqual(r.status, 404);
  });

  // ---------------------------------------------------------------- WebSocket

  await test('WebSocket — соединение устанавливается без ошибок', async () => {
    const wsPort = new URL(baseUrl).port;
    const wsUrl = 'ws://127.0.0.1:' + wsPort;

    const wsClient = new WebSocket(wsUrl);
    let connected = false;
    let closed = false;

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('таймаут подключения WebSocket')), 5000);

      wsClient.on('open', () => {
        connected = true;
        clearTimeout(timeout);
        // Wait a moment for any initial message, then close
        setTimeout(() => {
          wsClient.close();
        }, 500);
      });

      wsClient.on('close', () => {
        closed = true;
        resolve();
      });

      wsClient.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    assert.ok(connected, 'WebSocket должен был подключиться');
    assert.ok(closed, 'WebSocket должен был закрыться');
  });

  await test('WebSocket — при создании задачи приходит уведомление', async () => {
    const wsPort = new URL(baseUrl).port;
    const wsUrl = 'ws://127.0.0.1:' + wsPort;

    const wsJobId = 'ws-test-job-' + Date.now();
    const wsJobDir = path.join(__dirname, '..', 'jobs', wsJobId);

    // Connect WebSocket first
    const wsClient = new WebSocket(wsUrl);
    let receivedMessages = [];

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('таймаут ожидания init-сообщения')), 5000);

      wsClient.on('open', () => {
        // Wait for initial bootstrap message
      });

      wsClient.on('message', (data) => {
        try {
          const msgs = JSON.parse(data.toString());
          receivedMessages.push(...(Array.isArray(msgs) ? msgs : [msgs]));
        } catch {}
      });

      // After receiving initial data, create a job
      setTimeout(() => {
        try {
          fs.mkdirSync(wsJobDir, { recursive: true });
          const job = {
            id: wsJobId,
            task: 'ws-test-task',
            status: 'running',
            model: 'test/ws-model',
            runner: 'test',
            createdAt: new Date().toISOString(),
          };
          fs.writeFileSync(path.join(wsJobDir, 'job.json'), JSON.stringify(job, null, 2) + '\n');
        } catch (e) {
          reject(e);
          return;
        }

        // Wait for the WebSocket server to detect the change (~1.5s polling + buffer)
        setTimeout(() => {
          clearTimeout(timeout);
          wsClient.close();
        }, 2500);
      }, 500);

      wsClient.on('close', () => {
        clearTimeout(timeout);
        resolve();
      });

      wsClient.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    // Clean up the test job directory
    try { fs.rmSync(wsJobDir, { recursive: true, force: true }); } catch {}

    // Filter for our specific job
    const jobMessages = receivedMessages.filter(
      m => m.type === 'job_updated' && m.job && m.job.id === wsJobId
    );

    assert.ok(jobMessages.length >= 1,
      `должно быть хотя бы одно сообщение о задаче ${wsJobId}, получено сообщений: ${JSON.stringify(receivedMessages.slice(0, 5))}`);
    const jobMsg = jobMessages[jobMessages.length - 1]; // last message (after the job was created)
    assert.strictEqual(jobMsg.job.task, 'ws-test-task');
    assert.strictEqual(jobMsg.job.status, 'running');
    assert.strictEqual(jobMsg.job.model, 'ws-model');
  });

  await test('WebSocket — отключение клиента не ломает сервер', async () => {
    const wsPort = new URL(baseUrl).port;
    const wsUrl = 'ws://127.0.0.1:' + wsPort;

    // Connect and disconnect multiple clients
    for (let i = 0; i < 3; i++) {
      await new Promise((resolve, reject) => {
        const wsClient = new WebSocket(wsUrl);
        const timeout = setTimeout(() => reject(new Error('таймаут')), 3000);

        wsClient.on('open', () => {
          // Immediately close — aggressive disconnect
          wsClient.close();
        });

        wsClient.on('close', () => {
          clearTimeout(timeout);
          resolve();
        });

        wsClient.on('error', (err) => {
          clearTimeout(timeout);
          reject(err);
        });
      });
    }

    // Verify the server still responds to HTTP
    const r = await get('/api/jobs');
    assert.strictEqual(r.status, 200);
    assert.ok(Array.isArray(r.json.jobs), 'HTTP API должен работать после WebSocket disconnect');
  });

  } finally {
    server.close();
  }

  console.log(`\nпройдено: ${passed}, провалено: ${failed}`);
  if (!process.exitCode) {
    console.log('dashboard-api: OK');
  }
}

runTests().catch(e => {
  console.error('TEST SUITE ERROR: ' + e.message);
  process.exitCode = 1;
});
