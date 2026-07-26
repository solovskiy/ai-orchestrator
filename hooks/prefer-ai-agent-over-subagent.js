#!/usr/bin/env node
'use strict';

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
    'делегируй вместо этого через дешёвый DeepSeek:',
    '  D:/work/vodovorot/.ai/bin/agent start --task <slug> --repo <path> \\',
    '    [--model deepseek/deepseek-v4-pro для ресёрча] --prompt "..."',
    '  D:/work/vodovorot/.ai/bin/agent wait <jobId>   # отдельным фоновым Bash!',
    '  D:/work/vodovorot/.ai/bin/agent result <jobId>',
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
