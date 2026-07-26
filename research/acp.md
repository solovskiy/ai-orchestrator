# Agent Client Protocol (ACP) — исследование

## 1. Что такое ACP

**Agent Client Protocol (ACP)** — открытый протокол для стандартизации взаимодействия между *кодовыми редакторами/IDE* (клиент) и *AI-кодинг-агентами* (сервер).

- **Автор**: Zed Industries (август 2025). С февраля 2026 JetBrains стала соруководителем (Lead Maintainer). Текущее управление — совместно Zed и JetBrains. [Источник](https://agentclientprotocol.com/updates)
- **Задача**: решает проблему N×M-интеграций — до ACP каждый редактор писал собственную интеграцию под каждого агента, и наоборот. Аналог LSP, но для агентов. [Источник](https://agentclientprotocol.com/get-started/introduction)
- **Транспорт**: JSON-RPC 2.0 поверх stdio (локальные агенты — дочерний процесс редактора). Сообщения — NDJSON (newline-delimited JSON). Для удалённых агентов прорабатываются HTTP/WebSocket (черновик). [Источник](https://github.com/agentclientprotocol/agent-client-protocol#readme)
- **Лицензия**: Apache 2.0

### Методы протокола (v1)

**Agent Methods (Client → Agent):**
`initialize`, `authenticate`, `session/new`, `session/load`, `session/prompt`, `session/set_mode`, `session/set_config_option`, `session/cancel`, `session/close`, `session/list`, `logout`

**Client Methods (Agent → Client):**
`session/update`, `session/request_permission`, `fs/read_text_file`, `fs/write_text_file`, `terminal/*`

## 2. Чем ACP отличается от MCP

| Аспект | ACP (Agent Client Protocol) | MCP (Model Context Protocol) |
|---|---|---|
| Что соединяет | Редактор ↔ Агент | Агент ↔ Инструменты/Данные |
| Роль агента | Сервер для редактора | Клиент для инструментов |
| Создатель | Zed Industries | Anthropic |
| Управление | Zed + JetBrains | Agentic AI Foundation (Linux Foundation) |
| Транспорт | JSON-RPC через stdio (HTTP/WIP) | JSON-RPC через stdio/HTTP/SSE |
| Основные операции | Сессии, промпты, дифы, разрешения, стриминг | Вызов инструментов, чтение ресурсов, шаблоны промптов |

**Ключевая идея**: протоколы **не конкурируют, а дополняют друг друга**. В типичной архитектуре агент одновременно является ACP-сервером для редактора и MCP-клиентом для своих инструментов. ACP даже переиспользует JSON-формы MCP, где это возможно. [Источник](https://circleci.com/blog/acp-vs-mcp-whats-the-difference-for-agentic-coding/)

**Про analogy**: MCP — это USB-C для AI-инструментов; ACP — это LSP для AI-агентов.

## 3. Какие агенты/CLI реализуют ACP на июль 2026

По данным официального реестра ACP ([agentclientprotocol.com/get-started/agents](https://agentclientprotocol.com/get-started/agents)) и ACP Registry ([блог Zed](https://zed.dev/blog/acp-registry)):

| Агент | Статус ACP | Тип подключения |
|---|---|---|
| **Gemini CLI** (Google) | Нативная поддержка (`gemini --acp`) | Первый внешний ACP-агент |
| **Claude Code** (Anthropic) | Через адаптер (`@zed-industries/claude-code-acp`) | Адаптер от Zed, не нативная поддержка |
| **Codex CLI** (OpenAI) | Через адаптер (`@agentclientprotocol/codex-acp`) | Официальный адаптер от Zed |
| **GitHub Copilot CLI** | Нативная (public preview с 01.2026) | В реестре ACP |
| **OpenCode** | Нативная (`opencode acp`) | Полноценная поддержка |
| **Cline** | Нативная | В реестре |
| **Goose** (Block) | Нативная | В реестре |
| **Qwen Code** | Нативная (`qwen --acp`) | В реестре |
| **Cursor** | Нативная (`cursor-agent acp`) | В реестре |
| **Junie** (JetBrains) | Нативная | В реестре |
| **Kimi CLI** | Нативная (`kimi acp`) | В реестре |
| **Aider** | **Нет поддержки ACP** | Есть открытый PR [#4936](https://github.com/Aider-AI/aider/pull/4936) и адаптер от сообщества ([jorgejhms/aider-acp](https://github.com/jorgejhms/aider-acp)), но официально — не реализован |

Всего в реестре ~35 агентов по состоянию на июль 2026.

## 4. Поддерживает ли ACP именно opencode

**Да, нативная полноценная поддержка.**

Подтверждение из официальных источников:

1. **Официальная документация opencode**: `opencode acp` — команда запуска. ACP-реализация находится в `packages/opencode/src/acp/`. Использует официальный `@agentclientprotocol/sdk`. [Источник](https://opencode.ai/docs/acp/)
2. **GitHub-репозиторий opencode**: `packages/opencode/src/acp/` содержит полную реализацию: `agent.ts`, `client.ts`, `session.ts`, `server.ts`. [Источник](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/acp/README.md)
3. **ACP Registry на zed.dev**: OpenCode указан в реестре ACP-агентов. [Источник](https://zed.dev/acp/agent/opencode)
4. **Официальный список агентов ACP**: OpenCode в списке. [Источник](https://agentclientprotocol.com/get-started/agents)

OpenCode — одна из эталонных реализаций протокола.

## 5. Зрелость протокола

- **Текущая версия спецификации**: v1 (стабильная). v2 — опубликован черновик (draft) 20 июля 2026. [Источник](https://agentclientprotocol.com/updates)
- **Версия SDK**: Rust SDK и TypeScript SDK достигли версии 1.0.0 (25 июня 2026). [Источник](https://agentclientprotocol.com/updates)
- **Дата запуска**: август 2025 (публичный анонс)
- **Управление**: совместно Zed Industries и JetBrains (с февраля 2026)
- **Экосистема**: ~35 совместимых агентов, 4+ редактора с нативной поддержкой (Zed, JetBrains IDE, Neovim через плагины, VS Code через расширения), интеграция от Microsoft (Intelligent Terminal), поддержка от marimo, Emacs
- **Активность разработки**: высокая — RFD-процесс, регулярные стабилизации, регулярные релизы
- **Продакшн-готовность**: **да**. Протокол v1 стабилен, используется в продакшене (Zed, JetBrains, Gemini CLI, GitHub Copilot). Однако поддержка удалённых агентов (HTTP/WebSocket) всё ещё в работе.

## 6. Практический вывод: оркестрация CLI-агентов из внешнего оркестратора

**Краткий ответ: нет, ACP спроектирован не для этого.**

ACP решает задачу *«редактор управляет агентом»*, а не *«внешний оркестратор управляет множеством CLI-агентов»*.

### Что ACP даёт для внешнего оркестратора

- **Да**, ACP можно использовать для оркестрации: вы можете написать программу, которая запускает `opencode acp` (или `gemini --acp`, `claude-code-acp`, `codex-acp`) как дочерний процесс, общается по JSON-RPC через stdio и управляет сессиями. Официальные SDK (Python, TypeScript, Rust, Kotlin, Java) это поддерживают.
- **Возможность замены агента**: если все ваши агенты реализуют ACP, то да — вы можете заменить одного на другого без переписывания. Единый протокол — это именно то, для чего он создан.
- **Ограничение**: ACP спроектирован преимущественно для связки *редактор ↔ агент*. В протоколе нет концепции «оркестратора», нет встроенной поддержки параллельного вызова нескольких агентов, нет агент-к-агенту коммуникации (это задача A2A).

### Что для этого нужно

Для оркестрации CLI-агентов из внешнего оркестратора ACP **подходит**, но есть нюансы:

1. ACP не решает задачу _агент-к-агенту_ (для этого есть A2A от Google/Linux Foundation).
2. ACP — это протокол одного клиента (редактора/оркестратора) и одного агента на соединение. Для параллельного запуска нескольких агентов нужно открывать отдельные процессы/соединения.
3. Некоторые агенты имеют ACP только через адаптер (Claude Code, Codex), а не напрямую.

### Альтернативы

Для задачи *«оркестрирую CLI-агентов из внешнего оркестратора и хочу заменять одного на другого»*:
- **ACP** — рабочий вариант, если все агенты его поддерживают (через stdio/JSON-RPC)
- **MCP** — если вам нужно подключать инструменты, а не CLI-агентов
- **A2A** — если нужно, чтобы агенты общались друг с другом (но A2A пока на ранней стадии)
- **Самописный адаптер** — завернуть каждого CLI-агента в единый интерфейс (по сути, то же, что ACP, но кастомное)

### Итоговая рекомендация

ACP **можно** использовать как унифицированный протокол для внешней оркестрации CLI-агентов, если:
- Все интересующие вас агенты поддерживают ACP (напрямую или через адаптер)
- Вы готовы к тому, что ACP — протокол для пары *один клиент ↔ один агент*
- Вам не нужна координация между агентами (для этого нужен A2A или свой слой)

Для сценария «хочу иметь возможность заменить одного агента на другого без переписывания» ACP решает эту задачу хорошо — именно для этого он и создавался, но в контексте редактора. Внешний оркестратор может выступать в роли ACP-клиента так же, как редактор.

---

## Источники

1. **Официальный сайт ACP**: https://agentclientprotocol.com/
2. **GitHub-репозиторий спецификации**: https://github.com/agentclientprotocol/agent-client-protocol
3. **Блог Zed об ACP**: https://zed.dev/acp
4. **Список ACP-агентов**: https://agentclientprotocol.com/get-started/agents
5. **Обновления протокола**: https://agentclientprotocol.com/updates
6. **ACP vs MCP (CircleCI)**: https://circleci.com/blog/acp-vs-mcp-whats-the-difference-for-agentic-coding/
7. **ACP vs MCP (MCP.Directory)**: https://mcp.directory/blog/agent-client-protocol-vs-mcp-2026
8. **ACP Registry (Zed Blog)**: https://zed.dev/blog/acp-registry
9. **Документация OpenCode ACP**: https://opencode.ai/docs/acp/
10. **OpenCode ACP реализация (GitHub)**: https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/acp/README.md
11. **OpenCode в реестре ACP (Zed)**: https://zed.dev/acp/agent/opencode
12. **Gemini CLI ACP (документация)**: https://geminicli.com/docs/cli/acp-mode/
13. **Gemini CLI ACP (GitHub)**: https://github.com/google-gemini/gemini-cli/blob/main/packages/cli/src/acp/acpClient.ts
14. **Claude Code ACP adapter**: https://github.com/zed-industries/claude-code-acp
15. **Codex CLI ACP adapter**: https://github.com/agentclientprotocol/codex-acp
16. **Issue Claude Code ACP (Anthropic, закрыто)**: https://github.com/anthropics/claude-code/issues/6686
17. **PR Aider ACP**: https://github.com/Aider-AI/aider/pull/4936
18. **Репозиторий JetBrains ACP**: https://github.com/jetbrains/agent-client-protocol
19. **ACP vs MCP vs A2A (casys.ai)**: https://casys.ai/blog/mcp-a2a-acp-agent-protocols
