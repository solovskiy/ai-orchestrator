# Codex CLI (openai/codex): headless-режим и интеграция в .ai/bin/agent

> Дата исследования: 2026-08-01. Источники — преимущественно официальные: docs
> developers.openai.com (Codex), README/исходники репозитория `openai/codex` (main,
> релиз 0.146.0 от 2026-07-29), help.openai.com.

---

## Summary (ключевые выводы)

1. **Headless-режим существует и официально поддерживается**: это `codex exec`
   (короткий алиас `codex e`). Работает без TTY, в фоне/CI, stdin-пайпах.
2. **Промпт**: позиционный аргумент; `codex exec -` — промпт из stdin;
   piped stdin + аргумент → stdin добавляется как контекст `<stdin>`.
3. **Структурированный вывод**: `--json` даёт JSONL-поток событий
   (`thread.started`, `turn.*`, `item.*`, `error`) с токенами в `turn.completed.usage`;
   `--output-schema` заставляет модель вернуть финальный ответ по JSON Schema;
   `-o/--output-last-message FILE` пишет финальное сообщение в файл.
4. **Approvals без интерактива**: в `codex exec` approval_policy **принудительно
   `never`** (не спрашивает). Безопасность задаётся sandbox-флагом:
   `--sandbox {read-only|workspace-write|danger-full-access}` (по умолчанию
   read-only), `--approve-for-me` (авто-ревью, alias `--not-so-yolo`),
   `--dangerously-bypass-approvals-and-sandbox` (alias `--yolo`).
   Deprecated-флаг `--full-auto` → warning, заменён на `--sandbox workspace-write`.
5. **Resume сессии есть**: `codex exec resume --last "<msg>"` (последняя сессия
   в cwd) или `codex exec resume <SESSION_ID> "<msg>"`. Это прямой аналог
   нашего `agent send`. Session id приходит в JSONL как `thread_id` события
   `thread.started`.
6. **Текущий `lib/runners/codex.js` устарел**: использует интерактивный режим
   (`codex --model X --dir Y "prompt"`) с флагом `--dir`, которого в текущем CLI
   нет (рабочая директория теперь `-C/--cd`), и требует TTY, которого нет в
   `run-job.sh`. Парсер рассчитан на старый формат событий. Рекомендуется
   переписать на `codex exec --json` (см. раздел «Рекомендации для интеграции»).
7. **Exit codes**: 0 = успех; 1 = любая ошибка/фатальность (нет гранулярных кодов).
8. **Версия**: стабильный релиз **0.146.0** (2026-07-29). Известные изменения/
   deprecated: `--full-auto`, Chat Completions API (deprecated в Codex),
   GPT-5.4/5.4-mini retire 2026-08-31 для ChatGPT-авторизации, pricing переведён
   с per-message на token-based credits (апрель 2026).

---

## 1. Неинтерактивный/headless режим

**Да: `codex exec`** (алиас `codex e`). Это официальный способ запуска «в
скриптах и CI без интерактивного TUI».

```
codex exec "summarize the repository structure and list the top 5 risky areas"
```

- Прогресс идёт в **stderr**, в **stdout** печатается только финальное
  сообщение агента (в дефолтном режиме) — удобно для pipe:
  `codex exec "..." | tee release-notes.md`
- Работает с перенаправленным stdin/stdout (без TTY), что подтверждает
  пригодность для фонового запуска из `run-job.sh`.

Флаги `codex exec` (из исходника `codex-rs/exec/src/cli.rs`, стабильные):

| Флаг | Назначение |
|---|---|
| `--json` (алиас `experimental-json`) | JSONL-поток событий на stdout |
| `-o, --output-last-message FILE` | записать финальное сообщение в файл (и всё равно напечатать в stdout) |
| `--output-schema FILE` | JSON Schema для финального ответа модели |
| `--ephemeral` | не сохранять session-файлы на диск |
| `--skip-git-repo-check` | разрешить запуск вне git-репозитория (по умолчанию требуется git-репо) |
| `--ignore-user-config` | не читать `$CODEX_HOME/config.toml` (auth всё равно из `CODEX_HOME`) |
| `--ignore-rules` | не читать execpolicy `.rules` (user/project) |
| `--strict-config` | падать на неизвестных полях config.toml |
| `--color {auto|always|never}` | управление цветом |
| `--sandbox MODE`, `-s` | sandbox-режим (см. §4) |
| `--approve-for-me` | авто-ревью approvals (см. §4) |
| `--dangerously-bypass-approvals-and-sandbox` (alias `--yolo`) | без sandbox и approvals |
| `--dangerously-bypass-hook-trust` | не требовать доверия к хукам |
| `-m, --model MODEL` | модель |
| `-C, --cd DIR` | рабочая директория (внимание: НЕ `--dir`) |
| `--add-dir DIR` | дополнительные writable-директории |
| `-i, --image FILE` | прикрепить изображение (multiple, через `,`) |
| `-p, --profile NAME` | профиль конфига (`$CODEX_HOME/<name>.config.toml`) |
| `--oss`, `--local-provider {lmstudio\|ollama}` | локальные провайдеры |
| `PROMPT` | позиционный аргумент (или `-` для stdin) |

Подкоманды `codex exec`: `resume` (§5) и `review` (`--uncommitted`, `--base BRANCH`,
`--commit SHA`, `--title`, PROMPT).

Полный список top-level подкоманд CLI 0.146 (из `codex-rs/cli/src/main.rs`):
`exec` (алиас `e`), `review`, `login`, `logout`, `mcp`, `plugin`,
`mcp-server`, `app-server` [experimental], `remote-control` [experimental],
`app` (Desktop, только macOS/Windows), `completion`, `update`, `doctor`,
`sandbox` (запуск команд внутри sandbox), `debug`, `execpolicy` (скрытая),
`apply` (алиас `a`; `git apply` последнего диффа), `resume` (интерактивный
picker, `--last` — самая свежая), `archive` (архивация сессии по id/имени).

Источники:
- https://developers.openai.com/codex/non-interactive-mode
- https://developers.openai.com/codex/developer-commands
- https://github.com/openai/codex/blob/main/codex-rs/exec/src/cli.rs
- https://github.com/openai/codex/blob/main/codex-rs/utils/cli/src/shared_options.rs
- https://github.com/openai/codex/blob/main/codex-rs/cli/src/main.rs (Subcommand enum)

## 2. Передача промпта

Три способа (документированы в разделе «Advanced stdin piping»):

1. **Аргументом** (основной):
   `codex exec "task text"`
2. **Из stdin** — сентинел `-`:
   `cat prompt.txt | codex exec -`
   `generate_prompt.sh | codex exec - --json > result.jsonl`
   Если позиционный промпт опущен, а stdin припайплен — промпт читается из stdin
   (legacy-поведение).
3. **Промпт аргументом + stdin как контекст**: если stdin припайплен И передан
   аргумент-промпт, stdin добавляется как блок `<stdin>` дополнительного контекста:
   `npm test 2>&1 | codex exec "summarize the failing tests"`

Внимание: в исходнике это подтверждено (`StdinPromptBehavior`:
`RequiredIfPiped` / `Forced` / `OptionalAppend` в `codex-rs/exec/src/lib.rs`).

Источник: https://developers.openai.com/codex/non-interactive-mode (Advanced stdin piping)

## 3. Структурированный вывод (JSON / streaming)

**`codex exec --json`** — stdout становится JSONL-потоком, по одному JSON-объекту
на строку (каждый event — полное состояние, не дельта).

Типы событий (из `codex-rs/exec/src/exec_events.rs`):
- `thread.started` → `{thread_id}` — **id сессии для resume**
- `turn.started`
- `turn.completed` → `{usage}` — токены за ход
- `turn.failed` → `{error:{message}}`
- `item.started` / `item.updated` / `item.completed` → `{item}`:
  - `agent_message` → `{text}` — финальный/промежуточный ответ агента
  - `reasoning`, `command_execution` (`{command, exit_code, status}`),
    `file_change` (`{changes:[{path,kind}], status}`), `mcp_tool_call`,
    `collab_tool_call`, `web_search`, `todo_list`, `error`
- `error` → фатальная ошибка стрима

Пример (из офиц. документации):
```
{"type":"thread.started","thread_id":"0199a213-81c0-7800-8aa1-bbab2a035a53"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"Repo contains docs, sdk, and examples directories."}}
{"type":"turn.completed","usage":{"input_tokens":24763,"cached_input_tokens":24448,"output_tokens":122,"reasoning_output_tokens":0}}
```

Поля `usage` в `turn.completed`:
`input_tokens`, `cached_input_tokens`, `cache_write_input_tokens` (опционально),
`output_tokens`, `reasoning_output_tokens`.

**Структурный ответ по схеме**: `--output-schema ./schema.json -o ./out.json`
— модель обязана вернуть финальный JSON, соответствующий JSON Schema
(полезно для job-сумм/метаданных).

**Только финальное сообщение**: `-o/--output-last-message FILE` пишет последнее
сообщение в файл (и печатает в stdout).

Рекомендация для пары с `run-job.sh`: `--json` + `--output-last-message result.md`
(совет официальной документации: «Pair `--json` with `--output-last-message` in CI»).

Источники:
- https://developers.openai.com/codex/non-interactive-mode (Make output machine-readable)
- https://github.com/openai/codex/blob/main/codex-rs/exec/src/exec_events.rs

## 4. Авто-одобрение действий (sandbox / approval modes) без интерактива

Ключевой факт из исходников (`codex-rs/exec/src/lib.rs`, `run_main`):
в headless-режиме Codex **принудительно ставит `approval_policy = Never`**
(«Default to never ask for approvals in headless mode») — интерактивного диалога
одобрения нет по построению. Разграничение идёт через **sandbox**:

- `--sandbox read-only` — по умолчанию: чтение/просмотр без записи и без
  команд вне доверенного набора.
- `--sandbox workspace-write` — запись только внутри workspace + рутинные
  команды. **Это рекомендуемый режим для unattended локальной работы.**
- `--sandbox danger-full-access` — без ограничений ФС/сети; только в
  изолированной среде (CI-runner/контейнер).
- `--approve-for-me` (alias `--not-so-yolo`) — approval-запросы уходят на
  автоматическое ревью: равнозначно конфигу
  `approvals_reviewer="auto_review"` + `approval_policy="on-request"` +
  `sandbox_mode="workspace-write"`.
- `--dangerously-bypass-approvals-and-sandbox` (alias `--yolo`) — полный доступ
  (для внешне изолированных окружений).
- `--add-dir DIR` — добавить writable-директории без отказа от sandbox
  (предпочтительно расширению до danger-full-access).
- `--dangerously-bypass-hook-trust` — для автоматизации, где хуки уже проверены.
- Если настроен MCP-сервер с `required = true` и он не инициализировался —
  `codex exec` завершается ошибкой (exit ≠ 0).

Интерактивный CLI (не для нас) использует отдельный флаг
`-a/--ask-for-approval {untrusted|on-request|never}`; для `exec` он не применяется
(approval там всегда `never`, управление — только sandbox-флагами).

В config.toml это же настраивается ключами `sandbox_mode`, `approval_policy`,
`approvals_reviewer`, `sandbox_workspace_write.writable_roots`.

Deprecated: `codex exec --full-auto` остаётся как compatibility-флаг и **печатает
warning** — в новых скриптах использовать `--sandbox workspace-write`.

Примечание для нашего случая: без `--sandbox workspace-write` (или
`--approve-for-me`) агент не сможет писать файлы (read-only + никогда не
спрашивает) — для кодинг-задач флаг обязателен.

Источники:
- https://developers.openai.com/codex/sandboxing
- https://developers.openai.com/codex/permission-modes
- https://developers.openai.com/codex/non-interactive-mode (Permissions and safety)
- https://github.com/openai/codex/blob/main/codex-rs/exec/src/lib.rs
- https://github.com/openai/codex/blob/main/codex-rs/utils/cli/src/shared_options.rs

## 5. Продолжение существующей сессии (аналог `agent send`)

**Есть, официально**: подкоманда `codex exec resume`.

```
codex exec "review the change for race conditions"
codex exec resume --last "fix the race conditions you found"
codex exec resume <SESSION_ID> "next instruction"
```

- `--last` — самая свежая сессия **в текущем рабочем каталоге**.
- `--all` — искать по всем сессиям (снимает фильтр cwd).
- `<SESSION_ID>` — UUID или thread name (в исходнике: «Conversation/session id
  (UUID) or thread name»). В JSONL-режиме id лежит в событии
  `thread.started.thread_id` — сохраняйте его в job как `sessionId`.
- Сессии сохраняются на диск по умолчанию; `--ephemeral` отключает персистентность
  (тогда resume невозможен).
- resume принимает те же sandbox/model-флаги, что и `codex exec`.
- Для интерактивных сессий есть отдельная команда `codex resume` / `codex fork`
  (нам не нужна).

Это прямо закрывает наш сценарий `agent send <jobId> "<текст>"`:
`codex exec resume <sessionId> --json "<текст>"`.

Источники:
- https://developers.openai.com/codex/non-interactive-mode (Resume a non-interactive session)
- https://github.com/openai/codex/blob/main/codex-rs/exec/src/cli.rs (ResumeArgs)

## 6. Официальная документация и готовые интеграции в CI

- **Non-interactive mode**: https://developers.openai.com/codex/non-interactive-mode
  (полная страница про `codex exec`: флаги, stdin-пайпинг, JSONL, авто-аутентификация,
  resume, паттерны CI).
- **CLI reference (все команды/флаги)**: https://developers.openai.com/codex/developer-commands
  (markdown-версия: та же страница с `.md` суффиксом).
- **GitHub Action**: https://github.com/openai/codex-action — официальный action
  для GitHub Actions: ставит Codex, запускает локальный Responses API proxy
  (не светит ключ в раннерах), поддерживает configurable safety strategy.
  В документации есть полный рабочий пример «Autofix CI failures» (workflow,
  `contents: read` для job с Codex, патч артефактом, PR отдельным job).
- **SDK**: https://developers.openai.com/codex/codex-sdk — TypeScript SDK для
  программного управления Codex.
- **App Server / MCP Server**: `codex app-server` (JSONL-over-stdio/WebSocket) и
  `codex mcp-server` — альтернативные способы интеграции для «продвинутых» сценариев.
- Официальные бенчмарки/примеры CI лежат в docs к GitHub Action
  (https://github.com/openai/codex-action/blob/main/docs/security.md).

Сторонние оркестраторы (OpenClaw и т.п.) в отчёт не включал — по заданию
приоритет официальным источникам; GitHub-issue
(https://github.com/openai/codex/issues/20099) показывает, что подобные
интеграции существуют и сталкиваются с нюансами авторизации.

## 7. Exit codes, токены/стоимость на выходе, модели

### Exit codes
Гранулярных кодов нет: **0 = успех, 1 = любая ошибка**.
Причины exit 1 (из исходников и тестов):
- фатальное событие `error` в стриме или `turn.failed`/`turn.completed` со
  статусом `Failed`/`Interrupted` для текущего хода (`error_seen` → `exit(1)`);
- не в git-репо без `--skip-git-repo-check`;
- ошибки конфига/auth/execpolicy;
- `required=true` MCP-сервер не поднялся;
- `--output-schema` невалидная схема и т.п.
Успешный проход хода с ошибкой внутри (команда агента вернула ненулевой код) —
это НЕ провал `codex exec` (exit остаётся 0), ошибки видно в JSONL как
`command_execution` с `status: "failed"`.

### Токены/стоимость на выходе
- JSONL: `turn.completed.usage` = `{input_tokens, cached_input_tokens,
  cache_write_input_tokens, output_tokens, reasoning_output_tokens}`.
- Human-режим: в конце в **stderr** печатается строка `tokens used` + суммарное
  число токенов (`blended_total` = uncached input + output), финальное сообщение —
  в stdout. Денежную стоимость CLI сам не считает (нет поля cost) — только токены.
- В интерактиве с ChatGPT-аккаунтом токены конвертируются в credits по rate card
  (см. §8); с API-ключом — биллинг по API-тарифам.

### Модели
- Рекомендуемые (ChatGPT sign-in): `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`
  (задаются `-m/--model` или `codex exec -m gpt-5.6 ...`; дефолт — рекомендованная).
- Доступные ещё: `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`.
- Deprecated в Codex (ChatGPT sign-in): `gpt-5.2`, `gpt-5.3-codex`;
  `gpt-5.4`/`gpt-5.4-mini` **выводятся из Codex 2026-08-31** (заменить на
  `gpt-5.6-terra`/`gpt-5.6-luna`). Для API-ключа это не затрагивает.
- С API-ключом можно указать любую модель, поддерживающую Responses API
  (Chat Completions API **deprecated** в Codex).
- `--oss` / `--local-provider {lmstudio,ollama}` — локальные провайдеры.
- Актуальный каталог моделей из бинаря: `codex debug models` (JSON).

Источники:
- https://developers.openai.com/codex/models
- https://github.com/openai/codex/blob/main/codex-rs/exec/src/lib.rs
- https://github.com/openai/codex/blob/main/codex-rs/exec/src/event_processor_with_human_output.rs
- https://github.com/openai/codex/blob/main/codex-rs/exec/src/exec_events.rs

## 8. Стабильная версия, deprecated-поведения, rate limits

### Версия
- Последний стабильный релиз: **0.146.0** (tag `rust-v0.146.0`,
  опубликован 2026-07-29). Репозиторий полностью переписан на Rust
  («multitool» CLI: `exec`, `review`, `resume`, `app-server`, `cloud`, ...).
  CHANGELOG вынесен на страницу релизов: https://github.com/openai/codex/releases

### Deprecated / изменения
- `codex exec --full-auto` → deprecated, печатает warning; замена
  `--sandbox workspace-write`.
- Chat Completions API как бэкенд → deprecated, будет удалён.
- Модели `gpt-5.2`, `gpt-5.3-codex` deprecated; `gpt-5.4`/`gpt-5.4-mini`
  ретайр 2026-08-31 (только для ChatGPT-авторизации).
- 2026-04-02: pricing Codex переведён с per-message на **token-based credits**
  (совпало с API-токен-тарифами).
- `codex login --api-key` (передача ключа аргументом) — удалён; ключ
  передаётся только через stdin: `printenv OPENAI_API_KEY | codex login --with-api-key`.
- Внимание на именование: рабочий каталог теперь `-C/--cd`, НЕ `--dir`.

### Rate limits (официальные цифры, актуальны на 2026-08-01)
ChatGPT-авторизация — **rolling-окна 5 часов** («Local Messages / 5h»;
облачные чаты и code review — отдельные колонки; дополнительные недельные лимиты):

| План | GPT-5.6 Sol | GPT-5.6 Terra | GPT-5.6 Luna | GPT-5.5 | GPT-5.4 | GPT-5.4 mini |
|---|---|---|---|---|---|---|
| Free / Go | ограниченно (точных цифр в офиц. доке нет) | — | — | — | — | — |
| Plus | 15–90 | 20–110 | 50–280 | 15–80 | 20–100 | 60–350 |
| Pro 5x | 75–450 | 100–550 | 250–1400 | 75–400 | 100–500 | 300–1750 |
| Pro 20x | 300–1800 | 400–2200 | 1000–5600 | 300–1600 | 400–2000 | 1200–7000 |
| Business | как Plus (15–90 / ... ) | | | | | |
| Enterprise/Edu (flexible) | usage-based, лимитов нет | | | | | |

- По достижении лимита Plus/Pro могут **докупать credits** (в т.ч. auto top-up);
  усреднённая стоимость Codex ~$100–200 на разработчика в месяц.
- **API-ключ**: usage-based (платишь за токены по API-тарифу), лимиты — стандартная
  система тиров OpenAI **RPM/TPM** (нет message-окон). `CODEX_API_KEY` поддерживается
  **только в `codex exec`** и только для одного вызова (не как job-level env var,
  если в job есть непроверенный код).
- Смешанный режим: «All users may also run extra local tasks using an API key,
  with usage charged at standard API rates».
- Неофициально (сторонние отчёты, в отчёт не включены как факт): при исчерпании
  ChatGPT-лимита возможен тихий downgrade модели на более дешёвую; с API-ключом
  вместо этого возвращается 429.

Источники:
- https://developers.openai.com/codex/pricing
- https://chatgpt.com/codex/pricing/
- https://help.openai.com/en/articles/11369540-codex-in-chatgpt
- https://help.openai.com/en/articles/20001106-codex-rate-card
- https://github.com/openai/codex/releases

---

## Рекомендации для интеграции в .ai

Текущий `lib/runners/codex.js` (создан 2026-07-26) использует deprecated
интерактивный режим и сломан относительно актуального CLI:

```js
// buildArgs сейчас:
['codex', '--model', name, '--dir', job.cwd, prompt]
// проблемы: --dir не существует (нужно -C/--cd), интерактивный режим требует TTY,
// которого нет в run-job.sh (stdout/stderr в файлы)
```

Рекомендуемый контракт раннера:

```js
capabilities: { resume: true, cost: true, json: true },  // сейчас всё false

buildArgs(job, prompt) {
  const args = ['codex', 'exec', '--json'];
  if (job.model) args.push('-m', job.model.split('/').pop());
  if (job.cwd) args.push('-C', job.cwd);
  args.push('--sandbox', 'workspace-write'); // для кодинг-задач; иначе файлы не пишутся
  if (job.resume && job.sessionId) args.push('resume', job.sessionId);
  args.push(prompt);
  return args;
}
```

- `parse(events)` — обновить под новый JSONL: sessionId из `thread.started.thread_id`;
  текст из `item.completed` с `item.type === 'agent_message'` (`item.text`);
  токены суммировать из `turn.completed.usage` (input/output/reasoning/cached);
  error из события `error.message` и `turn.failed`.
- Финальное сообщение дублировать в `result.md` через
  `--output-last-message` (или брать из JSONL).
- Код выхода: exit 1 уже корректно трактуется `run-job.sh`; при этом
  `verify: passed` + пустой дифф = агент ничего не сделал — этот чек у нас уже есть.
- `agent send` → `codex exec resume <sessionId> --json "<текст>"`.

## Не найденное / не проверенное

- Точные лимиты **Free/Go** планов в официальных доках не указаны цифрами
  (только «included, usage limits vary by plan») — для практики это слабо
  применимо к фоновым задачам: для автоматизации надёжнее API-ключ.
- Поле денежной стоимости (`cost`) CLI не отдаёт — только токены; для расчёта
  стоимости нужен внешний пересчёт по тарифам.
- Точный формат строки `tokens used` в human-режиме взят из исходников
  (`eprintln!("tokens used\n{}", blended_total)`) — на живом CLI не проверялся
  (CLI на машине не установлен; проверка требует `codex login`).
