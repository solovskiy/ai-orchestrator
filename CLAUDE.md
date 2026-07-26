# .ai — Оркестратор AI-агентов

Этот репозиторий — CLI-инструмент для делегирования задач другим AI-агентам
(OpenCode, Claude Code CLI, Gemini CLI и т.д.). Используется как подмодуль или
отдельный инструмент в проектах.

## Для чего

`.ai/bin/agent` запускает агентов в фоне, сохраняя состояние на диск.
Оркестратор (Claude) не ждёт завершения — может параллельно работать дальше.

## Быстрый старт

```bash
# 1) запустить (возвращает jobId сразу). Модель по умолчанию — бесплатная
#    opencode/deepseek-v4-flash-free; для ресёрча добавь --model deepseek/deepseek-v4-pro
.ai/bin/agent start --task my-task --repo /path/to/project --prompt "сделай ..."
# 2) ОБЯЗАТЕЛЬНО: ждать завершения — ОТДЕЛЬНЫМ Bash-вызовом с
#    run_in_background, иначе уведомление о завершении не придёт
.ai/bin/agent wait <jobId>
# 3) забрать результат
.ai/bin/agent result <jobId>
```

## Критично (иначе тихие провалы)

- **Не звать `opencode run` напрямую** — только через `agent`, иначе
  теряются job.json, статус, стоимость и возможность продолжить сессию.
- **После `start` — всегда `agent wait <jobId>` в фоне.** `start`
  отсоединён (nohup), харнесс о нём не знает; уведомление о завершении даёт
  только `wait`, запущенный оркестратором через фоновый Bash.
- **`verify: passed` ≠ задача сделана.** Всегда сверять поле `changedFiles`
  в `agent status` / `git diff --stat`: пустой дифф при `passed` = агент
  ничего не тронул.

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

## Полные правила делегирования

Когда что делегировать (исследование vs код), критерии, чек-лист
NEVER/ASK/ALWAYS, troubleshooting — импортируется прямо сюда:

@docs/workflow.md

Проекты-потребители подключают тот же файл через
`@D:/work/vodovorot/.ai/docs/workflow.md` в своём CLAUDE.md — не дублируя текст.

Полная документация (команды, `--verify`, написание ТЗ) — `.ai/README.md`.
