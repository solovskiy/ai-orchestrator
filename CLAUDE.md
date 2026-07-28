# .ai — Оркестратор AI-агентов

Этот репозиторий — CLI-инструмент для делегирования задач другим AI-агентам
(OpenCode, Claude Code CLI, Gemini CLI и т.д.). Используется как подмодуль или
отдельный инструмент в проектах.

## Для чего

`.ai/bin/agent` запускает агентов в фоне, сохраняя состояние на диск.
Оркестратор (Claude) не ждёт завершения — может параллельно работать дальше.

## Быстрый старт

Один вызов вместо start→wait→result. Запускать ЦЕЛИКОМ как фоновый
Bash (`run_in_background: true`) — тогда харнесс сам пришлёт уведомление
о завершении:

```bash
# capability вместо имени модели — думай задачей, не раннером.
# research/coding пока оба зашиты на бесплатную opencode/deepseek-v4-flash-free
# (временно, см. docs/workflow.md); переопределить — --model.
.ai/bin/agent delegate --task my-task --repo /path/to/project \
  --capability research --prompt "сделай ..."

.ai/bin/agent delegate --task my-task --repo /path/to/project \
  --capability coding --verify "npm test" --prompt-file tz.md
```

`delegate` сам делает start + wait + (при необходимости) один heal-ретрай +
печатает итоговый результат. jobId/session/worktree — внутренняя кухня,
их не нужно помнить руками. Нижнеуровневые `start`/`wait`/`heal` по
отдельности остаются — для случаев, когда нужно параллельно запустить
несколько задач и не блокироваться на каждой (см. `docs/workflow.md`).

## Критично (иначе тихие провалы)

- **Не звать `opencode run` напрямую** — только через `agent`, иначе
  теряются job.json, статус, стоимость и возможность продолжить сессию.
- **`delegate` — всегда одним фоновым Bash-вызовом** (`run_in_background:
  true`). Без этого харнесс не отследит процесс и не пришлёт уведомление
  о завершении — то же самое, что раньше требовало отдельного `wait`.
- **`verify: passed` ≠ задача сделана.** Всегда сверять поле `changedFiles`
  в `agent status` / `git diff --stat`: пустой дифф при `passed` = агент
  ничего не тронул.

## Структура

```
.ai/
  bin/agent              CLI (bash): delegate, start, wait, heal, ...
  lib/agent.js           работа с JSON
  lib/run-job.sh         обёртка фонового запуска (авто-коммит, verify)
  lib/diagnosis.js       классификация провалов
  lib/models.json        маппинг model→runner
  lib/runners/*.js       адаптеры: opencode, claude, gemini, codex
  lib/deploy-agent.js    JSON → opencode agent.md (YAML frontmatter)
  agents/*.json          определения агентов: model, variant, worktree,
                          permissions, systemPrompt (v3)
  plugins/               кастомные инструменты для opencode (git_commit, etc.)
  .opencode/
    agents/              деплоированные агенты (генерируется)
    plugins/             деплоированные плагины (генерируется)
    opencode.json        конфиг opencode с путём к плагинам
  capabilities/*/        (устарело, миграция в agents/)
  hooks/                 PreToolUse-хуки (напоминания о делегировании)
  test/                  юнит-тесты (diagnosis, diffStatusLines)
  scripts/               разовые обслуживающие скрипты
  jobs/<id>/             состояние задач + out.jsonl + diagnosis.json
  memory/index.json      долговременная память
```

## Полные правила делегирования

Когда что делегировать (исследование vs код), критерии, чек-лист
NEVER/ASK/ALWAYS, troubleshooting — импортируется прямо сюда:

@docs/workflow.md

Проекты-потребители подключают тот же файл через
`@D:/work/vodovorot/.ai/docs/workflow.md` в своём CLAUDE.md — не дублируя текст.

Полная документация (команды, `--verify`, написание ТЗ) — `.ai/README.md`.
