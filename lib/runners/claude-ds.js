'use strict';

const claude = require('./claude');

/**
 * Адаптер исполнителя: Claude Code CLI, направленный на DeepSeek через её
 * Anthropic-совместимый эндпоинт (https://api-docs.deepseek.com/guides/anthropic_api/).
 *
 * Тот же бинарник `claude` и тот же формат вывода (stream-json), что и у
 * раннера `claude` — buildArgs/parse переиспользуются оттуда.
 * ANTHROPIC_BASE_URL/ANTHROPIC_API_KEY задаются через `env VAR=... claude ...`
 * только для ЭТОГО запуска — общее окружение процесса не трогается.
 *
 * Модель — имя DeepSeek напрямую: `claude-ds/deepseek-v4-flash`,
 * `claude-ds/deepseek-v4-pro` (проверено живым прогоном 2026-10-22).
 *
 * Изоляция (в отличие от обычного `claude`):
 *   --bare               не грузит хуки, плагины, автопамять и CLAUDE.md
 *                        пользователя (там правило «делегируй через agent» —
 *                        без этого агент начал бы плодить агентов), авторизация
 *                        строго через ANTHROPIC_API_KEY;
 *   --strict-mcp-config  без MCP-серверов пользователя (ssh к проду и т.п.).
 *
 * Доллары не считаем: total_cost_usd Claude Code считает по прайсу Anthropic,
 * к реальной цене DeepSeek он отношения не имеет. Только токены.
 *
 * Требует DEEPSEEK_API_KEY в окружении (ключ DeepSeek, НЕ Anthropic).
 */
module.exports = {
  name: 'claude-ds',

  capabilities: { ...claude.capabilities, cost: false },

  buildArgs(job, prompt) {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) {
      throw new Error('claude-ds: не задан DEEPSEEK_API_KEY в окружении (нужен ключ DeepSeek, не Anthropic)');
    }

    const inner = claude.buildArgs(job, prompt, ['--bare', '--strict-mcp-config']);
    return [
      'env',
      'ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic',
      `ANTHROPIC_API_KEY=${apiKey}`,
      // Claude Code не знает модели DeepSeek и берёт запасной потолок ответа
      // 32000; у самого API он 384K. 64000 хватает на крупный файл за один ход.
      'CLAUDE_CODE_MAX_OUTPUT_TOKENS=64000',
      ...inner,
    ];
  },

  parse(events) {
    return { ...claude.parse(events), cost: null };
  },
};
