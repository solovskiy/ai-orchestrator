'use strict';

/**
 * Адаптер исполнителя: OpenAI Codex CLI (codex exec).
 *
 * Голый `codex` — это интерактивный TUI (требует TTY). Для фонового
 * запуска используем headless-режим `codex exec ... --json`, который
 * пишет в stdout поток JSONL-событий (см. codex-rs/exec/src/exec_events.rs):
 *   thread.started   -> thread_id      (sessionId для resume)
 *   turn.completed   -> usage          (токены)
 *   item.completed   -> item.type === "agent_message" -> item.text
 *   error / turn.failed -> error.message
 * CLI стоимость в долларах НЕ отдаёт — только токены (cost: null ожидаемо).
 */

module.exports = {
  name: 'codex',

  capabilities: {
    resume: true,
    cost: false,
    json: true,
  },

  buildArgs(job, prompt) {
    // cwd у codex задаётся через `-C`/`--cd` (в shared_options.rs поле названо
    // cwd, но CLI-флаг — `cd`; `--cwd` не существует).
    const base = ['codex', 'exec', '--json', '-C', job.cwd || '.'];

    if (job.model) {
      const modelName = job.model.includes('/') ? job.model.split('/')[1] : job.model;
      base.push('--model', modelName);
    }

    // approval_policy в exec-режиме принудительно "never" (без интерактива).
    // Для headless-агента задаём песочницу явно: workspace-write — рабочая
    // директория доступна на запись (наш use-case — агент в git-worktree),
    // всё остальное в изоляции.
    base.push('--sandbox', 'workspace-write');

    if (job.resume && job.sessionId) {
      // продолжение сессии: codex exec resume <SESSION_ID> "<msg>"
      base.push('resume', job.sessionId, prompt);
      return base;
    }

    base.push(prompt);
    return base;
  },

  parse(events) {
    let sessionId = null;
    let error = null;
    const texts = [];
    const tokens = { input: 0, output: 0, reasoning: 0, total: 0 };

    for (const e of events) {
      if (!e || typeof e !== 'object') continue;

      switch (e.type) {
        case 'thread.started':
          if (!sessionId && typeof e.thread_id === 'string') sessionId = e.thread_id;
          break;

        case 'turn.completed': {
          const u = e.usage || {};
          const input = (u.input_tokens || 0) + (u.cached_input_tokens || 0);
          const output = u.output_tokens || 0;
          const reasoning = u.reasoning_output_tokens || 0;
          tokens.input += input;
          tokens.output += output;
          tokens.reasoning += reasoning;
          tokens.total += input + output + reasoning;
          break;
        }

        case 'item.completed': {
          const item = e.item || {};
          if (item.type === 'agent_message' && typeof item.text === 'string') {
            texts.push(item.text);
          }
          break;
        }

        case 'error':
          error = e.message || e.error || JSON.stringify(e).slice(0, 500);
          break;

        case 'turn.failed': {
          const msg = e.error && (e.error.message || e.error.error);
          error = msg || e.message || JSON.stringify(e).slice(0, 500);
          break;
        }
      }
    }

    return {
      sessionId,
      resultText: texts.join('\n\n').trim(),
      tokens,
      cost: null,
      error,
    };
  },
};
