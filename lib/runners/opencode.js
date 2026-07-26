'use strict';

/**
 * Адаптер исполнителя: opencode.
 *
 * Контракт, который обязан реализовать любой runner:
 *   capabilities        — что исполнитель умеет (влияет на доступность команд)
 *   buildArgs(job, prompt) -> string[]   argv для запуска
 *   parse(events)       -> { sessionId, resultText, tokens, cost, error }
 *
 * Заменить исполнителя = добавить сюда рядом ещё один такой файл.
 * Интерфейс `agent` при этом не меняется.
 */
module.exports = {
  name: 'opencode',

  capabilities: {
    resume: true, // умеет продолжать сессию по id  -> работает `agent send`
    cost: true, // отдаёт стоимость и токены
    json: true, // машиночитаемый поток событий
  },

  /**
   * ТЗ передаётся позиционным аргументом прямо при запуске — так оно
   * попадает агенту сразу и целиком. Никакого «допечатывания» после старта,
   * из-за которого ломаются многострочные тексты.
   */
  buildArgs(job, prompt) {
    const args = ['opencode', 'run', '--format', 'json'];

    if (job.model) args.push('--model', job.model);
    if (job.cwd) args.push('--dir', job.cwd);
    if (job.resume && job.sessionId) args.push('--session', job.sessionId);
    if (job.task) args.push('--title', job.task);

    args.push(prompt);
    return args;
  },

  /**
   * Разбор потока событий opencode.
   * Толерантен к неизвестным типам событий: что не опознали — игнорируем,
   * чтобы обновление opencode не ломало нам разбор.
   */
  parse(events) {
    let sessionId = null;
    let error = null;
    let cost = 0;
    const texts = [];
    const tokens = { input: 0, output: 0, reasoning: 0, total: 0 };

    for (const e of events) {
      if (!e || typeof e !== 'object') continue;
      if (!sessionId && e.sessionID) sessionId = e.sessionID;

      const part = e.part || {};

      switch (e.type) {
        case 'text':
          if (typeof part.text === 'string') texts.push(part.text);
          break;

        case 'step_finish':
          if (typeof part.cost === 'number') cost += part.cost;
          if (part.tokens) {
            tokens.input += part.tokens.input || 0;
            tokens.output += part.tokens.output || 0;
            tokens.reasoning += part.tokens.reasoning || 0;
            tokens.total += part.tokens.total || 0;
          }
          break;

        case 'error':
          error = part.message || part.error || JSON.stringify(part).slice(0, 500);
          break;

        default:
          break; // tool-вызовы и прочее нас здесь не интересуют
      }
    }

    return {
      sessionId,
      resultText: texts.join('\n\n').trim(),
      tokens,
      cost,
      error,
    };
  },
};
