'use strict';

/**
 * Деплой агента из канонического JSON в нативный формат раннера.
 *
 * Сейчас единственный раннер — opencode (YAML frontmatter + markdown).
 * При добавлении нового раннера — добавить сюда ещё один генератор.
 *
 * Использование:
 *   node lib/deploy-agent.js <agentsDir> <name> [--target <dir>]
 *     --target — куда писать agent.md (по умолчанию: stdout)
 *     без --target печатает agent.md в stdout
 */

const fs = require('fs');
const path = require('path');

// ------------------------------------------------------------------ YAML

function yamlKey(k) {
  // ключи-глобы (`agent-browser*`) и прочие спецсимволы — в кавычки
  return /[^A-Za-z0-9_.\- ]/.test(k) ? '"' + String(k).replace(/"/g, '\\"') + '"' : k;
}

function yamlLine(rawKey, v, indent) {
  const pad = '  '.repeat(indent || 0);
  const k = yamlKey(rawKey);
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return pad + k + ': ' + v;
  if (typeof v === 'number') return pad + k + ': ' + v;
  // строку в кавычки, если есть спецсимволы
  const s = String(v);
  if (s.includes(':') || s.includes('#') || s.includes('{') || s.includes('}') || s.includes('[') || s.includes(']') || s.includes('|') || s.includes('>') || s.includes('*') || s.includes('&') || s.includes('!') || s.includes('"') || s.includes("'")) {
    return pad + k + ': "' + s.replace(/"/g, '\\"') + '"';
  }
  return pad + k + ': ' + s;
}

/**
 * Генерирует YAML-блок из плоского объекта (только скалярные значения
 * и вложенные объекты глубиной 1 — как `permission`).
 */
function toYaml(obj, indent) {
  const lines = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined || v === '' || v === false) continue;
    if (typeof v === 'object' && !Array.isArray(v)) {
      lines.push(yamlKey(k) + ':');
      for (const [pk, pv] of Object.entries(v)) {
        if (pv === null || pv === undefined) continue;
        lines.push(yamlLine(pk, pv, indent + 1));
      }
    } else {
      lines.push(yamlLine(k, v, indent));
    }
  }
  return lines.join('\n');
}

// ------------------------------------------------------------------ генераторы

/**
 * Имена MCP-серверов, объявленных в глобальном конфиге opencode.
 * Нужны, чтобы `mcp: [...]` в агенте мог явно ОТКЛЮЧИТЬ все остальные:
 * opencode не умеет «только эти», умеет только точечные allow/deny.
 */
function knownMcpServers() {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (!home) return [];
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(home, '.config', 'opencode', 'opencode.json'), 'utf8'));
    return Object.keys(cfg.mcp || {});
  } catch (e) {
    return [];
  }
}

/**
 * `mcp: ["agent-browser"]` → tools-глобы, которые opencode реально понимает.
 * Само поле `mcp` во frontmatter агента opencode игнорирует (в схеме его нет),
 * поэтому изоляция делается через `tools`: перечисленные серверы включаются,
 * все прочие известные — выключаются.
 */
function mcpToTools(mcp) {
  const allow = new Set(mcp);
  const tools = {};
  for (const name of knownMcpServers()) {
    if (!allow.has(name)) tools[name + '*'] = false;
  }
  for (const name of allow) tools[name + '*'] = true;
  return tools;
}

function toOpenCodeMd(agent) {
  const fm = {};
  if (agent.description) fm.description = agent.description;
  if (agent.mode) fm.mode = agent.mode;
  if (agent.model) fm.model = agent.model;
  if (agent.temperature != null) fm.temperature = agent.temperature;
  if (agent.color) fm.color = agent.color;
  if (agent.maxSteps) fm.maxSteps = agent.maxSteps;

  const tools = {};
  if (agent.mcp && Array.isArray(agent.mcp) && agent.mcp.length > 0) {
    Object.assign(tools, mcpToTools(agent.mcp));
  }
  // явный tools в JSON перекрывает то, что вывелось из mcp
  if (agent.tools && typeof agent.tools === 'object') Object.assign(tools, agent.tools);
  if (Object.keys(tools).length > 0) fm.tools = tools;
  if (agent.permissions && Object.keys(agent.permissions).length > 0) {
    fm.permission = agent.permissions;
  }

  const frontmatter = toYaml(fm, 0);
  const body = agent.systemPrompt || '';
  return '---\n' + frontmatter + '\n---\n\n' + body + '\n';
}

// ------------------------------------------------------------------ main

function main() {
  const args = process.argv.slice(2);
  let agentsDir = '';
  let name = '';
  let targetDir = '';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--target' && args[i + 1]) { targetDir = args[++i]; }
    else if (!agentsDir) agentsDir = args[i];
    else if (!name) name = args[i];
  }

  if (!agentsDir || !name) {
    console.error('deploy-agent: нужно agentsDir и name');
    process.exit(1);
  }

  const jsonFile = path.join(agentsDir, name + '.json');
  let agent;
  try {
    agent = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
  } catch (e) {
    console.error('deploy-agent: не удалось прочитать ' + jsonFile + ': ' + e.message);
    process.exit(1);
  }

  const md = toOpenCodeMd(agent);

  if (targetDir) {
    let agentsDir;
    if (targetDir === '--global') {
      // глобальная установка: ~/.config/opencode/agents/
      const home = process.env.HOME || process.env.USERPROFILE || '';
      agentsDir = path.join(home, '.config', 'opencode', 'agents');
    } else {
      // проект: <target>/.opencode/agents/
      agentsDir = path.join(targetDir, '.opencode', 'agents');
    }
    fs.mkdirSync(agentsDir, { recursive: true });
    const outFile = path.join(agentsDir, name + '.md');

    fs.writeFileSync(outFile, md);
    console.log('deploy-agent: ' + outFile);
  } else {
    process.stdout.write(md);
  }
}

if (require.main === module) {
  try { main(); } catch (e) { console.error('deploy-agent: ' + e.message); process.exit(1); }
}
module.exports = { yamlLine, toYaml, toOpenCodeMd };
