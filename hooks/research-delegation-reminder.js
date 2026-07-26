#!/usr/bin/env node
'use strict';

/**
 * PreToolUse-хук на WebFetch/WebSearch.
 *
 * Реализует критерий из CLAUDE.md: «обсяг, а не тема». Одиночный запрос за
 * конкретным фактом — нормально и не трогается. Но если пошёл третий подряд,
 * это уже многоисточниковое исследование, которое должно уходить агенту.
 *
 * Хук НЕ блокирует вызов — только подмешивает напоминание в контекст модели.
 * Блокировка тут была бы вредна: правило про объём, а по одному вызову
 * объём не определить.
 *
 * jq на машине нет, поэтому разбор входного JSON — на node.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const THRESHOLD = 3; // с какого вызова подряд напоминать
const WINDOW_MS = 30 * 60 * 1000; // пауза, после которой счётчик обнуляется

let raw = '';
process.stdin.on('data', (chunk) => {
  raw += chunk;
});

process.stdin.on('end', () => {
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    process.exit(0); // не смогли разобрать — молча пропускаем
  }

  const sessionId = String(input.session_id || 'unknown').replace(/[^A-Za-z0-9_-]/g, '');
  const stateFile = path.join(os.tmpdir(), `claude-research-count-${sessionId}.json`);
  const now = Date.now();

  let state = { count: 0, last: 0 };
  try {
    state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {
    /* первый вызов в сессии */
  }

  // Длинная пауза = новый заход, а не продолжение обхода источников
  if (now - (state.last || 0) > WINDOW_MS) state.count = 0;

  state.count += 1;
  state.last = now;
  try {
    fs.writeFileSync(stateFile, JSON.stringify(state));
  } catch {
    /* счётчик — вещь необязательная, падать из-за него не будем */
  }

  if (state.count < THRESHOLD) process.exit(0);

  const message = [
    `Это ${state.count}-й веб-запрос подряд в этой сессии.`,
    '',
    'Правило проекта (CLAUDE.md): многоисточниковое исследование — разбор чужого',
    'API, анализ рынка, сравнение решений — делегируется, а не делается вручную.',
    'Сырой вывод съедает контекст, который нужен на саму задачу.',
    '',
    'Если идёт именно такое исследование — прекрати ручной обход и запусти:',
    '  D:/work/vodovorot/.ai/bin/agent start --task <slug> --repo <путь> \\',
    '    --prompt "<что изучить; сохрани отчёт в <файл>.md>"',
    'Потом забери результат: agent result <jobId>.',
    '',
    'Если нужен ещё один точечный факт — продолжай, это правилу не противоречит.',
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
