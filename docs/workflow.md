# Делегирование агентам — когда и как

Канонический документ. Базовая механика делегирования (`agent agent list`,
`delegate`, обработка ошибок) уже доступна из любого проекта без правки
CLAUDE.md — глобально устанавливается один раз через `bin/agent init`
(см. `README.md`, «Установка»). Этот файл — расширенные критерии
(NEVER/ASK/ALWAYS) для проектов, где хочется держать их в контексте
каждой сессии: опционально подключить строкой `@<путь-к-.ai>/docs/workflow.md`
в `CLAUDE.md` проекта-потребителя (не копировать текст, только ссылка;
`<путь-к-.ai>` — куда склонирован этот репозиторий на конкретной машине;
источник рекомендации — официальная рекомендация Anthropic, CLAUDE.md
< 200 строк, общие правила выносить и импортировать).

Механика команд, `--verify`, чек-лист написания ТЗ — в `README.md` этого
репозитория. Здесь — только **когда** и **что** делегировать.

## Что это технически

Один механизм на все категории задач — `agent delegate <агент> "<задача>"`,
который внутри вызывает `start`+`wait`+(при необходимости) `heal` и
запускает исполнителя агента в фоне.

**Рабочий агент один — `general`, а «сложность» выбирается уровнем
`--tier`.** Уровень отвечает только на вопрос «насколько сильную модель
взять»; роли «ресёрчер» и «кодер» отдельными агентами больше не нужны:

| Уровень | Когда брать | Что под ним (`lib/tiers.json`) | worktree |
|---|---|---|---|
| `light` | поиск, сбор фактов, мелкие правки, обход файлов | быстрая дешёвая модель, `variant: low` | нет |
| `medium` (по умолчанию) | обычная работа: разобраться в модуле, написать функцию, ресёрч, доки | сильная модель, `variant: medium` | нет |
| `heavy` | сложный код, трудный баг, многофайловая реализация | сильная модель, `variant: high` | **да** — своя ветка, потом `agent accept`/`discard` |

```bash
agent delegate general "найди, где считается скидка"            --repo <path>              # medium
agent delegate general "собери список эндпоинтов"   --tier light --repo <path>
agent delegate general --prompt-file tz.md --tier heavy --verify "npm test" --repo <path>
```

Какая именно модель за уровнем — **не запоминать**: она записана в одном
месте, `lib/tiers.json`, и показывается в `agent agents`. Нужен worktree на
другом уровне — добавь `--worktree` (явные флаги приоритетнее уровня).
Без `--tier` берётся `defaultTier` (`medium`). Для `heavy`/`--worktree`
`--repo` обязан быть git-репозиторием. Лимита шагов у `general` нет;
`delegate` ждёт по умолчанию 1800 с (`--timeout`) — по истечении он
просто перестаёт ждать, сама задача продолжает идти (`agent status`).

Остальные агенты остаются там, где нужны свои MCP-серверы или другой
исполнитель: `browser` (настоящий браузер), `testing` (agent-browser).
`research`, `coding`, `copywriter` — прежние специализированные
агенты, пока не удалены (по ним могут быть незакрытые задачи и сессии),
но для новых задач их не выбирай: бери `general` с нужным уровнем.
У агентов без уровней `--tier` не принимается.

Имя агента подставляет модель/worktree/permissions/systemPrompt по
умолчанию из `agents/<name>.json` — не нужно помнить конкретное имя
модели. Нет подходящего агента — `agent agent create <name>` (новый JSON
в `agents/`, отредактировать под задачу), не подгонять описание под
существующий.

## Машинный итог: `--json`

`agent delegate ... --json` и `agent status <jobId> --json` вместо текста печатают
**одну JSON-строку** — по ней решай, что делать дальше, а не по тексту:

```json
{"ok":true,"done":true,"jobId":"...","status":"completed","errorCode":null,
 "result":"<текст result.md>","tier":"medium","model":"...","tokens":{...},
 "changedFiles":1,"warnings":[],"worktree":null,"chain":["..."]}
```

Код выхода: **0** — ok · **1** — ошибка · **2** — `delegate` перестал ждать, задача идёт.
Решай по `errorCode` (стабильные коды):

| `errorCode` | Что значит | Что делать |
|---|---|---|
| `null` | всё хорошо (при `done:false` — задача ещё идёт) | брать `result` |
| `WAIT_TIMEOUT` | `--timeout` вышел, задача продолжает работать | `agent status <jobId> --json` позже; не запускать повторно |
| `START_FAILED` | не стартовало (нет агента, неверный `--tier`, не git-репо для worktree) | исправить вызов, `errorMsg` скажет что |
| `VERIFY_FAILED` | агент отработал, но `--verify` красный (авто-ретраи уже были) | читать `verify`, `agent send` с поправкой |
| `PERMISSION_REJECTED` | агент полез за пределы `--repo` | дать ему нужные файлы внутри репо или сузить задачу |
| `VALIDATION_ERROR` / `ABANDONED` / `NO_EVENTS` / `RUNNER_ERROR` | сбой исполнителя | один повтор (`agent send` в ту же сессию), потом смена `--tier` или остановка |
| `RUNNER_FAILED` / `JOB_KILLED` | процесс упал / задачу убили | `errorMsg`; убитую не перезапускать без решения пользователя |

Для worktree-задач в `worktree` лежат `pending`, `commits` и готовые команды
`accept`/`discard` — `pending: true` значит ветка ждёт твоего решения.
`warnings` не меняет `ok`, но `not_autocommitted` и `no_changes` читать обязательно
(`verify: passed` при `changedFiles: 0` — агент ничего не тронул).

## Когда делегировать исследование

Критерий — **объём, а не тема**:

| Ситуация | Как делать |
|---|---|
| Заглянуть в 1–2 страницы, найти конкретный факт | `WebFetch` самому — так быстрее |
| Разобрать чужой API, обойти несколько источников, собрать отчёт | **делегировать**, отчёт — в Markdown-файл |

Признак, что пора делегировать: собираешься сделать больше 2–3 `WebFetch`
подряд, или результат тянет на отдельный документ. В сессии на это есть
автоматическое напоминание — `hooks/research-delegation-reminder.js`
(PreToolUse-хук на `WebFetch`/`WebSearch`, считает вызовы подряд, на 3-м
подмешивает напоминание в контекст; не блокирует).

Web-источники или трассировка кода/архитектуры в локальном репозитории —
один и тот же агент `general` (описывай предметную область прямо в
задаче), та же логика «3+ источника/файла — делегировать», просто
предметная область разная. Задачи внутри настоящего браузера (сбор данных с сайтов,
где нужна авторизованная сессия/клики/скриншоты, а не просто HTTP-запрос)
→ агент `browser` — работает через MCP browser-bot (Real Browser MCP,
порт 9333, расширение в отдельном Chrome-профиле бота); перед первым
использованием на новой машине нужна разовая ручная настройка профиля
(`.ai/scripts/browser-preflight.ps1` поднимает профиль и освобождает
порт, но установка расширения и логин на сайтах — руками).

Проверка своего/локального dev-сервера (поднять, открыть в браузере,
снять скриншот/accessibility-snapshot, отчитаться) → агент `testing` —
работает через MCP `agent-browser` (vercel-labs/agent-browser, свой
Chrome-профиль/daemon через CDP, не пересекается с профилем `browser`).
Отдельный от `browser` MCP и агент осознанно: `browser` — авторизованные
сессии на реальных сайтах, `testing` — dev-сервер/фронтенд-ревью текущего
проекта. Требует разовой установки самого MCP-сервера на машине
(`npm install -g agent-browser && agent-browser install`) — это не
делает `.ai`, нужно руками до первого использования.

Модель у `testing` должна уметь смотреть на изображения (скриншоты) —
проверь `agent agent show testing`, дефолт может быть плейсхолдером,
если модель ещё не подобрана.

Модель берётся из `agents/<name>.json` — она настроена пользователем через
UI и отражает актуальный выбор, доверяй ей, не переопределяй `--model`
самостоятельно (см. NEVER/ASK/ALWAYS ниже). Если задача упирается в
rate-limit бесплатного тира (симптом: `abandoned`/`validation_error`,
0 изменённых файлов, `agent status` показывает "0 из N шагов вернулись с
0 токенов") — не переключай модель сам, спроси пользователя, разово
переопределить модель (`--model`, недокументированный алиас) для этой
конкретной задачи или подождать/повторить.

## Когда делегировать код

- Генерация по образцу: CRUD, UI-компонент по паттерну, схема, сиды —
  задача, где решение уже понятно, нужно только напечатать.
- НЕ делегировать: архитектурные решения, пересечение границ модулей,
  задачи, требующие знания истории текущей сессии, правку в 1–2 файлах
  с очевидным фиксом (оверхед делегирования больше пользы).
- Код — `general`: мелкая механическая правка — `--tier light`/`medium`,
  полноценная реализация в нескольких файлах — `--tier heavy`. Текстовый
  контент (описания товаров, лендинги, переводы RU/UA — не код) тоже
  `general`, обычно `medium`.
- Модель — дефолт из `agents/<name>.json`, достаточно имени агента,
  `--model` не нужен. Какая именно модель сейчас настроена — не
  запоминать (меняется через дашборд/JSON независимо от этого файла),
  смотреть `agent agent show <name>`. Переопределять модель вручную —
  только по сигналу (rate-limit дефолта, или цена ошибки задачи высокая:
  деньги/Decimal, точное повторение сложного паттерна — тогда более
  дорогая модель), не «на всякий случай».

## Writing agent system prompts — practical gotchas

Discovered during the `testing` agent development but applicable to ANY
MCP-using agent. These are NOT specific to `testing` — every new agent that
uses an MCP server should follow them.

### 1. MCP tool names double the server prefix

opencode exposes MCP tools as `<server>_<tool>`. For `agent-browser`, that's
`agent-browser_agent_browser_open` — NOT the plausible-but-wrong shortened
form `agent-browser_navigate`. The model hallucinates credible but incorrect
names unless the prompt lists them literally. Always list the actual tool
names in the system prompt for any MCP server — the model's own guess will
be wrong.

Rule: if an agent uses `"mcp": ["<server>"]`, the system prompt MUST include
the actual tool names (check the deployed agent's available tools list after
deploy, or call a diagnostic tool first to see what's available). Never
rely on the model to infer naming conventions.

### 2. Background server launch: `&` is not enough — redirect stdout/stderr

`command &` alone (without `> file 2>&1`) hangs the bash tool forever: the
spawned server process inherits open pipes from the bash invocation and
keeps them open indefinitely (the server never exits), so the caller blocks
on `read()` waiting for EOF that never comes. This is the single most common
cause of hangs in `testing` agent tasks.

Always use `nohup <command> > file.log 2>&1 &` in system prompts for any
agent that needs to start a background server. Log files go inside the
repository, not `/tmp` (see below).

### 3. All paths — relative only; sandbox rejects absolute paths silently

The opencode sandbox rejects absolute paths outside the repository root with
"user rejected permission" — this is a rejection, not a permission prompt;
repeating it won't change the outcome. Never use `workdir` in bash calls
(the working directory is already correct), never construct absolute paths
to another checkout, and place temporary files (server logs, screenshots)
inside the repository (e.g. `server.log`, `ai-research/...`), not `/tmp`
or `C:/Users/...`.

## NEVER / ASK / ALWAYS (общее для всех проектов)

**NEVER**
- Вызывать `opencode run` напрямую в обход `agent` — потеряются job.json,
  статус, стоимость, возможность продолжить сессию.
- Делать многоисточниковое исследование самому через `WebFetch`/`WebSearch`
  вместо делегирования (см. критерий выше).
- Ссылаться в ТЗ на файл, которого ещё нет в `master` (например, черновик
  из другой рабочей копии) — worktree агента ветвится от git-истории, не
  копирует чужую рабочую директорию; ссылка на незакоммиченный файл
  провалится молча.
- Коммитить сгенерированный код без прогона тестов/typecheck через
  `--verify`.

**ALWAYS**
- Вызывать просто `agent ...` — после `bin/agent init` он стоит в PATH
  (`~/bin/agent`), абсолютный путь не нужен. Если PATH этого шелла его не
  подхватил (`agent: command not found`) — используй `<AI_HOME>/bin/agent`
  тем же синтаксисом, `<AI_HOME>` — куда склонирован этот репозиторий.
- Одна задача = одна worktree-ветка для кодовых задач — `agent` сам
  генерирует уникальное имя ветки/worktree (`agent/<task>-<id>`), задавать
  `--branch`/`--worktree` руками не нужно.
- Тесты — только через `--verify`, не отдельным вызовом: вывод оседает в
  `verify.log`, в контекст сессии попадает только вердикт.
- `--verify` гоняет отдельный bash-скрипт (`run-job.sh`) ПОСЛЕ завершения
  агента, а не сам агент — красный `verify` не откатывается и не
  блокируется автоматически. `delegate` теперь сам продолжает ТУ ЖЕ
  сессию агента (передаёт хвост `verify.log`) при `verifyStatus: failed`,
  до `--max-verify-retries` раз (по умолч. 2, `--no-heal` отключает и это
  тоже) — это отдельный механизм от heal по `diagnosis.outcome`
  (validation_error/abandoned), тот чинит сбой самого агента, этот —
  красные тесты после штатного завершения. Всё равно проверяй финальный
  `verifyStatus`/`changedFiles` — лимит попыток существует специально на
  случай, если агент не может починить проверку.
- В ТЗ явно писать: пути относительные (не строить самому абсолютный путь
  к ОСНОВНОМУ чекауту — модель иногда его выдумывает, и песочница тихо
  отклоняет обращение); не сдаваться молча на первой ошибке чтения файла;
  всегда завершать текстовым резюме.
- После `verify: passed` — проверять `git diff --stat` в worktree, а не
  только статус. Пустой дифф при `passed` значит, что тесты прогонялись
  на неизменённом коде — агент ничего не сделал (проверено дважды на
  erp_core 2026-07-26). С этого захода `agent status` сам подсвечивает
  это предупреждение (поле `changedFiles`).
- Для worktree-задач — проверять `autoCommitted` в `agent status`:
  если `false`, в worktree могли остаться незакоммиченные изменения
  (модель забыла `git commit`). Обёртка `run-job.sh` коммитит сама
  (см. README.md, «Авто-коммит в worktree»), но проверить вручную не
  помешает.
- Не продолжать одну и ту же сессию (`agent send`) из двух мест
  параллельно — гонка записи истории сессии на диске. `agent send`
  сам это проверяет и откажет, если сессия уже занята задачей в
  статусе `running`.
- Worktree-задачу нужно закрыть — `agent accept <jobId>` (squash-мердж в
  текущую ветку репозитория) или `agent discard <jobId>` (выбросить).
  `delegate` печатает готовую команду в конце (или сам убирает пустую
  задачу, если агент ничего не сделал) — см. README.md, «Ветки: accept /
  discard / gc».

## Уведомление о завершении (ОБЯЗАТЕЛЬНО)

`agent start` запускает задачу отсоединённо (`nohup`) — она переживает
закрытие сессии, но харнесс Claude Code о ней **не знает** и уведомление
о завершении сам не пришлёт. Пуш-уведомление (`<task-notification>`)
харнесс присылает только для процессов, которые запустил он сам — то есть
`Bash` с `run_in_background`.

Поэтому правило: **`agent delegate` целиком запускать как фоновый
`Bash`-вызов (`run_in_background: true`)**:

```bash
agent delegate general --tier medium --repo <path> --prompt-file <ТЗ.md>
```

`delegate` внутри сам делает start → wait → (если нужно) heal → печатает
результат — это один процесс, харнесс отслеживает его целиком и
пришлёт уведомление, когда он завершится. Отсоединённая работа
(`opencode`) при этом всё равно переживает закрытие сессии — durability
не теряется, просто теперь не нужно помнить про промежуточный jobId.

Нижний уровень остаётся доступен напрямую — пригождается, когда нужно
запустить несколько задач параллельно, не блокируясь на каждой поодиночке:

```bash
# 1) старт (обычный Bash-вызов, возвращает jobId сразу)
agent start general --tier heavy --repo <path> --prompt-file <ТЗ.md>
# 2) ожидание — ОТДЕЛЬНЫМ Bash-вызовом с run_in_background: true
agent wait <jobId1> <jobId2> ...
```

`agent wait` принимает несколько jobId (ждёт все — для параллельных
задач) и `--timeout <сек>` (по умолчанию 1800, у `delegate` то же самое
через `--timeout`): при таймауте выходит с кодом 2 и всё равно триггерит
уведомление, чтобы задача не «потерялась».

**В начале новой сессии**, если продолжаешь работу с `.ai`, — `agent list`:
поймать задачи, что завершились, пока за ними никто не следил (уведомление
живёт только внутри той сессии, где запущен `wait`).

## Если задача застряла

- `agent tail <jobId>` — что агент уже успел написать (парсит `out.jsonl`,
  который пишется потоково, не одним куском в конце).
- `jobs/<id>/out.jsonl` / `stderr.log` — обычные файлы, можно `tail -f`
  напрямую для realtime.
- `job.json` → `pid` — жив ли процесс.
- Разрешений `opencode` спрашивать не должен: headless-режим (`opencode
  run` без TTY, как у нас под `nohup`) по умолчанию не подсовывает
  интерактивный диалог подтверждения (проверено — 9/9 прогонов через `.ai`
  реально писали файлы/ходили в сеть без `--auto`). Настоящий признак
  зависания — не «ждёт разрешения», а **`out.jsonl`/`stderr.log` перестали
  расти** намного дольше разумного времени на задачу при живом `pid`.
  Это специфика `opencode` — раннер `antigravity` (`agy`) ведёт себя
  противоположно: без `--dangerously-skip-permissions` он не зависает,
  но молча auto-denies каждый tool-вызов (см. `lib/runners/antigravity.js`),
  поэтому этот флаг там прошит всегда, а не опционален.
- В этом случае: `agent kill <jobId>`, затем `agent delegate` заново (с
  уточнённым промптом, если причина была логическая, а не сетевой сбой).

## Модели: где что

Обычно модель выбирать не нужно — возьми подходящий агент из
`agent agents` (см. `README.md`, раздел «Capability / Agent»), он уже
несёт в себе и модель, и worktree. Явный `--model` (недокументированный
алиас) нужен только для переопределения, и только той же модели/провайдера,
что и у агента, — иначе `delegate` откажет ещё до запуска (см. примеры
ресёрча и кода выше).

Полная таблица префикс→раннер — в `README.md` (раздел «Мультимодельность»).
Кратко: `opencode/*` и `deepseek/*` и `openai/*` и `anthropic/*` → opencode; `claude/*` →
Claude Code CLI; `claude-ds/*` → тот же Claude Code CLI, но через DeepSeek
(нужен `DEEPSEEK_API_KEY`, модель вида `claude-ds/deepseek-v4-flash`, проверен
2026-10-22); `gemini/*` → Gemini CLI; `antigravity/*`/`agy/*` →
Google Antigravity CLI (`agy`). Помимо opencode, на реальных задачах в
headless-режиме подтверждены antigravity (2026-09-26) и claude-ds (2026-10-22).

Дефолт (если ни модель агента, ни `--model` не заданы) —
`opencode/deepseek-v4-flash-free` ($0, OpenCode Zen, без логина). Платные
варианты — только по явному `--model`: `deepseek/deepseek-v4-flash`
(стабильнее free), `deepseek/deepseek-v4-pro` (ресёрч). Проверить
провайдеры/модели: `opencode models`, `opencode providers list`.
