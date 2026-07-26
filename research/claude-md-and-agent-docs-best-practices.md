# CLAUDE.md, AGENTS.md и организация agent-docs в репозитории

Дослідницький звіт. Дата: 2026-07-26.  
Джерела: офіційна документація Anthropic (code.claude.com/docs), репозиторії
GitHub (openai/codex, google-gemini/gemini-cli, josix/awesome-claude-md,
laravel/boost, anthropics/claude-plugins-official), agentskills.io.

---

## 1. Офіційні рекомендації Anthropic щодо CLAUDE.md

**Джерело:** [Claude Code — Memory and project instructions](https://code.claude.com/docs/en/memory)  
**Джерело:** [Best practices for Claude Code](https://code.claude.com/docs/en/best-practices)

### Розмір

> Target under 200 lines per CLAUDE.md file. Longer files consume more context
> and reduce adherence.

Офіційна рекомендація — **до 200 рядків на один CLAUDE.md**. Більші файли
споживають більше контекстного вікна і знижують adherence (модель рідше
виконує інструкції, бо важливі правила губляться в шумі).

Якщо інструкцій багато — Антропік радить:

- Винести частину в **path-scoped rules** (`.claude/rules/`) — вони
  завантажуються тільки коли Claude працює з файлами, що підпадають під glob
- Винести процедури в **skills** (`.claude/skills/`) — завантажуються
  тільки коли їх викликають явно або коли Claude визначає релевантність
- Використовувати **`@path/to/file` імпорти** — для організації, але
  важливо: імпортовані файли *теж* завантажуються в контекстне вікно при
  старті (це не ліниве завантаження, на відміну від rules/skills)

Команда `/doctor` (з версії 2.1.206) автоматично пропонує що вирізати
з CLAUDE.md: директорії, списки залежностей, архітектурні огляди — все,
що Claude може вивести сам з коду.

### Ієрархія та зони дії

CLAUDE.md може бути в кількох місцях (завантажуються від широкого до
вузького):

| Зона                 | Шлях                                                |
|----------------------|-----------------------------------------------------|
| Керована політика    | `/Library/Application Support/ClaudeCode/CLAUDE.md` |
| Користувач           | `~/.claude/CLAUDE.md`                               |
| Проєкт               | `./CLAUDE.md` або `./.claude/CLAUDE.md`             |
| Локальний            | `./CLAUDE.local.md` (додати в .gitignore)           |

Claude Code проходить від кореня файлової системи вниз до робочої
директорії, збираючи всі CLAUDE.md файли на шляху — вони
**конкатенуються**, не перевизначаються. У піддиректоріях CLAUDE.md
завантажуються ліниво (коли Claude читає файли в тій директорії).

### @import синтаксис

```markdown
See @README.md for overview and @package.json for npm commands.
- Git workflow: @docs/git-instructions.md
- Personal: @~/.claude/my-project-instructions.md
```

- Відносні шляхи резолвяться відносно файлу, що імпортує, а не CWD
- Максимум 4 рівні вкладеності імпортів
- Зовнішні імпорти (ті, що ведуть за межі робочої директорії) при першому
  запуску показують діалог підтвердження (захист від зловмисного коду)
- Імпорти в `~/.claude/CLAUDE.md` завантажуються без діалогу

### CLAUDE.md у монорепозиторіях

Офіційний підхід ([Large codebases](https://code.claude.com/docs/en/large-codebases)):

- **Кореневий CLAUDE.md**: загальні для всього репо правила
- **Per-directory CLAUDE.md**: специфічні для пакету/підсистеми
- **claudeMdExcludes**: виключення чужих CLAUDE.md у монорепо через glob
- **Path-scoped rules**: альтернатива per-directory CLAUDE.md — все в
  `.claude/rules/` з frontmatter `paths:`

### CLAUDE.md — це контекст, не конфігурація

CLAUDE.md подається як user message після system prompt. Це не жорстке
правило — модель може його проігнорувати. Для гарантованого виконання —
**hooks** (PreToolUse, PostToolUse, Stop).

---

## 2. AGENTS.md — відкритий стандарт чи ні?

**Джерело:** [Claude Code docs — AGENTS.md](https://code.claude.com/docs/en/memory#agents-md)  
**Джерело:** [OpenAI Codex — AGENTS.md](https://github.com/openai/codex/blob/main/AGENTS.md)  
**Джерело:** [agentskills.io](https://agentskills.io)

### Хто підтримує AGENTS.md

Станом на липень 2026:

- **OpenAI Codex** — читає `AGENTS.md` (корінь репо). Також читає
  `.agents/skills/` для навичок. Це основний конфігураційний файл Codex.
- **Gemini CLI** — не читає `AGENTS.md` напряму; використовує `GEMINI.md`
  для контексту. Але підтримує `.agents/skills/` як **alias** для
  `.gemini/skills/` (явно заявлено як інтероперабельний шлях).
- **Claude Code** — офіційно: "Claude Code reads CLAUDE.md, not AGENTS.md"

### Як не дублювати між CLAUDE.md і AGENTS.md

Якщо репозиторій має AGENTS.md для інших агентів, Anthropic радить:

**Варіант 1 — імпорт:** створити CLAUDE.md з одним рядком:
```markdown
@AGENTS.md

## Claude Code
(тут Claude-специфічні інструкції, якщо потрібно)
```

**Варіант 2 — symlink** (macOS/Linux):
```bash
ln -s AGENTS.md CLAUDE.md
```
На Windows symlink потребує прав адміністратора або Developer Mode, тому
Anthropic радить саме `@AGENTS.md` імпорт.

### Чи варто мати обидва файли одночасно?

- Якщо ви використовуєте тільки Claude Code — достатньо `CLAUDE.md`
- Якщо в команді користуються і Claude Code, і Codex — тримайте
  `AGENTS.md` як канонічний, а `CLAUDE.md` нехай імпортує його через
  `@AGENTS.md`
- Skills (Agent Skills стандарт) — спільний формат для обох

### Agent Skills — реальний відкритий стандарт

Формат Agent Skills (SKILL.md + папка з ресурсами) — це відкритий
стандарт, створений Anthropic і підтриманий широким колом інструментів:
Claude Code, OpenAI Codex, Gemini CLI, Cursor, OpenHands, VS Code
(Copilot), JetBrains Junie, Goose (Block), Spring AI та інші.

Сайт стандарту: https://agentskills.io

---

## 3. Патерни організації agent-docs у реальних репозиторіях

### 3.1 laravel/boost (3.5k зірок)

**Посилання:** https://github.com/laravel/boost

Структура з `.ai/` папкою:

```
.ai/
  rules/
    laravel.md    # правила для AI-агентів
  agents/
    ...           # визначення субагентів
```

Цікаво, що Laravel Boost — це MCP-сервер для AI-асистованої розробки,
а папка `.ai/` використовується для інструкцій самим агентам.

### 3.2 josix/awesome-claude-md (523 зірки)

**Посилання:** https://github.com/josix/awesome-claude-md

Містить і `CLAUDE.md`, і `AGENTS.md` в корені. Також є `.claude/`
директорія. Це curated-колекція прикладів CLAUDE.md з відкритих проєктів.

### 3.3 openai/codex (102k зірок)

**Посилання:** https://github.com/openai/codex

Структура:

```
AGENTS.md              # основний конфіг агента
.codex/                # конфігурація Codex
.agents/skills/        # навички (Agent Skills стандарт)
```

AGENTS.md містить конвенції коду, правила code review, інструкції
з тестування — але тільки для цього конкретного репозиторію (Codex CLI).

### 3.4 anthropics/claude-plugins-official (32.7k зірок)

**Посилання:** https://github.com/anthropics/claude-plugins-official

Канонічна структура плагіна Claude Code:

```
plugin-name/
  .claude-plugin/
    plugin.json
  .mcp.json
  commands/         # слеш-команди
  agents/           # визначення субагентів
  skills/           # навички
  README.md
```

Хоча це структура плагіна, а не репозиторію, вона показує рекомендований
Anthropic підхід до організації agent-файлів.

### Узагальнення патернів

| Підхід                                  | Хто використовує                                |
|-----------------------------------------|-------------------------------------------------|
| `./CLAUDE.md` + `./.claude/`            | Більшість проєктів з Claude Code                |
| `./AGENTS.md` + `./.agents/skills/`     | Codex-сумісні проєкти                           |
| `./GEMINI.md` + `./.gemini/skills/`     | Gemini CLI                                      |
| `./.ai/` папка                          | Laravel Boost (AI-контекст для агентів)         |
| `./.claude/rules/`                      | Модульні правила Claude Code                    |
| `./.claude/agents/` + `~/.claude/agents/` | Субагенти Claude Code (проєктні + особисті)    |

---

## 4. Як уникати дублювання інструкцій між кількома репозиторіями

### Офіційні механізми Claude Code

1. **`@path` імпорт у CLAUDE.md**:
   - `@~/.claude/shared-rules.md` — імпорт з домашньої директорії
   - `@../.ai/docs/workflow.md` — відносний шлях (резолвиться від файлу,
     не від CWD)
   - `@/absolute/path/to/rules.md` — абсолютний шлях
   - Зовнішні імпорти (за межі робочої директорії) вимагають одноразового
     підтвердження через діалог

2. **Symlinks у `.claude/rules/`**:
   ```bash
   ln -s ~/shared-claude-rules .claude/rules/shared
   ```
   Офіційно підтримується, включаючи циркулярні symlinks.

3. **`--add-dir` + `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`**:
   Дозволяє завантажити CLAUDE.md з іншої директорії, але вимагає
   явного налаштування.

4. **Організаційний CLAUDE.md** (managed policy):
   Для всіх користувачів на машині — через MDM/Ansible.

### Який варіант підходить для .ai → erp_core/plumb_tools

У вашій поточній архітектурі `.ai` — окремий репозиторій, а
`erp_core`/`plumb_tools` — незалежні репозиторії (без git submodule).

**Поточний підхід** (абсолютний шлях у CLAUDE.md):
```markdown
@D:/work/vodovorot/.ai/docs/workflow.md
```
- **Плюс**: просто, не вимагає submodule
- **Мінус**: прив'язка до абсолютного шляху, залежність від структури дисків

**Альтернативи:**

| Варіант                            | Оцінка                                      |
|------------------------------------|---------------------------------------------|
| git submodule `.ai` → `@../.ai/docs/workflow.md` | Найкращий для версіонування, але додає складність |
| git submodule `.ai` → symlink `.claude/rules/ai` | Чистіший за імпорт, але Windows-обмеження  |
| `@~/.ai/docs/workflow.md`          | Працює, якщо .ai клоновано в домашню директорію |
| Лишити абсолютний шлях             | Робочий варіант, якщо структура дисків стабільна |
| Plugin (`.claude-plugin/`)         | Ідеальний для розповсюдження, але overkill для внутрішніх інструментів |

**Рекомендація**: git submodule + відносний `@../.ai/docs/workflow.md`
імпорт — це стандартний підхід, який працює з Git worktree і
не прив'язаний до абсолютних шляхів. Якщо submodule небажаний —
абсолютний шлях або `~/.ai/...` як fallback.

### З community

У [awesome-claude-md](https://github.com/josix/awesome-claude-md) зібрано
шаблони, де спільні інструкції часто виносять в `~/.claude/CLAUDE.md`
(користувацький рівень) або в `~/.claude/rules/` — це дає змогу мати
єдиний набір правил для всіх проєктів без дублювання.

---

## 5. Рішуче дерево: коли делегувати задачу зовнішньому агенту

**Джерело:** [Claude Code — Best practices](https://code.claude.com/docs/en/best-practices)  
**Джерело:** [Claude Code — Sub-agents](https://code.claude.com/docs/en/sub-agents)  
**Джерело:** [Claude Code CLI reference — Delegation patterns](https://code.claude.com/docs/en/common-workflows)

### Фундаментальний принцип: контекстне вікно — головний обмежувач

Кожне читання файлу, результат команди, повідомлення — споживають
контекст. Делегування дозволяє винести дослідження в окреме контекстне
вікно, зберігаючи основне для реалізації.

### Критерії делегування (офіційні + практика спільноти)

**КОЛИ ДЕЛЕГУВАТИ (Use subagents / external agents):**

| Критерій                                  | Чому                                           |
|-------------------------------------------|------------------------------------------------|
| Задача вимагає читання 10+ файлів         | Результати пошуку не засмічують основний контекст |
| Дослідження перед імплементацією          | Subagent-Explorer читає код, повертає резюме   |
| Незалежна підзадача (review, security)    | Може працювати паралельно в ізольованому контексті |
| Потрібна верифікація «свіжим поглядом»   | Subagent не бачив історії основної сесії        |
| Код review / перевірка на edge cases      | Writer/Reviewer патерн з двома агентами         |
| План перед великою зміною                 | Plan mode → викласти план → реалізувати         |
| Дешева модель для рутинних задач          | Haiku для пошуку, Sonnet/Opus для реалізації    |

**КОЛИ НЕ ДЕЛЕГУВАТИ:**

| Ситуація                                | Чому                                          |
|-----------------------------------------|-----------------------------------------------|
| Зміна в 1-2 файлах з очевидним рішенням | Оверхед делегування більший за користь         |
| Критична послідовність рішень           | Краще в одному контексті, щоб не втратити логіку |
| Задача вимагає знання повної історії    | Subagent не має доступу до історії основної сесії |
| Типова помилка, виправлення             | "Just do it" — прямий запит                    |

### Вбудовані типи субагентів (Claude Code)

- **Explore**: тільки читання (Read, Grep, Glob), для пошуку і
  дослідження кодової бази
- **Plan**: тільки читання, для планування (plan mode)
- **General-purpose**: читання + запис, для складних багатокрокових задач

Усі підтримують рівень effort: quick, medium, very thorough.

### Для CLI-інструментів (opencode, gemini, codex)

У opencode є власний `agent` tool:
```
agent: Run sub-tasks with the AI agent
  prompt (required)
```

Патерн той самий: делегувати підзадачі через agent tool, коли це
економить контекст основної сесії.

### Підсумкове дерево рішень

```
Чи читає задача >10 файлів (дослідження)?
  ├─ Так → делегуй (Explore agent / subagent)
  └─ Ні → чи можна сформулювати рішення в 1 реченні?
           ├─ Так → не делегуй, роби сам (main context)
           └─ Ні → чи задача незалежна від поточної історії?
                    ├─ Так → делегуй окремим агентом
                    └─ Ні → роби сам, але використовуй plan mode
```

---

## 6. Рекомендації для нашого кейсу

1. **Централізувати спільні інструкції** в `.ai/docs/workflow.md` (або
   `.ai/docs/agent-rules.md`) — і використовувати `@path` імпорт у
   кожному проєктному CLAUDE.md. Дотримуватись ліміту <200 рядків на
   CLAUDE.md, виносячи деталі в `.claude/rules/`.

2. **У кожному проєктному CLAUDE.md залишити тільки**: (а) специфічні
   для проєкту команди (build, test, migrate), (б) структуру директорій,
   (в) посилання `@../.ai/docs/workflow.md` (якщо submodule) або
   `@/шлях/.ai/docs/workflow.md` (якщо ні).

3. **Розглянути git submodule для `.ai`** — це дасть змогу
   використовувати відносні шляхи `@../.ai/docs/...` і гарантує
   версіонування інструкцій разом з кодом.

4. **Створити AGENTS.md тільки якщо плануєте використовувати Codex**
   або інші агенти, які його читають. Якщо тільки Claude Code — він
   не потрібен.

5. **Використовувати `.claude/rules/`** для модульних правил
   (окремо style, testing, git-workflow) замість монолітного CLAUDE.md.

6. **Для делегування** — сформулювати в CLAUDE.md коротке правило:
   "Use Explore subagent for investigation that reads >10 files. Delegate
   independent subtasks (security review, test writing) to General-purpose
   subagent. Use plan mode for multi-file changes."

7. **Не дублювати** критерії NEVER/ASK/ALWAYS у кожному проєкті —
   централізувати в `.ai/docs/workflow.md` і підтягувати через `@import`.

8. **Розглянути плагін `.ai/`** як `.claude-plugin/` — якщо
   інструмент використовується в багатьох проєктах, це найчистіше
   рішення (але може бути overkill для поточної стадії).
