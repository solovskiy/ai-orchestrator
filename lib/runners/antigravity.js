'use strict';

/**
 * Адаптер исполнителя: Google Antigravity CLI (`agy`).
 *
 * Headless-режим подтверждён живым прогоном (agy 1.2.11, Windows):
 *   agy -p "<prompt>" --output-format stream-json
 * пишет в stdout NDJSON-события вида {"event": "<type>", "<type>": {...}}:
 *   init         -> conversation_id (сразу при старте)
 *   step_update  -> промежуточные шаги (text_delta, tool-вызовы) — не парсим,
 *                   финальный текст надёжнее брать из result.response
 *   result       -> conversation_id, status (SUCCESS/ERROR/...), response,
 *                   usage{input_tokens,output_tokens,thinking_tokens,
 *                   cache_read_tokens,total_tokens}, error, denied_actions
 *
 * Без --dangerously-skip-permissions живой прогон показал: permission_mode
 * по умолчанию "request-review", и в headless-режиме (нет TTY для промпта)
 * agy НЕ виснет — молча auto-denies каждый tool-вызов и завершается с
 * status:"SUCCESS", но denied_actions непустой и response пустой (тихий
 * no-op). Для фонового агента в изолированном worktree это неприемлемо —
 * флаг ставим всегда, как codex.js ставит --sandbox workspace-write.
 *
 * Явного --dir/--cwd/-C флага у agy нет (есть --add-dir, но это добавление
 * директории в мультирутовый workspace, не смена рабочей). Полагаемся на то,
 * что run-job.sh уже делает `cd "$CWD"` перед запуском раннера — init.cwd
 * в живом прогоне подтвердил, что agy подхватывает cwd процесса.
 *
 * Resume подтверждён живым прогоном: --conversation <id> продолжает сессию
 * (num_turns растёт, контекст сохраняется).
 */

module.exports = {
  name: 'antigravity',

  capabilities: {
    resume: true,
    cost: false, // agy отдаёт только токены, доллары не считает
    json: true,
  },

  buildArgs(job, prompt) {
    const args = ['agy', '-p', prompt, '--output-format', 'stream-json', '--dangerously-skip-permissions'];

    if (job.model) {
      const modelName = job.model.includes('/') ? job.model.split('/')[1] : job.model;
      args.push('--model', modelName);
    }
    if (job.agent) {
      args.push('--agent', job.agent);
    }
    if (job.resume && job.sessionId) {
      args.push('--conversation', job.sessionId);
    }

    return args;
  },

  parse(events) {
    let sessionId = null;
    let error = null;
    let resultText = '';
    const tokens = { input: 0, output: 0, reasoning: 0, total: 0 };

    for (const e of events) {
      if (!e || typeof e !== 'object') continue;

      const body = e[e.event];
      if (body && !sessionId && typeof body.conversation_id === 'string' && body.conversation_id) {
        sessionId = body.conversation_id;
      }

      if (e.event === 'result') {
        const r = e.result || {};
        if (typeof r.response === 'string') resultText = r.response.trim();

        if (r.status && r.status !== 'SUCCESS') {
          error = r.error || `agy: статус ${r.status}`;
        } else if (Array.isArray(r.denied_actions) && r.denied_actions.length > 0) {
          // status SUCCESS, но часть tool-вызовов auto-denied — тихий
          // no-op, не настоящий успех (см. пояснение в шапке файла).
          const names = r.denied_actions.map(a => a.display_name || a.action).join(', ');
          error = `agy: часть действий отклонена без --dangerously-skip-permissions: ${names}`;
        }

        if (r.usage) {
          tokens.input += r.usage.input_tokens || 0;
          tokens.output += r.usage.output_tokens || 0;
          tokens.reasoning += r.usage.thinking_tokens || 0;
          tokens.total += r.usage.total_tokens || 0;
        }
      }
    }

    return {
      sessionId,
      resultText,
      tokens,
      cost: null,
      error,
    };
  },
};
