---
name: agent-bridge
description: Делегирование ресёрча и написания кода фоновому CLI-агенту (opencode/claude/gemini) через .ai/bin/agent — без блокировки терминала, с уведомлением о завершении.
---

Инструмент живёт в `.ai/` этого проекта (bash CLI `.ai/bin/agent` + Node
внутри). Полные правила «когда делегировать» — `.ai/docs/workflow.md`
(NEVER/ASK/ALWAYS, критерии ресёрч vs код). Здесь — только механика вызова.

## Рекомендуемый вход: delegate

`delegate` делает start → wait → (при необходимости) heal → печатает
результат одним вызовом. Запускать **целиком через фоновый Bash**
(`run_in_background: true`) — так харнесс пришлёт уведомление о завершении.

```bash
# Исследование (без worktree):
.ai/bin/agent delegate --task <slug> --repo <path> \
  --capability research --prompt "изучи X, сохрани отчёт в <файл>.md"

# Код (с worktree и проверкой):
.ai/bin/agent delegate --task <slug> --repo <path> \
  --capability coding --verify "npm test" --prompt-file <ТЗ.md>
```

`--capability` подставляет модель и worktree из `capabilities/<name>/capability.json`.
Явные `--model`/`--worktree` переопределяют capability.

Флаги delegate:
- `--timeout <сек>` — таймаут ожидания (по умолч. 1800)
- `--no-heal` — не пытаться авто-восстановить при провале

После `verify: passed` всегда сверять `changedFiles` в `agent status` —
пустой дифф при passed значит, что агент ничего не менял. Для worktree-задач
проверять `autoCommitted` — если `false`, в worktree могли остаться
незакоммиченные изменения.

## Нижний уровень: start + wait (для параллельных задач)

Если нужно запустить несколько задач параллельно и не блокироваться на каждой:

```bash
# 1) старт нескольких задач (обычный Bash-вызов, возвращает jobId сразу)
.ai/bin/agent start --task <slug1> --repo <path> --capability coding --prompt-file tz1.md
.ai/bin/agent start --task <slug2> --repo <path> --capability coding --prompt-file tz2.md

# 2) ожидание всех — ОТДЕЛЬНЫМ Bash с run_in_background: true
.ai/bin/agent wait <jobId1> <jobId2>

# 3) результат каждой после уведомления
.ai/bin/agent result <jobId1>
```

Без фонового `wait` уведомление о завершении не придёт — `start` отсоединён
(`nohup`), харнесс о нём не знает.

## Продолжить сессию новой репликой

```bash
.ai/bin/agent send <jobId> "новые вводные"   # новая задача (свой jobId/wait), тот же sessionId
```

Единственный способ достучаться до диалога — headless-режим не блокируется
в ожидании ответа посреди задачи (см. `.ai/docs/workflow.md` → «Если задача
застряла»): агент либо решает вопрос сам по своему суждению и помечает это
в финальном тексте, либо не завершает работу вовсе. Если по `tail`/`result`
видно открытый вопрос — отвечай через `send`, не жди «живого» диалога.

## Восстановление проваленной задачи

```bash
.ai/bin/agent heal <jobId>   # retry для validation_error / abandoned
```

`heal` читает `diagnosis.json` и отправляет структурированное сообщение
в ту же сессию. `delegate` делает это автоматически (если не `--no-heal`).
Повторный heal той же задачи откажет — защита от бесконечного цикла.

## Интерактивный чат (foreground)

```bash
.ai/bin/agent chat --task <slug> --repo <path> --model opencode/deepseek-v4-chat
```

Блокирующий интерактивный режим — для тестирования модели «вживую». Не для
фоновой работы: результат не сохраняется в jobs/, сессия не продолжается
через `send`. Поддерживает тех же исполнителей, что и `start` (opencode,
claude, gemini).

## Если задача застряла

`.ai/bin/agent tail <jobId>` — что агент уже написал (стримится в
`out.jsonl`, не одним куском в конце). Признак реального зависания — не
«ждёт подтверждения» (headless-режим их не спрашивает), а лог не растёт
намного дольше разумного при живом `pid`. Тогда `agent kill <jobId>` и
перезапуск с уточнённым промптом.

Полный список команд: `.ai/bin/agent --help`.
