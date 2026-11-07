---
name: agent-bridge
description: Делегирование ресёрча и написания кода фоновому CLI-агенту (opencode/claude/gemini/antigravity и др.) через `agent` — без блокировки терминала, с уведомлением о завершении.
---

`agent` установлен один раз на эту машину (`agent init`) и стоит в PATH —
работает как просто `agent ...` из любой директории любого проекта.
Критерии «когда делегировать» — `{{AI_HOME}}/docs/workflow.md` (читать
точечно, когда встал вопрос делегировать или нет).

## Минимальный вызов

Один вызов вместо start→wait→heal→result. Запускать ЦЕЛИКОМ как фоновый
Bash (`run_in_background: true`) — харнесс сам пришлёт уведомление:

```bash
agent delegate general "<задача>"                      # medium (по умолчанию)
agent delegate general "<задача>" --tier light
agent delegate general --prompt-file tz.md --tier heavy --verify "npm run typecheck && npm test"
```

Рабочий агент один — `general`. «Сложность» задаёт уровень `--tier`
light|medium|heavy (модель, variant и worktree — в `lib/tiers.json`):
`light` — поиск/мелочи, `medium` — обычная работа, `heavy` — сложный
код и сам работает в своём worktree. Модель за уровнем не запоминать.

## Какой агент взять

Ростер — один `general`, сверяться **раз за сессию** (уровни и модели
могут меняться через дашборд/JSON), не хардкодить имена и модели:

```bash
agent agents               # имя / модель / worktree да-нет / инструменты + таблица уровней
agent agent show <name>    # полный JSON — description говорит, когда взять другой
```

`worktree: нет` (light/medium) — работает прямо в репо, `--repo` любая
папка. `worktree: да` (heavy) — своя ветка, `--repo` обязан быть
git-репозиторием. Нужен агент под другой MCP/исполнителя —
`agent agent create <name>`.

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
