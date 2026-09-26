---
name: agent-bridge
description: Делегирование ресёрча и написания кода фоновому CLI-агенту (opencode/claude/gemini) через `agent` — без блокировки терминала, с уведомлением о завершении.
---

`agent` установлен один раз на эту машину (`agent init`) и стоит в PATH —
работает как просто `agent ...` из любой директории любого проекта.
Критерии «когда делегировать» — `{{AI_HOME}}/docs/workflow.md` (читать
точечно, когда встал вопрос делегировать или нет).

## Минимальный вызов

Один вызов вместо start→wait→heal→result. Запускать ЦЕЛИКОМ как фоновый
Bash (`run_in_background: true`) — харнесс сам пришлёт уведомление:

```bash
agent delegate <агент> "<задача>"
agent delegate <агент> "<задача>" --verify "npm test"
agent delegate <агент> --prompt-file tz.md --verify "npm run typecheck && npm test"
```

`<агент>` несёт модель/worktree/permissions/systemPrompt из
`agents/<агент>.json` — руками их не подбирать.

## Какой агент взять

Ростер растёт — сверяться **раз за сессию**, не хардкодить имена:

```bash
agent agents               # имя / модель / worktree да-нет / инструменты
agent agent show <name>    # полный JSON — description говорит, когда взять другой
```

`worktree: нет` — только читает/пишет отчёт, `--repo` любая папка.
`worktree: да` — коммитит в свою ветку, `--repo` обязан быть
git-репозиторием. Нет подходящего агента — `agent agent create <name>`.

## После worktree-задачи: accept / discard

`delegate` для worktree-агента заканчивается либо авто-уборкой (если
изменений нет), либо строкой вида:

```
ветка agent/foo-a1b2: 2 коммит(ов), 3 файл(ов), verify: passed → agent accept <jobId>  |  agent discard <jobId>
```

`agent accept <jobId>` — squash-мердж ветки в текущую ветку и удаление
worktree/ветки. `agent discard <jobId>` — удалить ветку/worktree без
мерджа. Без одной из двух команд ветки остаются висеть.

**`verify: passed` ≠ сделано** — сверяй `changedFiles` в
`agent status <jobId>`: пустой дифф при `passed` значит, что агент
ничего не тронул.

## Параллельные задачи

```bash
agent start <агент> "<задача1>"
agent start <агент> "<задача2>"
agent wait <jobId1> <jobId2>     # ОТДЕЛЬНЫМ фоновым Bash (run_in_background: true)
```

Без фонового `wait` уведомление не придёт — `start` отсоединён (`nohup`).

Если `agent: command not found` — PATH шелла не подхватил `~/bin`,
используй `{{AI_HOME}}/bin/agent` тем же синтаксисом.

Полный список команд — `agent help --all`. Гочпчи системных промптов и
расширенные критерии делегирования — `{{AI_HOME}}/docs/workflow.md`.
