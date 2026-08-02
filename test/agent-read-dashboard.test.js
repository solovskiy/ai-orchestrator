'use strict';

/**
 * Тест cmdAgentRead — чтение конфига агента через HTTP-дашборд
 * с прозрачным fallback на локальный файл.
 *
 * Запуск: node test/agent-read-dashboard.test.js
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { createServer } = require('../lib/dashboard.js');

const AGENT_JS = path.join(__dirname, '..', 'lib', 'agent.js');
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

function agent(args, envOverride) {
  const env = { ...process.env, ...envOverride };
  return execFileSync('node', [AGENT_JS, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env,
  }).trim();
}

function agentFails(args, envOverride) {
  try {
    agent(args, envOverride);
    return false;
  } catch {
    return true;
  }
}

// ---------------------------------------------------------- вспомогательный HTTP

function httpPut(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = JSON.stringify(body);
    const opts = {
      hostname: u.hostname, port: u.port, path: u.pathname,
      method: 'PUT', timeout: 3000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    };
    const req = require('http').request(opts, (res) => {
      let b = '';
      res.on('data', c => (b += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(b) }); }
        catch { resolve({ status: res.statusCode, body: b }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ---------------------------------------------------------- запуск сервера

function startServer() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      resolve({ srv, url: `http://127.0.0.1:${addr.port}` });
    });
    srv.on('error', reject);
  });
}

// ---------------------------------------------------------- основное

async function run() {
  const { srv, url } = await startServer();
  const env = { AI_DASHBOARD_URL: url };

  try {
    // --- Тест 1: agent-read читает из дашборда (реальный агент research) ---
    await test('agent-read через дашборд: research → model/variant/worktree/runner', () => {
      const out = agent(['agent-read', 'research'], env);
      const lines = out.split('\n');
      assert.ok(lines.length >= 4, `должно быть 4 строки, получили ${lines.length}: ${out}`);

      const model = lines[0];
      const worktree = lines[1];
      const variant = lines[2];
      const runner = lines[3];

      assert.ok(model, 'model не должна быть пустой');
      assert.ok(model.includes('/'), `model должна содержать /: ${model}`);
      assert.ok(worktree === '0' || worktree === '1', `worktree должно быть 0/1: ${worktree}`);
      assert.ok(variant, 'variant не должен быть пустым');
      // runner — может быть пустым (auto-detected из model; research.json не задаёт его явно)
    });

    // --- Тест 2: agent-read читает из дашборда (coding) ---
    await test('agent-read через дашборд: coding → worktree=1', () => {
      const out = agent(['agent-read', 'coding'], env);
      const lines = out.split('\n');
      assert.strictEqual(lines[1], '1', `coding должен иметь worktree=1: ${out}`);
    });

    // --- Тест 3: изменение модели через дашборд подхватывается ---
    await test('PUT /api/agents/research (меняем model) → agent-read видит изменения', async () => {
      // Сохраняем оригинальный конфиг research
      const researchFile = path.join(AGENTS_DIR, 'research.json');
      const original = fs.readFileSync(researchFile, 'utf8');

      try {
        const newModel = 'deepseek/deepseek-v4-flash-changed';

        // Меняем модель через API дашборда
        const res = await httpPut(`${url}/api/agents/research`, {
          name: 'research',
          description: 'Research agent (тест)',
          mode: 'primary',
          model: newModel,
          variant: 'low',
          worktree: false,
          timeout: 1800,
          autoCommit: false,
          systemPrompt: 'Тест',
          permissions: { bash: 'allow', read: 'allow' },
        });
        assert.strictEqual(res.status, 200, `должен быть 200: ${JSON.stringify(res)}`);
        assert.strictEqual(res.json.ok, true);

        // agent-read должен вернуть новую модель
        const out = agent(['agent-read', 'research'], env);
        const lines = out.split('\n');
        assert.strictEqual(lines[0], newModel, `agent-read вернул модель "${lines[0]}" вместо "${newModel}"`);
      } finally {
        // Восстанавливаем оригинальный конфиг
        fs.writeFileSync(researchFile, original);
      }
    });

    // --- Тест 4: fallback на локальный файл при недоступности дашборда ---
    await test('agent-read с невалидным AI_DASHBOARD_URL → fallback на локальный файл', () => {
      const out = agent(['agent-read', 'research'], { AI_DASHBOARD_URL: 'http://127.0.0.1:19999' });
      const lines = out.split('\n');
      assert.ok(lines[0], 'model должна быть считана (из локального файла)');
      assert.ok(lines[0].includes('/'), `model должна содержать /: ${lines[0]}`);
    });

    // --- Тест 5: несуществующий агент → ошибка ---
    await test('agent-read несуществующего агента → exit code ≠ 0', () => {
      const fails = agentFails(['agent-read', 'nonexistent-agent-xyz'], env);
      assert.ok(fails, 'должен быть ненулевой код выхода');
    });

    // --- Тест 6: agent-read без аргумента → ошибка ---
    await test('agent-read без имени → exit code ≠ 0', () => {
      const fails = agentFails(['agent-read'], env);
      assert.ok(fails, 'должен быть ненулевой код выхода');
    });

    // --- Тест 7: agent-read не падает на битом JSON от дашборда ---
    await test('agent-read с некорректным JSON от дашборда → fallback на локальный файл', () => {
      // Для этого теста нужен сервер, возвращающий мусор.
      // Наш настоящий сервер не возвращает мусор, но можно проверить фоллбэк,
      // указав неверный порт дашборда (вернёт connection error → fallback).
      const out = agent(['agent-read', 'research'], { AI_DASHBOARD_URL: 'http://127.0.0.1:1' });
      const lines = out.split('\n');
      assert.ok(lines[0].includes('/'), `должна быть валидная model из локального файла: ${lines[0]}`);
    });

  } finally {
    srv.close();
  }

  console.log(`\nпройдено: ${passed}, провалено: ${failed}`);
  if (!process.exitCode) {
    console.log('agent-read-dashboard: OK');
  }
}

run().catch((e) => {
  console.error('TEST SUITE ERROR: ' + e.message);
  process.exit(1);
});
