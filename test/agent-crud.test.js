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

function agent(args) {
  return execFileSync('node', [AGENT_JS, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

let tmpDir;
try {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-agent-crud-test-'));
} catch (e) {
  console.error('не удалось создать временную директорию: ' + e.message);
  process.exit(1);
}

// ---------------------------------------------------------- create

test('agent-create — создаёт JSON-файл агента', () => {
  const out = agent(['agent-create', tmpDir, 'testbot']);
  assert.ok(out.includes('создан агент: testbot'), `вывод: ${out}`);

  const file = path.join(tmpDir, 'testbot.json');
  assert.ok(fs.existsSync(file), 'файл агента должен существовать');

  const a = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(a.name, 'testbot');
  assert.strictEqual(a.mode, 'primary');
  assert.strictEqual(a.model, 'opencode/deepseek-v4-flash-free');
  assert.strictEqual(a.worktree, false);
  assert.deepStrictEqual(a.permissions, {
    bash: 'allow', read: 'allow', edit: 'allow',
    glob: 'allow', grep: 'allow',
    webfetch: 'deny', websearch: 'deny', task: 'deny',
  });
});

test('agent-create — повторное создание того же имени → ошибка', () => {
  try {
    agent(['agent-create', tmpDir, 'testbot']);
    assert.fail('должен быть выброшен код ошибки');
  } catch (e) {
    assert.ok(e.stderr && e.stderr.includes('уже существует'),
      `stderr должен содержать "уже существует": ${e.stderr}`);
  }
});

test('agent-create — недопустимое имя (кириллица)', () => {
  try {
    agent(['agent-create', tmpDir, 'тест']);
    assert.fail('должен быть выброшен код ошибки');
  } catch (e) {
    assert.ok(e.stderr && e.stderr.includes('латиница'),
      `stderr должен содержать "латиница": ${e.stderr}`);
  }
});

test('agent-create — недопустимое имя (начинается с цифры)', () => {
  try {
    agent(['agent-create', tmpDir, '123bot']);
    assert.fail('должен быть выброшен код ошибки');
  } catch (e) {
    assert.ok(e.stderr && e.stderr.includes('латиница'),
      `stderr должен содержать "латиница": ${e.stderr}`);
  }
});

test('agent-create — недопустимое имя (спецсимволы)', () => {
  try {
    agent(['agent-create', tmpDir, 'bad!name']);
    assert.fail('должен быть выброшен код ошибки');
  } catch (e) {
    assert.ok(e.stderr && e.stderr.includes('латиница'),
      `stderr должен содержать "латиница": ${e.stderr}`);
  }
});

// ---------------------------------------------------------- list

test('agent-list — показывает всех созданных агентов', () => {
  // создаём второго агента для проверки списка
  agent(['agent-create', tmpDir, 'secondbot']);

  const out = agent(['agent-list', tmpDir]);
  assert.ok(out.includes('testbot'), `должен содержать testbot: ${out}`);
  assert.ok(out.includes('secondbot'), `должен содержать secondbot: ${out}`);
  // заголовки таблицы
  assert.ok(out.includes('АГЕНТ'), 'должен быть заголовок АГЕНТ');
  assert.ok(out.includes('MODE'), 'должен быть заголовок MODE');
  assert.ok(out.includes('MODEL'), 'должен быть заголовок MODEL');
});

test('agent-list — пустая директория', () => {
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-agent-empty-'));
  // директория существует, но в ней нет .json файлов — ждём сообщение или пустую таблицу
  try {
    const out = agent(['agent-list', emptyDir]);
    // команда не падает на пустой/несуществующей директории
    assert.ok(typeof out === 'string', 'вывод должен быть строкой');
  } catch (e) {
    // может упасть если agentsDir не существует — проверяем что ошибка не про чтение
    assert.ok(e.stderr && !e.stderr.includes('ENOENT'),
      `не должно быть ENOENT: ${e.stderr}`);
  }
  fs.rmSync(emptyDir, { recursive: true, force: true });
});

// ---------------------------------------------------------- show

test('agent-show — показывает JSON агента', () => {
  const out = agent(['agent-show', tmpDir, 'testbot']);
  const a = JSON.parse(out);
  assert.strictEqual(a.name, 'testbot');
  assert.strictEqual(a.mode, 'primary');
  assert.ok(a.permissions, 'должны быть permissions');
});

test('agent-show — несуществующий агент → ошибка', () => {
  try {
    agent(['agent-show', tmpDir, 'nonexistent']);
    assert.fail('должен быть выброшен код ошибки');
  } catch (e) {
    assert.ok(e.stderr && e.stderr.includes('не найден'),
      `stderr должен содержать "не найден": ${e.stderr}`);
  }
});

// ---------------------------------------------------------- delete

test('agent-delete — удаляет JSON-файл агента', () => {
  const out = agent(['agent-delete', tmpDir, 'testbot']);
  assert.ok(out.includes('удалён агент: testbot'), `вывод: ${out}`);

  const file = path.join(tmpDir, 'testbot.json');
  assert.ok(!fs.existsSync(file), 'файл агента должен быть удалён');
});

test('agent-delete — несуществующий агент → ошибка', () => {
  try {
    agent(['agent-delete', tmpDir, 'nonexistent']);
    assert.fail('должен быть выброшен код ошибки');
  } catch (e) {
    assert.ok(e.stderr && e.stderr.includes('не найден'),
      `stderr должен содержать "не найден": ${e.stderr}`);
  }
});

// ---------------------------------------------------------- дефолтный агент (create без дополнительных опций)

test('agent-create — все поля default-агента корректны', () => {
  const out = agent(['agent-create', tmpDir, 'defaultbot']);
  assert.ok(out.includes('создан агент'));

  const file = path.join(tmpDir, 'defaultbot.json');
  const a = JSON.parse(fs.readFileSync(file, 'utf8'));

  // поля по умолчанию из cmdAgentCreate
  assert.strictEqual(a.name, 'defaultbot');
  assert.strictEqual(a.description, '');
  assert.strictEqual(a.mode, 'primary');
  assert.strictEqual(a.model, 'opencode/deepseek-v4-flash-free');
  assert.strictEqual(a.variant, 'medium');
  assert.strictEqual(a.worktree, false);
  assert.strictEqual(a.timeout, 1800);
  assert.strictEqual(a.autoCommit, false);
  assert.strictEqual(a.systemPrompt, '');
  assert.ok(a.permissions, 'permissions должны быть');
  assert.strictEqual(a.permissions.bash, 'allow');
  assert.strictEqual(a.permissions.webfetch, 'deny');
});

// ---------------------------------------------------------- cleanup

// удаляем оставшихся агентов и чистим временную директорию
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

if (!process.exitCode) {
  console.log('\nagent-crud: OK');
}
