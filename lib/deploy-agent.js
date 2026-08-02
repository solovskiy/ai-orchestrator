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

function yamlLine(k, v, indent) {
  const pad = '  '.repeat(indent || 0);
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
      lines.push(k + ':');
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

function toOpenCodeMd(agent) {
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
