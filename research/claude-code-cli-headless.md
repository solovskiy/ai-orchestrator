# Claude Code CLI: интеграция в оркестратор `.ai/bin/agent`

**Дата исследования:** 2026-08-01
**Актуальная стабильная версия:** 2.1.220 (последняя запись в CHANGELOG `anthropics/claude-code`)
**Источники:** официальная документация Anthropic (code.claude.com/docs), CHANGELOG и README репозитория `anthropics/claude-code`, документация Claude Agent SDK. Сторонние блоги не использовались.

---

## Summary (коротко)

1. **Headless-режим есть** — это флаг `-p` / `--print` («Query via SDK, then exit»), полный аналог `opencode run`. Работает без TTY, читает stdin. Для детерминированных CI-запусков есть `--bare` (пропускает авто-загрузку CLAUDE.md/hooks/plugins/MCP) — Anthropic объявила, что `--bare` станет дефолтом для `-p` в будущем релизе.
2. **Промпт передаётся** аргументом (`claude -p "query"`), через stdin (`cat file | claude -p "..."`) или потоково через `--input-format stream-json` (JSONL-сообщения). Без промпта и без stdin `-p` падает с ошибкой CLI.
3. **Структурированный вывод** — `--output-format json` (один JSON: `result`, `session_id`, `usage`, `total_cost_usd`, `modelUsage`) или `--output-format stream-json` (NDJSON-события, последняя строка — `result`). Дополнительно `--json-schema` даёт валидированный JSON в поле `structured_output`.
4. **Auto-approve** — `--allowedTools` (правила-паттерны) и `--permission-mode` (`acceptEdits`, `plan`, `auto`, `dontAsk`, `bypassPermissions`). Для lock-down CI рекомендуется `dontAsk` (всё не-разрешённое автоматически запрещается, сессия никогда не ждёт ввода). `--dangerously-skip-permissions` ≡ `--permission-mode bypassPermissions`. В `-p` режиме, если нужно разрешение, а диалога нет — прогон абортится (или выходит с кодом 1, см. п.7).
5. **Resume сессии есть** — `--resume <session_id>` / `-r` (по ID или имени) и `--continue` / `-c` (последняя сессия в директории). session_id берётся из JSON-вывода. Важно: поиск сессии scoped к директории проекта — резюмировать надо из той же директории. Не восстанавливаются: `--mcp-config`, `--settings`, `--plugin-dir`, `--add-dir` (передавать заново).
6. **Документация**: официальные страницы — `headless.md`, `cli-reference.md`, `agent-sdk/*` (SDK переименован: Claude Code SDK → **Claude Agent SDK**, Python/TypeScript только; для других языков Anthropic прямо рекомендует запускать CLI как subprocess — наш случай). Готовые интеграции: GitHub Action `anthropics/claude-code-action@v1`, отдельная страница GitLab CI/CD.
7. **Exit codes**: полной официальной таблицы нет. Документированы: `0` успех, `1` — ряд CLI-ошибок (невалидный `--json-schema`, settings > 2 MiB, failed resume, не найденный `--permission-prompt-tool`), `143` — SIGTERM в `-p`-режиме, `137` — SIGKILL/OOM (установка). Стоимость: `total_cost_usd` + `usage` (токены, вкл. cache) в result-сообщении — это **client-side оценка**, не авторитетный биллинг.
8. **Депрекации**: npm-установка deprecated (переход на нативные бинарники), `--enable-auto-mode` удалён в 2.1.111 (→ `--permission-mode auto`), `CLAUDE_CODE_ENABLE_AUTO_MODE` не нужен с 2.1.207, Task tool `mode` deprecated (2.1.212), `TeamCreate`/`TeamDelete` удалены, GitHub Action beta → v1 (breaking), SDK v0.1.0 (breaking, переименование), stdin cap 10 MB, docs переехали с docs.claude.com на code.claude.com.

---

## 1. Headless / неинтерактивный режим

**Да, есть.** Флаг `-p` / `--print` — «Query via SDK, then exit». Все остальные CLI-флаги работают в комбинации с `-p`.

```bash
claude -p "Find and fix the bug in auth.py" --allowedTools "Read,Edit,Bash"
```

Ключевые флаги (полный список — [CLI reference](https://code.claude.com/docs/en/cli-reference), [Headless](https://code.claude.com/docs/en/headless)):

| Флаг | Назначение |
|---|---|
| `-p`, `--print` | Неинтерактивный режим: выполнить и выйти |
| `--bare` | Пропуск авто-дискавери (hooks, skills, plugins, MCP, auto memory, CLAUDE.md) — быстрый старт, детерминизм для CI. **Аннонсирован дефолтом для `-p` в будущем релизе** |
| `--output-format` | `text` (дефолт), `json`, `stream-json` |
| `--input-format` | `text`, `stream-json` (JSONL на stdin) |
| `--verbose` | Полный пошаговый вывод (нужен для stream-json с partial-событиями) |
| `--include-partial-messages` | Стримить частичные ответы (требует `--print` + `--output-format stream-json`) |
| `--include-hook-events` | Hook lifecycle-события в потоке (требует stream-json) |
| `--forward-subagent-text` | Текст/thinking сабагентов в потоке (v2.1.211+; требует stream-json) |
| `--max-turns N` | Лимит агентных ходов (только print mode; при достижении — ошибка) |
| `--json-schema '...'` | Валидированный JSON-вывод (print mode) |
| `--permission-mode` | `default`, `acceptEdits`, `plan`, `auto`, `dontAsk`, `bypassPermissions` (`manual` — алиас для `default` с v2.1.200) |
| `--allowedTools` / `--disallowedTools` | Авто-разрешения / запреты по паттернам |
| `--resume` / `-r`, `--continue` / `-c`, `--session-id`, `--fork-session` | Сессии (см. п.5) |
| `--bg`, `--background` | Фоновый агент-сессия (возвращает управление сразу; **нельзя** комбинировать с `-p`) |
| `--model`, `--append-system-prompt`, `--append-system-prompt-file`, `--agents`, `--settings`, `--mcp-config`, `--plugin-dir`, `--add-dir`, `--debug`, `--debug-file` | Конфигурация |
| `--no-session-persistence` | Разовый запуск без записи транскрипта |

Поведение в `-p` режиме, важное для оркестратора:

- **stdin**: `-p` читает stdin (`cat build-error.txt | claude -p "explain"`). Если stdin прочитать нельзя (например, процесс-родитель закрыл конец канала), печатается warning в stderr и работа продолжается с промптом из аргумента. До v2.1.211 нечитаемый stdin на Windows крашил сессию или приводил к тихому выходу без вывода — фикс в 2.1.211.
- **Лимит stdin 10 MB** (с v2.1.128): при превышении — явная ошибка и non-zero exit. Для больших входов — писать в файл и ссылаться в промпте.
- **Фоновые Bash-задачи**: шелл, запущенный Claude в `-p`-прогоне (dev-сервер и т.п.), убивается ~через 5 секунд после финального результата (v2.1.163+). Фоновые сабагенты и workflows — исключение, на них `-p` ждёт (потолок 10 минут с v2.1.182; настройка `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`, `0` = без лимита).
- **SIGTERM** (`kill`): абортит текущий ход, убивает process tree Bash-команд, выполняет `SessionEnd` hooks, выходит с кодом 143 (фикс процесса-сироты — v2.1.212).
- **Медленный потребитель stdout**: с v2.1.214 CLI ждёт слива очереди stream-json перед выходом (до 30 сек), раньше лимит был ~2 сек и обрезал конец большого ответа.
- Недоступны в `-p`: терминальные команды типа `/login`, `/agents` wizard, `Shift+Tab`-цикл и т.п. Скиллы и кастомные команды работают (`/skill-name` в промпте).

Источники: https://code.claude.com/docs/en/headless, https://code.claude.com/docs/en/cli-reference

---

## 2. Передача промпта

Три официальных способа + расширенные варианты:

1. **Аргументом:**
   ```bash
   claude -p "What does the auth module do?"
   ```
2. **Через stdin (pipe):**
   ```bash
   cat build-error.txt | claude -p 'concisely explain the root cause' > output.txt
   ```
   Без аргумента и без stdin `-p` не запускается: `Input must be provided either through stdin or as a prompt argument when using --print` ([error reference](https://code.claude.com/docs/en/errors)).
3. **Потоково через `--input-format stream-json`** — JSONL-сообщения пользователя на stdin (протокол [Streaming Input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)): режим постоянной сессии, можно слать несколько сообщений, с `--replay-user-messages` эхом пользовательских сообщений в stdout для подтверждения.
   ```bash
   claude -p --input-format stream-json --output-format stream-json --verbose --replay-user-messages
   ```
   С v2.1.205 сообщение, отправленное пока агент работает, ставится в очередь и выполняется отдельным ходом (раньше отбрасывалось).
4. **Дополнительный контекст:** `--append-system-prompt` / `--append-system-prompt-file` (доп. системный промпт), `--agents '{"reviewer":{...}}'` (динамические сабагенты), `--settings <file-or-json>`, `--mcp-config`, `--plugin-dir`, `--add-dir`.

Скиллы/кастомные команды вызываются прямо из строки промпта (`/code-review:code-review ...`).

Источники: https://code.claude.com/docs/en/headless, https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode, https://code.claude.com/docs/en/cli-reference

---

## 3. Структурированный вывод (JSON / streaming JSON)

### `--output-format json` — один итоговый JSON

```bash
claude -p "Summarize this project" --output-format json
```

Документированные поля (описаны фрагментарно в headless.md и SDK-доках; единой таблицы CLI-контракта нет, контракт соответствует сообщениям Agent SDK):

- `result` — текстовый результат;
- `session_id` — ID сессии (для последующего `--resume`);
- `usage` — токены: `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`;
- `total_cost_usd` — оценочная стоимость запуска (client-side оценка!);
- per-model breakdown (в SDK — `modelUsage` / `model_usage`): модель → costUSD, input/output/cache-токены;
- `structured_output` — при передаче `--json-schema`;
- `is_error`, `subtype` — признак ошибки (`success`, `error_max_turns`, `error_max_structured_output_retries` и др. — в SDK-терминах).

Разбор через jq (официальный пример):
```bash
claude -p "Summarize this project" --output-format json | jq -r '.result'
```

### `--output-format stream-json` — NDJSON-поток событий

```bash
claude -p "Explain recursion" --output-format stream-json --verbose --include-partial-messages
```

Каждая строка — JSON-событие. Типы событий (документированные):
- `system/init` — первое событие: метаданные сессии (модель, tools, `mcp_servers` + `mcp_server_errors` (v2.1.219+), `plugins` + `plugin_errors`, `capabilities`-массив для feature-detection (v2.1.205+));
- `system/api_retry` — ретрай API (поле `error_status`, `attempt`, `max_retries`);
- `system/plugin_install` — прогресс установки плагинов (при `CLAUDE_CODE_SYNC_PLUGIN_INSTALL`);
- `stream_event` — частичные дельты (с `--include-partial-messages`): `select(.type == "stream_event" and .event.delta.type? == "text_delta") | .event.delta.text`;
- `assistant` / `user` — сообщения (сабагенты — с `parent_tool_use_id`; при `--forward-subagent-text` и текст/thinking сабагентов);
- **последняя строка — `result`**: финальный текст, стоимость, session_id, usage. Плюс `hook_started` / `hook_progress` / `hook_response` (v2.1.204+).

### Валидированный JSON — `--json-schema`

```bash
claude -p "Extract the main function names from auth.py" \
  --output-format json \
  --json-schema '{"type":"object","properties":{"functions":{"type":"array","items":{"type":"string"}}},"required":["functions"]}'
```
Результат — в поле `structured_output`. Поведение при невалидной схеме менялось: до v2.1.205 схема тихо игнорировалась и возвращался неструктурированный текст, с v2.1.205 — ошибка и exit code 1. Ключевое слово `format` принимается как аннотация без валидации.

Источники: https://code.claude.com/docs/en/headless, https://code.claude.com/docs/en/agent-sdk/structured-outputs, https://code.claude.com/docs/en/agent-sdk/cost-tracking

---

## 4. Автоматическое разрешение действий (auto-approve / permission modes)

Два механизма: точечные правила `--allowedTools` и режимы `--permission-mode` ([Permission modes](https://code.claude.com/docs/en/permission-modes)).

### `--allowedTools` / `--disallowedTools`

```bash
claude -p "Run the test suite and fix any failures" --allowedTools "Bash,Read,Edit"
claude -p "review staged changes" --allowedTools "Bash(git diff *),Bash(git log *),Bash(git status *),Bash(git commit *)"
```
Правила-паттерны ([syntax](https://code.claude.com/docs/en/settings#permission-rule-syntax)); ` *` в конце = префиксное совпадение (пробел перед `*` важен: `Bash(git diff*)` матчит и `git diff-index`).

### `--permission-mode` — режимы

| Режим | Что выполняется без вопроса | Когда использовать |
|---|---|---|
| `default` (= `manual` с v2.1.200) | Только чтение | Чувствительные задачи |
| `acceptEdits` | Правки файлов + `mkdir`, `touch`, `rm`, `rmdir`, `mv`, `cp`, `sed` (только в рабочей директории) | Итерации по коду |
| `plan` | Чтение + команды, одобренные классификатором auto mode | Исследование перед правками |
| `auto` | Всё с фоновыми проверками классификатора-модели (Sonnet 5 по умолчанию) | Долгие задачи без диалогов |
| `dontAsk` | Только pre-approved инструменты; всё остальное **автоматически запрещается** | Lock-down CI и скрипты |
| `bypassPermissions` | Всё (включая protected paths) | Только изолированные контейнеры/VM |

Важные нюансы для headless-прогона:

- **`dontAsk` — рекомендованный режим для CI**: сессия никогда не ждёт ввода; денайт то, что не в `permissions.allow`/read-only-наборе; `AskUserQuestion` тоже денаится.
- **`bypassPermissions` в `-p`**: диалог принятия ответственности **не показывается**; отказ при root/sudo; circuit breaker на `rm -rf /` и `rm -rf ~` остаётся. Эквивалент: `--dangerously-skip-permissions`. `--allow-dangerously-skip-permissions` — добавить режим в цикл Shift+Tab без активации (для интерактива).
- **Protected paths** (`.git`, `~/.zshrc`, `.envrc`, `.claude.json` и т.д.) никогда не авто-апрувятся, кроме `bypassPermissions`.
- **Auto mode + `-p`**: при повторных блокировках классификатора прогон **абортится** (некому спросить). Fallback-порог в интерактиве: 3 блокировки подряд или 20 суммарно. Требования к авто-режиму: модель (Opus 4.6+/Sonnet 4.6+/Fable 5 на API) и т.д.
- **Если нужен диалог, а его нет**: в `-p`-режиме при попытке инструмента, требующего разрешения, прогон прерывается; если указан несуществующий `--permission-prompt-tool` — exit code 1 на первом же вызове.
- `defaultMode` в settings (`~/.claude/settings.json` → `permissions.defaultMode`). `defaultMode: "auto"` из `.claude/settings.json`/`.claude/settings.local.json` игнорируется (v2.1.142+) — репозиторий не может выдать себе авто-режим.
- Auto mode отключён на Bedrock/Vertex/Foundry до v2.1.207 без `CLAUDE_CODE_ENABLE_AUTO_MODE=1`; с 2.1.207 переменная не нужна (принимается для совместимости, не влияет).

Источники: https://code.claude.com/docs/en/permission-modes, https://code.claude.com/docs/en/headless#auto-approve-tools

---

## 5. Продолжение сессии (resume / session id)

**Да, полный аналог нашего `agent send`:**

```bash
# Первый запуск — забрать session_id
session_id=$(claude -p "Start a review" --output-format json | jq -r '.session_id')

# Следующее сообщение
claude -p "Continue that review" --resume "$session_id"
claude -p "summarize what we changed" --resume "$session_id" --output-format json | jq -r '.result'
```

Флаги ([Sessions](https://code.claude.com/docs/en/sessions), [Headless](https://code.claude.com/docs/en/headless#continue-conversations)):
- `--resume <id|name>` / `-r` — конкретная сессия по ID или имени;
- `--continue` / `-c` — самая свежая сессия в текущей директории (работает и с `-p`);
- `--fork-session` — ветвление: новый session ID вместо исходного (совместно с `--resume`/`--continue`);
- `--session-id "<uuid>"` — задать конкретный UUID новой сессии.

Критичные ограничения:

- **Scoping по директории**: поиск session ID идёт в текущем каталоге проекта и его git worktrees. Резюмировать надо из той же директории, где сессия создана; иначе — `No conversation found with session ID: <id>`. Запускать оба вызова из одного `--cwd`.
- Сессии, созданные через `-p`, **не видны в интерактивном пикере**, но резюмируются по ID.
- **Не восстанавливаются при resume**: `--mcp-config`, `--settings`, `--plugin-dir`, `--fallback-model`, `--add-dir` — нужно передавать заново. Settings-файлы перечитываются автоматически.
- Модель восстанавливается (кроме retired-моделей, ограничений `availableModels`, явного `--model`/env на запуске, provider-specific ID на Bedrock/Vertex/Foundry).
- Режимы `plan`/`bypassPermissions` не восстанавливаются; `auto` — только если требования актуальны.
- `Failed to resume the conversation` → exit code 1 (v2.1.216+; раньше — вечное «Resuming conversation…»).
- Транскрипты: `~/.claude/projects/<project>/<session-id>.jsonl`. Формат внутренний и меняется между версиями — **не парсить напрямую**, использовать `-p --resume` + JSON-вывод (официальная рекомендация) или `--no-session-persistence` для разовых прогонов.
- `claude agents --json` — список фоновых сессий (`--json --all` включает завершённые) — может пригодиться как аналог нашего `agent status`.

Источники: https://code.claude.com/docs/en/sessions, https://code.claude.com/docs/en/headless#continue-conversations

---

## 6. Официальная документация и готовые интеграции

### Где документировано
- **Документация переехала:** с `docs.claude.com/en/docs/claude-code/*` на **`code.claude.com/docs/en/*`** (старые ссылки редиректятся). Индекс всех страниц: `https://code.claude.com/docs/llms.txt`.
- Ключевые страницы: [Headless](https://code.claude.com/docs/en/headless), [CLI reference](https://code.claude.com/docs/en/cli-reference), [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview), [TypeScript SDK](https://code.claude.com/docs/en/agent-sdk/typescript), [Python SDK](https://code.claude.com/docs/en/agent-sdk/python), [Structured outputs](https://code.claude.com/docs/en/agent-sdk/structured-outputs), [Streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode), [Sessions](https://code.claude.com/docs/en/sessions), [Permission modes](https://code.claude.com/docs/en/permission-modes), [Errors](https://code.claude.com/docs/en/errors), [Cost tracking](https://code.claude.com/docs/en/agent-sdk/cost-tracking).

### Claude Code SDK → Claude Agent SDK (важно для терминологии)
- SDK переименован ([Migration guide](https://code.claude.com/docs/en/agent-sdk/migration-guide.md)): TS `@anthropic-ai/claude-code` → **`@anthropic-ai/claude-agent-sdk`**, Python `claude-code-sdk` → **`claude-agent-sdk`**.
- Breaking changes v0.1.0: системный промпт Claude Code больше не используется по умолчанию (нужен явно `systemPrompt: {type:"preset", preset:"claude_code"}`); `ClaudeCodeOptions` → `ClaudeAgentOptions`.
- **SDK доступен только для Python и TypeScript.** Для других языков Anthropic прямо рекомендует запуск CLI как subprocess с `-p` и `--output-format json` — это ровно наш случай (оркестратор на bash/node).
- Репозитории: [anthropics/claude-code](https://github.com/anthropics/claude-code) (README/CHANGELOG), [anthropics/claude-agent-sdk-typescript](https://github.com/anthropics/claude-agent-sdk-typescript), [anthropics/claude-agent-sdk-python](https://github.com/anthropics/claude-agent-sdk-python), [anthropics/claude-agent-sdk-demos](https://github.com/anthropics/claude-agent-sdk-demos).

### Готовые интеграции CLI в оркестраторы/CI
- **GitHub Actions**: официальный Action `anthropics/claude-code-action@v1` (репо [anthropics/claude-code-action](https://github.com/anthropics/claude-code-action)); документация — [Claude Code GitHub Actions](https://code.claude.com/docs/en/github-actions). Параметры: `prompt`, `claude_args` (проброс любых CLI-флагов: `--max-turns 5 --model ... --allowedTools ...`), `anthropic_api_key`, `github_token`, `trigger_phrase` (`@claude`), `use_bedrock`/`use_vertex`. Пример workflow в `examples/claude.yml`.
- **GitLab CI/CD**: отдельная официальная страница [Claude Code GitLab CI/CD](https://code.claude.com/docs/en/gitlab-ci-cd).
- **CI-аутентификация**: `claude setup-token` — long-lived OAuth-токен для CI/скриптов (требует подписку Claude), см. [Authentication](https://code.claude.com/docs/en/authentication#generate-a-long-lived-token).
- **CI-ретраи**: `CLAUDE_CODE_RETRY_WATCHDOG=1` — бесконечные ретраи 429/529 в unattended-сессиях ([errors](https://code.claude.com/docs/en/errors)).
- Прочие: `claude agents --json` для мониторинга фоновых сессий, `claude logs <id>` / `claude attach <id>` / `claude stop <id>` для управления ими, `claude doctor` для диагностики.

Источники: https://code.claude.com/docs/en/agent-sdk/overview, https://code.claude.com/docs/en/agent-sdk/migration-guide.md, https://code.claude.com/docs/en/github-actions, https://code.claude.com/docs/llms.txt, https://github.com/anthropics/claude-code

---

## 7. Exit codes и логирование стоимости/токенов

### Exit codes — полной официальной таблицы НЕТ
Официальный список не публикуется; документированы только отдельные случаи ([errors.md](https://code.claude.com/docs/en/errors), [headless.md](https://code.claude.com/docs/en/headless), CHANGELOG):

| Код | Случай | Источник |
|---|---|---|
| `0` | Успех; `claude auth status` — 0 если залогинен, 1 если нет | cli-reference |
| `1` | Невалидный `--json-schema` (v2.1.205+; до — тихий неструктурированный вывод) | errors |
| `1` | Settings-файл > 2 MiB (v2.1.214+; до — без проверки размера) | errors |
| `1` | `remote-control`/`rc` в недоверенной рабочей директории | errors |
| `1` | `--permission-prompt-tool` не найден — на первом вызове, требующем разрешения | errors |
| `1` | `Failed to resume the conversation` (v2.1.216+; до — зависание) | errors |
| `143` | SIGTERM в `-p`-режиме: abort хода, убийство process tree, SessionEnd hooks | headless / CHANGELOG 2.1.212 |
| `137` | SIGKILL/OOM при установке (`claude install`) | errors |
| non-zero | Превышение stdin-лимита 10 MB (v2.1.128+) | headless |
| (не документирован) | `--max-turns` достигнут — «exits with an error»; повторные блокировки auto mode в `-p` — abort | cli-reference / permission-modes |

Практический вывод для оркестратора: полагаться на **`result`-событие в JSON-выводе** (поля `is_error`/`subtype`/`error`) и текст ошибок, а не только на exit code; `--debug`/`--debug-file` — для диагностики.

### Стоимость и токены
- В `--output-format json` и в финальном `result`-событии `stream-json`: `total_cost_usd` (суммарная оценка), `usage` (input/output/cache-токены), per-model breakdown (`modelUsage`). Доступно и в success-, и в error-результатах.
- **`total_cost_usd` — client-side оценка** по встроенной в бинарник таблице цен, **не авторитетный биллинг** (может расходиться при изменении цен, неизвестных моделях). Для точного учёта — [Usage and Cost API](https://platform.claude.com/docs/en/build-with-claude/usage-cost-api). Наш раннер может смело использовать как оценку, но не как основание для выставления счетов.
- Токены: `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`; при параллельных tool-вызовах несколько assistant-сообщений делят один message ID — дедуплицировать по ID при суммировании.
- `--verbose` — детальный построчный вывод; `--debug "api,hooks"` / `--debug-file <path>` — логи.

Источники: https://code.claude.com/docs/en/errors, https://code.claude.com/docs/en/headless, https://code.claude.com/docs/en/agent-sdk/cost-tracking

---

## 8. Текущая версия и deprecated-поведения

**Текущая стабильная: v2.1.220** (последняя запись CHANGELOG; версия из `anthropics/claude-code` CHANGELOG.md). Установка — нативные бинарники (Windows: `irm https://claude.ai/install.ps1 | iex` или `winget install Anthropic.ClaudeCode`); **npm-установка deprecated** (README). `claude install stable|latest|<версия>` — управление версиями.

Задокументированные депрекации/удаления (CHANGELOG + README + docs):

| Что | Статус | Замена |
|---|---|---|
| npm-установка `@anthropic-ai/claude-code` | Deprecated (README) | нативные бинарники / winget / homebrew |
| Флаг `--enable-auto-mode` | Удалён в v2.1.111 | `--permission-mode auto` |
| `CLAUDE_CODE_ENABLE_AUTO_MODE` | Не нужен с v2.1.207 (принимается, не влияет) | — |
| `defaultMode: "auto"` в репозиторных settings | Игнорируется с v2.1.142 (репо не может выдать себе авто-режим) | `~/.claude/settings.json` |
| Task tool `mode` параметр | Deprecated (v2.1.212, игнорируется) | сабагенты наследуют permission mode родителя |
| `TeamCreate`/`TeamDelete` tools | Удалены (экспериментальные agent teams) | неявная команда + Agent tool `name` |
| `/agents` интерактивный wizard | Удалён (v2.1.198) | редактирование `.claude/agents/` |
| GitHub Action beta → `@v1` | Breaking (mode удалён, авто-детект; `direct_prompt`→`prompt`; флаги → `claude_args`) | v1 |
| Claude Code SDK → Claude Agent SDK | Переименование; breaking v0.1.0 (системный промпт не дефолт; `ClaudeCodeOptions`→`ClaudeAgentOptions`) | `@anthropic-ai/claude-agent-sdk`, `claude-agent-sdk` |
| TypeScript SDK V2 session API | Удалён | SDK v1 API |
| `--json-schema` с невалидной схемой | До v2.1.205 тихо игнорировалась; с 2.1.205 — ошибка + exit 1 | — |
| Piped stdin | Лимит 10 MB с v2.1.128 (было без лимита) | файлы для больших входов |
| `--bare` для `-p` | Анонсирован дефолтом для `-p` в будущем релизе | — |
| Slack-интеграция | Retiring для Team/Enterprise (в пользу Claude Tag); Pro/Max остаётся | — |
| Некорректный вывод в `-p` text при mid-stream ошибке | До v2.1.219 терялся накопленный ответ; с 2.1.219 печатается последний завершённый блок + notice | — |
| Документация | Переезд с docs.claude.com на code.claude.com | — |

Источники: CHANGELOG [anthropics/claude-code](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md), README [anthropics/claude-code](https://github.com/anthropics/claude-code), https://code.claude.com/docs/llms.txt

---

## Приложение: аудит текущего раннера `lib/runners/claude.js`

Текущая реализация (`claude -p --output-format stream-json --print` + парсинг событий `text`/`message`/`error`/`result`) **в целом корректна** и соответствует официальному контракту. Замечания:

1. `-p` и `--print` передаются одновременно — это один и тот же флаг (избыточно, но безвредно).
2. `capabilities.cost: false` — можно включить: `total_cost_usd` + `usage` доступны в `result`-событии stream-json (и в `json`). Учесть, что это client-side оценка.
3. `parse()` собирает текст из `text`/`message`/`result` — корректно. Для более надёжной ошибки стоит смотреть `subtype`/`is_error` у `result`-события (в т.ч. `error_max_turns` при `--max-turns`).
4. Сессии: `--resume` по `sessionId` уже поддержан; помнить про scoping по директории (запуск из того же `--cwd`).
5. Опциональные улучшения: `--bare` (детерминизм CI, но теряются CLAUDE.md/плагины проекта — решение по парадигме оркестратора), `--permission-mode dontAsk` + `--allowedTools` для lock-down, `--json-schema` для структурированного результата, `--max-turns` для защиты от бесконечных циклов, `CLAUDE_CODE_RETRY_WATCHDOG=1` для CI-ретраев, `--no-session-persistence` для разовых прогонов.
