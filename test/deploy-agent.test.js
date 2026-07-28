'use strict';
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { yamlLine, toYaml, toOpenCodeMd } = require('../lib/deploy-agent.js');

function test(desc, fn) {
  try { fn(); console.log(`  OK ${desc}`); }
  catch (e) { console.error(`  FAIL ${desc}: ${e.message}`); process.exitCode = 1; }
}

// ==================================================================== yamlLine

test('yamlLine — простая строка', () => {
  assert.strictEqual(yamlLine('key', 'value', 0), 'key: value');
});

test('yamlLine — булево значение', () => {
  assert.strictEqual(yamlLine('enabled', true, 0), 'enabled: true');
  assert.strictEqual(yamlLine('enabled', false, 0), 'enabled: false');
});

test('yamlLine — число', () => {
  assert.strictEqual(yamlLine('port', 8080, 0), 'port: 8080');
  assert.strictEqual(yamlLine('temperature', 0.7, 0), 'temperature: 0.7');
});

test('yamlLine — null/undefined → пустая строка', () => {
  assert.strictEqual(yamlLine('x', null, 0), '');
  assert.strictEqual(yamlLine('x', undefined, 0), '');
});

test('yamlLine — экранирование двоеточия', () => {
  assert.strictEqual(
    yamlLine('description', 'расход: топливо и ремонт', 0),
    'description: "расход: топливо и ремонт"'
  );
});

test('yamlLine — экранирование решётки', () => {
  assert.strictEqual(
    yamlLine('desc', 'TODO #1: fix', 0),
    'desc: "TODO #1: fix"'
  );
});

test('yamlLine — экранирование двойной кавычки', () => {
  assert.strictEqual(
    yamlLine('desc', 'say "hello"', 0),
    'desc: "say \\"hello\\""'
  );
});

test('yamlLine — экранирование фигурных скобок', () => {
  assert.strictEqual(
    yamlLine('template', '{user} said {msg}', 0),
    'template: "{user} said {msg}"'
  );
});

test('yamlLine — экранирование квадратных скобок', () => {
  assert.strictEqual(
    yamlLine('list', '[a, b, c]', 0),
    'list: "[a, b, c]"'
  );
});

test('yamlLine — экранирование pipe', () => {
  assert.strictEqual(
    yamlLine('expr', 'a | b', 0),
    'expr: "a | b"'
  );
});

test('yamlLine — экранирование звёздочки', () => {
  assert.strictEqual(
    yamlLine('glob', 'src/**/*.ts', 0),
    'glob: "src/**/*.ts"'
  );
});

test('yamlLine — число 0 (не должно быть пропущено как falsy)', () => {
  assert.strictEqual(yamlLine('port', 0, 0), 'port: 0');
});

test('yamlLine — c отступом (indent > 0)', () => {
  assert.strictEqual(
    yamlLine('read', 'allow', 1),
    '  read: allow'
  );
});

test('yamlLine — отступ 2', () => {
  assert.strictEqual(
    yamlLine('key', 'val', 2),
    '    key: val'
  );
});

// ==================================================================== toYaml

test('toYaml — плоский объект', () => {
  const obj = { name: 'test', model: 'gpt-4', temperature: 0.5 };
  const y = toYaml(obj, 0);
  assert.ok(y.includes('name: test'));
  assert.ok(y.includes('model: gpt-4'));
  assert.ok(y.includes('temperature: 0.5'));
});

test('toYaml — пропуск null/undefined/пустой строки/false', () => {
  const obj = { a: 'keep', b: null, c: undefined, d: '', e: false };
  const y = toYaml(obj, 0);
  assert.ok(y.includes('a: keep'));
  assert.ok(!y.includes('b:'));
  assert.ok(!y.includes('c:'));
  assert.ok(!y.includes('d:'));
  assert.ok(!y.includes('e:'));
});

test('toYaml — вложенный объект (permissions)', () => {
  const obj = {
    permissions: { bash: 'allow', read: 'allow', webfetch: 'deny' }
  };
  const y = toYaml(obj, 0);
  assert.ok(y.includes('permissions:'));
  assert.ok(y.includes('  bash: allow'));
  assert.ok(y.includes('  read: allow'));
  assert.ok(y.includes('  webfetch: deny'));
});

test('toYaml — вложенный объект с пропуском null во вложении', () => {
  const obj = {
    permissions: { bash: 'allow', webfetch: null }
  };
  const y = toYaml(obj, 0);
  assert.ok(y.includes('bash: allow'));
  assert.ok(!y.includes('webfetch'));
});

test('toYaml — число 0 (не должно быть пропущено)', () => {
  const obj = { timeout: 0, retries: 0 };
  const y = toYaml(obj, 0);
  assert.ok(y.includes('timeout: 0'));
  assert.ok(y.includes('retries: 0'));
});

test('toYaml — boolean true в объекте', () => {
  const obj = { enabled: true };
  const y = toYaml(obj, 0);
  assert.strictEqual(y, 'enabled: true');
});

// ==================================================================== toOpenCodeMd

test('toOpenCodeMd — минимальный агент', () => {
  const agent = {
    name: 'test',
    description: 'тестовый агент',
    model: 'opencode/deepseek-v4-flash-free',
    systemPrompt: 'Ты — тестовый помощник.\nОтвечай кратко.\n',
  };
  const md = toOpenCodeMd(agent);
  assert.ok(md.startsWith('---\n'));
  assert.ok(md.includes('description: тестовый агент'));
  assert.ok(md.includes('model: opencode/deepseek-v4-flash-free'));
  assert.ok(md.includes('\n---\n'));
  assert.ok(md.endsWith('\n'));
  assert.ok(md.includes('Ты — тестовый помощник.\nОтвечай кратко.\n'));
});

test('toOpenCodeMd — агент с permissions', () => {
  const agent = {
    name: 'coding',
    description: 'кодинг-агент',
    model: 'deepseek/deepseek-v4-pro',
    systemPrompt: 'Пиши код.',
    permissions: { bash: 'allow', read: 'allow', edit: 'allow', webfetch: 'deny' },
  };
  const md = toOpenCodeMd(agent);
  assert.ok(md.includes('permission:'));
  assert.ok(md.includes('  bash: allow'));
  assert.ok(md.includes('  read: allow'));
  assert.ok(md.includes('  edit: allow'));
  assert.ok(md.includes('  webfetch: deny'));
});

test('toOpenCodeMd — все поля заполнены', () => {
  const agent = {
    name: 'full',
    description: 'полный агент со всеми полями',
    mode: 'primary',
    model: 'deepseek/deepseek-v4-pro',
    temperature: 0.3,
    color: '#ff0000',
    maxSteps: 50,
    permissions: { bash: 'allow', read: 'allow', edit: 'allow' },
    systemPrompt: 'You are a helpful assistant.\n',
  };
  const md = toOpenCodeMd(agent);
  assert.ok(md.includes('description: полный агент со всеми полями'));
  assert.ok(md.includes('mode: primary'));
  assert.ok(md.includes('model: deepseek/deepseek-v4-pro'));
  assert.ok(md.includes('temperature: 0.3'));
  assert.ok(md.includes('color: "#ff0000"'));
  assert.ok(md.includes('maxSteps: 50'));
  assert.ok(md.includes('permission:'));
  assert.ok(md.includes('You are a helpful assistant.'));
});

test('toOpenCodeMd — пустой systemPrompt (без тела)', () => {
  const agent = {
    name: 'noprompt',
    model: 'gpt-4',
    systemPrompt: '',
  };
  const md = toOpenCodeMd(agent);
  // frontmatter + пустая строка + пустое тело
  assert.ok(md.startsWith('---\n'));
  assert.ok(md.includes('model: gpt-4'));
  const parts = md.split('---\n');
  assert.strictEqual(parts.length, 3); // ---\n...\n---\n\n...\n
});

test('toOpenCodeMd — description с двоеточием (экранирование в YAML)', () => {
  const agent = {
    name: 'special',
    description: 'агент: кодинг и ресёрч',
    model: 'deepseek',
    systemPrompt: '',
  };
  const md = toOpenCodeMd(agent);
  assert.ok(md.includes('description: "агент: кодинг и ресёрч"'));
});

test('toOpenCodeMd — permissions с deny (строка, не булево false)', () => {
  const agent = {
    name: 'restricted',
    model: 'openai/gpt-4',
    systemPrompt: '',
    permissions: { bash: 'allow', read: 'allow', webfetch: 'deny' },
  };
  const md = toOpenCodeMd(agent);
  assert.ok(md.includes('webfetch: deny'), 'deny не должен вырезаться как false');
});

test('toOpenCodeMd — пустые permissions (не должны появиться в YAML)', () => {
  const agent = {
    name: 'noperms',
    model: 'gpt-4',
    systemPrompt: '',
    permissions: {},
  };
  const md = toOpenCodeMd(agent);
  assert.ok(!md.includes('permission'));
});

test('toOpenCodeMd — permissions == null (не должны появиться)', () => {
  const agent = {
    name: 'noperms2',
    model: 'gpt-4',
    systemPrompt: '',
    permissions: null,
  };
  const md = toOpenCodeMd(agent);
  assert.ok(!md.includes('permission'));
});

// ==================================================================== freshness-check (интеграционные)

const DEPLOY_AGENT_JS = path.join(__dirname, '..', 'lib', 'deploy-agent.js');

let tmpAgentsDir, tmpTargetDir;
try {
  tmpAgentsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-deploy-agent-json-'));
  tmpTargetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-deploy-agent-target-'));
} catch (e) {
  console.error('не удалось создать временную директорию: ' + e.message);
  process.exit(1);
}

// кладём валидный agents/<name>.json с минимальным набором полей
const testAgentJson = {
  name: 'freshness-test',
  model: 'test/model',
  systemPrompt: 'тестовый промпт\n',
  permissions: { bash: 'allow', read: 'allow' },
};
fs.writeFileSync(path.join(tmpAgentsDir, 'freshness-test.json'), JSON.stringify(testAgentJson));

function deploy(args) {
  return execFileSync('node', [DEPLOY_AGENT_JS, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

test('freshness — первый запуск создаёт .md файл', () => {
  const outFile = path.join(tmpTargetDir, '.opencode', 'agents', 'freshness-test.md');
  assert.ok(!fs.existsSync(outFile), 'перед тестом .md не должен существовать');

  const out = deploy([tmpAgentsDir, 'freshness-test', '--target', tmpTargetDir]);
  assert.ok(out.includes('deploy-agent:'), `вывод должен содержать deploy-agent: ${out}`);
  assert.ok(!out.includes('уже актуален'), 'первый запуск не должен выводить "уже актуален"');
  assert.ok(fs.existsSync(outFile), '.md файл должен быть создан');
});

test('freshness — второй запуск без изменений пропускает запись', () => {
  const outFile = path.join(tmpTargetDir, '.opencode', 'agents', 'freshness-test.md');
  const mtimeBefore = fs.statSync(outFile).mtimeMs;

  const out = deploy([tmpAgentsDir, 'freshness-test', '--target', tmpTargetDir]);
  assert.ok(out.includes('уже актуален'), `вывод должен содержать "уже актуален": ${out}`);

  const mtimeAfter = fs.statSync(outFile).mtimeMs;
  assert.strictEqual(mtimeAfter, mtimeBefore, 'mtime .md не должен измениться при повторе');
});

test('freshness — после изменения .json .md перезаписывается', () => {
  const outFile = path.join(tmpTargetDir, '.opencode', 'agents', 'freshness-test.md');
  const mtimeBefore = fs.statSync(outFile).mtimeMs;

  // «трогаем» jsonFile — ставим mtime на 10 секунд позже текущего
  const jsonFile = path.join(tmpAgentsDir, 'freshness-test.json');
  const now = new Date();
  const later = new Date(now.getTime() + 10000);
  fs.utimesSync(jsonFile, later, later);

  const out = deploy([tmpAgentsDir, 'freshness-test', '--target', tmpTargetDir]);
  assert.ok(!out.includes('уже актуален'),
    `после изменения .json не должно быть "уже актуален": ${out}`);
  assert.ok(out.includes('deploy-agent:'), `вывод должен содержать deploy-agent: ${out}`);

  const mtimeAfter = fs.statSync(outFile).mtimeMs;
  assert.ok(mtimeAfter > mtimeBefore, 'mtime .md должен измениться после перезаписи');
});

// ---------------------------------------------------------- cleanup
try { fs.rmSync(tmpAgentsDir, { recursive: true, force: true }); } catch {}
try { fs.rmSync(tmpTargetDir, { recursive: true, force: true }); } catch {}

// ==================================================================== итог

if (!process.exitCode) {
  console.log('\ndeploy-agent: OK');
}
