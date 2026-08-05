#!/usr/bin/env node
'use strict';

const path = require('path');

// Хук лежит в <AI_HOME>/hooks/ — сам вычисляет свой AI_HOME, без
// хардкода машины (переносимо между установками .ai).
const AI_HOME = path.resolve(__dirname, '..').replace(/\\/g, '/');

/**
 * PreToolUse-хук на встроенный субагент (Task/Agent).
 *
 * Ловит рефлекс: «нужно исследование / кодоген → запущу встроенного
 * субагента». Встроенный субагент работает на дорогом Claude и ест контекст
 * оркестратора — ровно то, ради ухода от чего существует `.ai/bin/agent`
 * (дешёвый DeepSeek). Проверено провалом cold-теста 2026-07-27: свежий
 * Claude в plumb_tools для ресёрча взял встроенный Task-субагент, а не .ai.
 *
 * Хук НЕ блокирует — только подмешивает напоминание. Он самофильтрующий:
 * для лёгкого чтения локального кода (Explore/Plan) явно говорит «игнорируй».
 *
 * jq на машине нет — разбираем stdin на node.
 */

let raw = '';
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  // даже если вход не разобрался — всё равно даём напоминание (не блокируя)
  const message = [
    'Запускается встроенный субагент (Task/Agent) — он работает на ДОРОГОМ',
    'Claude и ест контекст этой сессии.',
    '',
    'Если это многоисточниковое исследование или кодоген по образцу —',
    'делегируй вместо этого через дешёвый DeepSeek (один фоновый Bash-вызов,',
    'run_in_background: true — харнесс сам пришлёт уведомление о завершении):',
    `  ${AI_HOME}/bin/agent agent list   # актуальный ростер, если ещё не смотрел в этой сессии`,
    `  ${AI_HOME}/bin/agent delegate --task <slug> --repo <path> \\`,
    '    --agent <research|coding|...> --prompt "..."',
    '',
    'Если субагент нужен для чтения ЛОКАЛЬНОГО кода (Explore/Plan) или задачи,',
    'которой реально нужен Claude-уровень/история сессии — игнорируй это.',
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
