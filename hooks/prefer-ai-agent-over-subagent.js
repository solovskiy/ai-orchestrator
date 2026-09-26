#!/usr/bin/env node
'use strict';

/**
 * PreToolUse-хук на встроенный субагент (Task/Agent).
 *
 * Ловит рефлекс: «нужно исследование / кодоген → запущу встроенного
 * субагента». Встроенный субагент работает на дорогом Claude и ест контекст
 * оркестратора — ровно то, ради ухода от чего существует `agent`. Хук НЕ
 * блокирует — только подмешивает напоминание.
 *
 * jq на машине нет — разбираем stdin на node.
 */

let raw = '';
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  const message = [
    'Встроенный субагент работает на дорогом Claude и ест контекст сессии.',
    'Многоисточниковое исследование/кодоген по образцу — делегируй через',
    '`agent` (один фоновый Bash, run_in_background: true):',
    '  agent agents   # ростер, если ещё не смотрел в этой сессии',
    '  agent delegate <research|coding|...> "<задача>"',
    'Чтение ЛОКАЛЬНОГО кода (Explore/Plan) — игнорируй это напоминание.',
  ].join('\n');

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: message,
      },
    }),
  );
  process.exit(0);
});
