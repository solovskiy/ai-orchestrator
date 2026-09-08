'use strict';

const claude = require('./claude');

/**
 * Адаптер исполнителя: Claude Code CLI, направленный на DeepSeek через её
 * Anthropic-совместимый эндпоинт (https://api-docs.deepseek.com/guides/anthropic_api/).
 *
 * Это тот же бинарник `claude` и тот же формат вывода (stream-json), что и у
 * обычного раннера `claude` — buildArgs/parse переиспользуются оттуда.
 * Разница только в том, куда он стучится: ANTHROPIC_BASE_URL/ANTHROPIC_API_KEY
 * переопределены через `env VAR=... claude ...` только для ЭТОГО запуска —
 * обычный раннер `claude` (настоящий Anthropic-аккаунт) их не видит и не
 * трогает общее окружение процесса.
 *
 * DeepSeek сам мапит claude-опсен/сонет/хайку алиасы на deepseek-v4-pro/flash
 * по подстроке в имени модели, поэтому `--model` передаётся как обычно
 * (`sonnet`, `opus`, ...) — отдельная переменная модели не нужна.
 *
 * Требует DEEPSEEK_API_KEY в окружении (ключ DeepSeek, НЕ Anthropic —
 * умышленно отдельное имя переменной, чтобы не перепутать с обычным
 * Anthropic-ключом/подпиской раннера `claude`).
 */
module.exports = {
  name: 'claude-ds',

  capabilities: { ...claude.capabilities },

  buildArgs(job, prompt) {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) {
      throw new Error('claude-ds: не задан DEEPSEEK_API_KEY в окружении (нужен ключ DeepSeek, не Anthropic)');
    }

    const inner = claude.buildArgs(job, prompt);
    return [
      'env',
      'ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic',
      `ANTHROPIC_API_KEY=${apiKey}`,
      ...inner,
    ];
  },

  parse(events) {
    return claude.parse(events);
  },
};
