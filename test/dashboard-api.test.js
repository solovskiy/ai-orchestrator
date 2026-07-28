'use strict';
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createServer } = require('../lib/dashboard.js');

const AGENTS_DIR = path.join(__dirname, '..', 'agents');

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

  // ---------------------------------------------------------------- stats

  await test('GET /api/stats — возвращает агрегированную статистику', async () => {
    const r = await get('/api/stats');
    assert.strictEqual(r.status, 200);
    assert.ok(r.json.all, 'должен быть all');
    assert.ok(typeof r.json.all.total === 'number', 'total должен быть числом');
    assert.ok(typeof r.json.all.completed === 'number', 'completed должен быть числом');
    assert.ok(typeof r.json.all.failed === 'number', 'failed должен быть числом');
    assert.ok(r.json.byModel, 'должен быть byModel');
    assert.ok(r.json.byCapability, 'должен быть byCapability');
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
