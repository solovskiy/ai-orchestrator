# .ai — Оркестратор AI-агентов

Этот репозиторий — CLI-инструмент для делегирования задач другим AI-агентам
(OpenCode, Claude Code CLI, Gemini CLI и т.д.). Используется как подмодуль или
отдельный инструмент в проектах.

## Для чего

`.ai/bin/agent` запускает агентов в фоне, сохраняя состояние на диск.
Оркестратор (Claude) не ждёт завершения — может параллельно работать дальше.

## Быстрый старт

```bash
.ai/bin/agent start --task my-task --repo /path/to/project \
  --model deepseek/deepseek-v4-pro \
  --prompt "сделай ..."
.ai/bin/agent list
.ai/bin/agent result <jobId>
```

## Структура

```
.ai/
  bin/agent           CLI (bash)
  lib/agent.js        работа с JSON
  lib/run-job.sh      обёртка фонового запуска
  lib/runners/*.js    адаптеры: opencode, claude, gemini, codex
  lib/models.json     маппинг model→runner
  jobs/<id>/          состояние задач
  memory/index.json   долговременная память
```

Полная документация — `.ai/README.md`.
