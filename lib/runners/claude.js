'use strict';

const fs = require('fs');
const path = require('path');

const AGENTS_DIR = path.join(__dirname, '..', '..', 'agents');

// Ключи permissions из agents/*.json (формат opencode) → инструменты Claude Code.
// "deny" превращается в --disallowedTools; остальное разрешено через
// --dangerously-skip-permissions (в headless-режиме спросить некого).
const TOOL_MAP = {
  bash: ['Bash', 'PowerShell'],
  edit: ['Edit', 'Write', 'NotebookEdit'],
  read: ['Read'],
  glob: ['Glob'],
  grep: ['Grep'],
  webfetch: ['WebFetch'],
  websearch: ['WebSearch'],
  task: ['Agent', 'Task'],
  skill: ['Skill'],
};

// Уровни усилия agents/*.json и --variant (minimal..max) → `claude --effort`.
const EFFORT_MAP = { minimal: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' };

function loadAgentConfig(name) {
  if (!name) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(AGENTS_DIR, name + '.json'), 'utf8'));
  } catch {
    return null;
  }
}

// "{env:NAME}" в конфиге opencode → значение переменной окружения
function expandEnv(v) {
  return typeof v === 'string' ? v.replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, n) => process.env[n] || '') : v;
}
function expandEnvObj(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) out[k] = expandEnv(v);
  return out;
}

/**
 * `mcp: ["browser-bot"]` из agents/*.json → JSON для --mcp-config.
 * Определения серверов берутся из глобального конфига opencode
 * (~/.config/opencode/opencode.json, секция mcp) — единый источник правды
 * для обоих раннеров. Неизвестные/выключенные имена пропускаются.
 */
function mcpConfigFor(cfg) {
  const names = cfg && Array.isArray(cfg.mcp) ? cfg.mcp : [];
  if (!names.length) return null;
  const home = process.env.HOME || process.env.USERPROFILE || '';
  let defs = {};
  try {
    defs = JSON.parse(fs.readFileSync(path.join(home, '.config', 'opencode', 'opencode.json'), 'utf8')).mcp || {};
  } catch {
    return null;
  }
  const servers = {};
  for (const name of names) {
    const d = defs[name];
    if (!d || d.enabled === false) continue;
    if (d.type === 'local' && Array.isArray(d.command) && d.command.length) {
      servers[name] = { command: d.command[0], args: d.command.slice(1).map(expandEnv), env: expandEnvObj(d.environment || d.env) };
    } else if (d.type === 'remote' && d.url) {
      servers[name] = { type: 'http', url: expandEnv(d.url), headers: expandEnvObj(d.headers) };
    }
  }
  return Object.keys(servers).length ? JSON.stringify({ mcpServers: servers }) : null;
}

// Системные промпты агентов написаны под opencode, где MCP-инструмент
// называется `<server>_<tool>`; в Claude Code это `mcp__<server>__<tool>`.
const MCP_NAMING_NOTE =
  '\n\nNOTE (Claude Code runtime): MCP tools are named `mcp__<server>__<tool>`. ' +
  'Wherever these instructions mention a tool as `<server>_<tool>` (e.g. `browser-bot_browser_navigate`), ' +
  'use `mcp__<server>__<tool>` (e.g. `mcp__browser-bot__browser_navigate`).';

function deniedTools(cfg) {
  const perms = (cfg && cfg.permissions) || {};
  const out = [];
  for (const [key, val] of Object.entries(perms)) {
    if (val === 'deny' && TOOL_MAP[key]) out.push(...TOOL_MAP[key]);
  }
  return out;
}

module.exports = {
  name: 'claude',

  capabilities: {
    resume: true,
    cost: true,
    json: true,
  },

  // extraFlags — флаги, которые раннер-обёртка (claude-ds) добавляет сразу после `claude`
  buildArgs(job, prompt, extraFlags = []) {
    const cfg = loadAgentConfig(job.agent);
    const args = ['claude', ...extraFlags];

    // --disallowedTools и --mcp-config вариадические: ставим их первыми, перед -p,
    // чтобы они не съели промпт
    const denied = deniedTools(cfg);
    if (denied.length) args.push('--disallowedTools', denied.join(','));
    const mcpConfig = mcpConfigFor(cfg);
    if (mcpConfig) args.push('--mcp-config', mcpConfig);

    // stream-json в режиме -p требует --verbose (иначе CLI сразу падает)
    args.push('-p', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions');

    if (job.model) {
      const i = job.model.indexOf('/');
      args.push('--model', i >= 0 ? job.model.slice(i + 1) : job.model);
    }
    // variant — уровень усилия (opencode: --variant); у Claude Code это --effort
    const effort = EFFORT_MAP[String(job.variant || '').toLowerCase()];
    if (effort) args.push('--effort', effort);
    if (cfg && cfg.systemPrompt) {
      args.push('--append-system-prompt', cfg.systemPrompt + (mcpConfig ? MCP_NAMING_NOTE : ''));
    }
    if (job.resume && job.sessionId) {
      args.push('--resume', job.sessionId);
    }
    const maxTurns = typeof job.maxTurns === 'number' ? job.maxTurns : cfg && cfg.maxSteps;
    if (typeof maxTurns === 'number') {
      args.push('--max-turns', String(maxTurns));
    }
    args.push(prompt);
    return args;
  },

  parse(events) {
    let sessionId = null;
    let error = null;
    let cost = null;
    let finalText = null;
    const texts = [];
    const tokens = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0 };

    for (const e of events) {
      if (!e || typeof e !== 'object') continue;

      if (!sessionId && e.session_id) sessionId = e.session_id;
      if (!sessionId && e.sessionId) sessionId = e.sessionId;

      switch (e.type) {
        case 'assistant': {
          const content = e.message && Array.isArray(e.message.content) ? e.message.content : [];
          for (const c of content) {
            if (c && c.type === 'text' && typeof c.text === 'string') texts.push(c.text);
          }
          break;
        }

        case 'error':
          error = e.message || e.error || JSON.stringify(e).slice(0, 500);
          break;

        case 'result':
          if (typeof e.result === 'string') finalText = e.result;
          if (typeof e.total_cost_usd === 'number') cost = e.total_cost_usd;
          if (e.usage) {
            tokens.input += e.usage.input_tokens || 0;
            tokens.output += e.usage.output_tokens || 0;
            tokens.cacheRead += e.usage.cache_read_input_tokens || 0;
            tokens.cacheCreation += e.usage.cache_creation_input_tokens || 0;
          }
          if ((e.is_error === true || (e.subtype && e.subtype !== 'success')) && !error) {
            error = (Array.isArray(e.errors) && e.errors.join('; ')) || e.subtype || e.error || JSON.stringify(e).slice(0, 500);
          }
          break;
      }
    }

    tokens.total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheCreation;

    // result.result — финальный ответ; если его нет (обрыв), берём последний текст ассистента
    const resultText = (finalText != null && finalText.trim()) ? finalText : (texts[texts.length - 1] || '');

    return {
      sessionId,
      resultText: resultText.trim(),
      tokens,
      cost,
      error,
    };
  },
};
