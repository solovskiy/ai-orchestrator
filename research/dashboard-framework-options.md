# Оценка готовых решений для дашборда мониторинга AI-агентов

> **Дата:** 2026-07-27
> **Контекст:** Node.js-бэкенд (`http.createServer`, без Express), клиент — один HTML-файл (vanilla JS), ~1200 строк кода. Данные — JSON-файлы на диске (`jobs/<id>/job.json`, `out.jsonl`, `result.md`).
> **Цель:** Понять, можно ли заменить/ускорить самописную реализацию готовым решением.

---

## Резюме (tl;dr)

Для проекта масштаба «2 файла, 1200 строк» **полная замена на готовый фреймворк не оправдана**. Ни один из рассмотренных вариантов не является «дроп-ин» заменой — все требуют существенной переделки либо бэкенда, либо фронтенда, либо обоих.

**Что реально стоит рассмотреть:**

| Решение | Тип вмешательства | Оценка усилий |
|---------|-------------------|---------------|
| **htmx + SSE** (вместо polling) | Минимальное (~50 строк бэкенда + 20 строк в HTML) | ⭐ S — день работы |
| **Alpine.js** (сохранение UI-стейта) | Минимальное (~добавить `<script src>`, обернуть данные в `x-data`) | ⭐ S — день работы |
| **xterm.js** (live log viewer) | Среднее (~добавить WebSocket/SSE endpoint, 30 строк вёрстки) | ⭐⭐ M — 2-3 дня |
| **Bull Board** (при миграции на BullMQ/Redis) | Полная переделка бэкенда | ⭐⭐⭐ L — недели |

**Что явно избыточно:** AdminJS, React-Admin, Appsmith, Budibase — это платформы для admin-панелей с БД, они несут на порядок больше, чем нужно, и требуют полного рефакторинга. Lit — требует сборки (TypeScript → JS), теряется простота «одного HTML-файла».

---

## 1. Bull Board / Bull-Arena — мониторинг очередей

### Bull Board (`@bull-board`)

- **Репозиторий:** [github.com/felixmosh/bull-board](https://github.com/felixmosh/bull-board) — 3.4k ⭐
- **Что делает:** Готовый дашборд для очередей Bull/BullMQ. Показывает jobs по статусам (waiting, active, completed, failed, delayed), детали джобы (data, stacktrace, attempts, progress), графики throughput, возможность retry/clean/remove.
- **Встраиваемость:** Монтируется как Express/Fastify/Koa/Hono/H3/Elysia middleware. Фронтенд — React, собирается внутри пакета, наружу отдаётся как статика.
- **Поддержка не-Redis бэкендов:** **Нет.** Bull Board жёстко завязан на Bull/BullMQ, которые работают **только с Redis**. Адаптеры (`BullAdapter`, `BullMQAdapter`) принимают инстансы очередей напрямую.

#### Оценка миграции с файловой системы на Redis

**Объём миграции:** ⭐⭐⭐ **L (Large — недели).**

Чтобы использовать Bull Board, необходимо:
1. Заменить всю файловую систему хранения джобов на Redis (поднять Redis-сервер).
2. Переписать весь код создания и управления задачами с `fs.readFile/writeFile` на BullMQ API (`Queue.add()`, `Job.updateProgress()`, обработку событий `completed`/`failed`).
3. Переписать логику запуска фоновых процессов — BullMQ использует модель worker'ов (отдельный процесс или поток), а не прямой spawn из Node.js.
4. Статусы BullMQ: waiting → active → completed/failed — нужно маппить на текущие `running`/`passed`/`failed`/`completed`.
5. Сохранение логов (`out.jsonl`, `stderr.log`) всё равно останется на диске, потому что Bull Board показывает только progress и stacktrace, а не произвольный streaming output.

**Плюсы миграции:**
- Получаешь готовую инспекцию очередей (retry, remove, pause, поиск по ID).
- Готовые графики пропускной способности (через `@bull-board/metrics`).
- Надёжное сохранение состояния (Redis persist) — при падении процесса задачи не теряются.

**Минусы:**
- Радикально меняет архитектуру проекта.
- Требует запуска и поддержки Redis.
- Всё ещё нужен кастомный код для рендера логов — Bull Board этого не умеет.
- Ломает текущую модель «запустил spawn — работает в том же процессе».

#### Bull-Arena (`bull-arena`)

- **Репозиторий:** [github.com/bee-queue/arena](https://github.com/bee-queue/arena) — 937 ⭐
- Аналог Bull Board, но старше и менее активно развивается. Тоже только Bull/BullMQ/Bee-Queue + Redis.
- Вывод тот же: требует полной миграции на Redis.

### Вердикт по Bull Board / Arena

> **«Переписывать половину проекта ради этого».** Дашборд выглядит похоже на то, что нам нужно, но цена входа — миграция всей очереди на Redis/BullMQ. Для проекта из 1200 строк это означает написать 800+ строк нового кода только ради того, чтобы получить красивый UI. **Не оправдано.**

---

## 2. Готовые admin-дашборд киты

### AdminJS (`adminjs`)

- **Репозиторий:** [github.com/SoftwareBrothers/adminjs](https://github.com/SoftwareBrothers/adminjs) — 9k ⭐
- **Что делает:** Автоматическая админка на основе моделей БД (как Django Admin). CRUD-интерфейс для любых ресурсов, кастомные экшены, дашборд с виджетами.
- **Интеграция с текущим бэкендом:** AdminJS требует ORM/ODM адаптер (TypeORM, Sequelize, Mongoose, Prisma). У нас нет БД — только JSON-файлы. Теоретически можно написать кастомный `Resource`, который читает `jobs/*/job.json` через `fs`, но:
  - Основной сценарий AdminJS — CRUD над записями БД, а не мониторинг в реальном времени.
  - Нет встроенного live-update/polling — страница статична, нужно вручную обновлять.
  - Виджеты дашборда — статические статы, не стриминг логов.
- **Express не требуется:** AdminJS работает с `http.createServer` через адаптер, но проще с Express.
- **Кривая внедрения:** ⭐⭐⭐ **L** — нужно переписывать модели данных под AdminJS-ресурсы, настраивать деплой, изучать API.

### React-Admin (`marmelab/react-admin`)

- **Репозиторий:** [github.com/marmelab/react-admin](https://github.com/marmelab/react-admin) — 27k ⭐
- **Что делает:** Фреймворк для SPA на React + Material UI. Data Provider — адаптер к любому REST/GraphQL API.
- **Интеграция:** Теоретически можно написать Data Provider, который ходит в наш JSON API (у нас уже есть эндпоинты `/api/jobs`, `/api/jobs/:id/log` и т.д.). Тогда React-Admin отобразит список задач как DataTable.
- **НО:**
  - Требует React-проекта со сборкой (Vite/Webpack), npm-зависимостями, JSX-транспиляцией. Это убивает «один HTML-файл».
  - React-Admin — это **26k звёзд и 5.5k форков** — масштаб «enterprise admin panel», не «одностраничный дашборд».
  - Для кастомизации под live-обновление (SSE/polling) и streaming-логи нужен глубокий кастом.
- **Кривая внедрения:** ⭐⭐⭐ **L** — требуется создание React-проекта с нуля.

### Appsmith

- **Репозиторий:** [github.com/appsmithorg/appsmith](https://github.com/appsmithorg/appsmith) — 40k ⭐
- **Что делает:** Low-code платформа для построения админок — drag-and-drop интерфейс, коннекторы к БД/API.
- **Интеграция:** Можно за 15 минут накидать дашборд поверх нашего JSON API (коннектор REST). Но:
  - Appsmith — это отдельный сервис (Java + React + MongoDB). Self-hosted требует Docker, 2-4 ГБ RAM.
  - Для проекта из 1200 строк — запускать отдельный сервис с Java и MongoDB **абсурдно**.
- **Кривая внедрения:** ⭐⭐⭐ **L** (инфраструктурно) + сложность поддержки ещё одного сервиса.

### Budibase

- **Репозиторий:** [github.com/Budibase/budibase](https://github.com/Budibase/budibase) — 28k ⭐
- Аналог Appsmith: low-code, Docker, своя БД. Те же проблемы — для нашего масштаба это танк вместо велосипеда.
- **Кривая внедрения:** ⭐⭐⭐ **L**.

### Вердикт по admin-китам

> **Все — «переписывать половину проекта» (а то и весь проект) ради этого.** Это платформы для построения сложных админок с десятками сущностей. Для дашборда с одной сущностью «задача» они несут избыточную сложность на порядок. **Ни один не подходит.**

---

## 3. Легковесные frontend-библиотеки

Это самая перспективная категория — улучшить существующий HTML без переписывания.

### htmx (14 KB min+gzip, без зависимостей)

- **Репозиторий:** [github.com/bigskysoftware/htmx](https://github.com/bigskysoftware/htmx) — 49k ⭐
- **Документация:** [htmx.org](https://htmx.org)
- **Концепция:** Расширяет HTML атрибутами (`hx-get`, `hx-post`, `hx-swap`, `hx-trigger`). AJAX без написания JS.
- **SSE extension:** [htmx.org/extensions/sse](https://htmx.org/extensions/sse/) — встроенная поддержка Server-Sent Events. Можно заменить polling на SSE: бэкенд шлёт `event: jobUpdate\ndata: <tr>...</tr>\n\n`, а htmx сам вставляет обновлённые строки в DOM.
  - `sse-connect="/api/events"` — подключение к EventSource.
  - `sse-swap="jobUpdate"` — автоматический swap новых данных в DOM.
  - Автоматический reconnect с exponential backoff.
- **Насколько легко встроить поверх существующего HTML:**
  - Добавить `<script src="...htmx.min.js">` и `<script src="...htmx-ext-sse.js">` — 2 строки.
  - Текущий polling `setInterval(() => fetch('/api/jobs').then(...))` заменить на `<tbody hx-ext="sse" sse-connect="/api/sse" sse-swap="jobs">`.
  - Бэкенд: добавить SSE endpoint (20-30 строк на `http.createServer` — установить `Content-Type: text/event-stream`, писать `data: ...\n\n` в `res`).
  - Вкладки, модалки — через `hx-get` + `hx-target`.
- **Что НЕ решает:** Сохранение UI-стейта (открытые вкладки, активный фильтр) между перерисовками — это либо через `hx-history` (восстановление по URL), либо через хранение в `localStorage`.
- **Кривая внедрения:** ⭐ **S — минимальная.** Самое близкое к «взять и легко встроить».

### Alpine.js (15 KB min+gzip)

- **Репозиторий:** [github.com/alpinejs/alpine](https://github.com/alpinejs/alpine) — 32k ⭐
- **Концепция:** «Vue-lite» — реактивность и директивы (`x-data`, `x-show`, `x-for`, `x-on`, `x-text`) прямо в HTML, без сборки.
- **Насколько легко встроить:**
  - `<script src="...alpine.min.js" defer>` — одна строка.
  - Можно обернуть существующий HTML в `<div x-data="dashboard()">`, вынести состояние в `Alpine.data('dashboard', () => ({ jobs: [], activeTab: 'list', ... }))`.
  - Заменить `innerHTML`-рендер на `x-for` и `x-text` — Alpine сам обновляет DOM при изменении данных.
  - Проблема «потери UI-стейта при перерисовке» решается: стейт живёт в Alpine-скоупе, перерисовка данных не сбрасывает вкладки/фильтры.
- **Что требует переделки:**
  - Нужно вынести логику из `fetch('/api/jobs').then(renderJobs)` в Alpine.data, а рендерить через шаблоны `x-for`.
  - Не заменяет polling/SSE — нужно оставить `setInterval` (или перейти на SSE + Alpine).
- **Кривая внедрения:** ⭐ **S — минимальная.** Хорошо ложится поверх существующего HTML.

### Petite-vue (6 KB)

- **Репозиторий:** [github.com/vuejs/petite-vue](https://github.com/vuejs/petite-vue) — 9.7k ⭐
- **Концепция:** Микро-версия Vue 3 (тот же синтаксис шаблонов, та же реактивность), специально для «посыпания» существующих HTML-страниц интерактивностью. В 2 раза меньше Alpine.
- **Насколько легко встроить:**
  - `<script src="...petite-vue" defer init>` — одна строка.
  - `v-scope`, `v-for`, `v-if` — как в обычном Vue.
  - Глобальное состояние через `reactive()`.
- **НО:** Проект в режиме «maintenance mode» — последние коммиты 2022-2023, issues отключены, новые фичи не принимаются. Evan You (автор Vue) заявил, что проект не будет активно развиваться.
- **Кривая внедрения:** ⭐ **S** — но с оговоркой: риск abandoned-проекта.

### Lit (5 KB)

- **Сайт:** [lit.dev](https://lit.dev)
- **Концепция:** Библиотека для создания Web Components на основе стандарта Custom Elements. Компилируемые шаблоны, Shadow DOM, реактивные свойства.
- **Насколько легко встроить:** **Требует сборки.** Lit использует декораторы TypeScript и tagged template literals; для продакшена нужен bundler (Rollup/Webpack) или хотя бы `tsc`. Нельзя просто «добавить `<script>`» к существующему HTML.
- **Проблема для нас:** Теряется главное преимущество — «один HTML-файл без сборки».
- **Кривая внедрения:** ⭐⭐ **M** — требует настройки сборочного процесса. Перебор для 1200 строк проекта.

### Вердикт по легковесным библиотекам

| Библиотека | Дроп-ин поверх HTML | Решает потерю UI-стейта | Замена polling на SSE | Риски |
|-----------|---------------------|------------------------|----------------------|-------|
| **htmx + SSE** | ✅ да | Частично (hx-history) | ✅ встроена в extension | Минимальные |
| **Alpine.js** | ✅ да | ✅ да | Требует ручной реализации SSE | Минимальные |
| **Petite-vue** | ✅ да | ✅ да | Требует ручной реализации SSE | ⚠️ abandoned |
| **Lit** | ❌ нужна сборка | ✅ да | Требует ручной реализации SSE | Средние |

> **Рекомендация: htmx + Alpine.js вместе.** htmx — для SSE и навигации, Alpine — для клиентского стейта (открытые вкладки, фильтры). Они совместимы: Alpine контролирует состояние внутри, htmx управляет обменом с сервером.

---

## 4. Live log viewer / streaming console output

### xterm.js

- **Репозиторий:** [github.com/xtermjs/xterm.js](https://github.com/xtermjs/xterm.js) — 21k ⭐
- **Что делает:** Полноценный эмулятор терминала в браузере. Поддерживает ANSI-escape коды (цвета, bold, прогресс-бары), curses-приложения (vim, tmux), unicode/emoji, опциональный GPU-рендер через WebGL.
- **Используется в:** VS Code, Hyper, Azure Cloud Shell, Portainer, Replit, Coder — сотни проектов.
- **Как встроить для просмотра логов:**
  ```js
  import { Terminal } from '@xterm/xterm';
  const term = new Terminal();
  term.open(document.getElementById('log-container'));
  term.write(logData); // ANSI-строка
  ```
- **Нужен WebSocket-бэкенд:** xterm.js сам не фетчит данные. Нужно:
  1. Создать WebSocket-сервер (или SSE endpoint).
  2. При открытии задачи — подключиться к WebSocket и стримить содержимое лог-файла + новые строки.
  3. xterm.js пишет данные в терминал через `term.write()`.
- **Плюсы:**
  - «Настоящий» терминал с ANSI-цветами (логи с цветным выводом выглядят отлично).
  - Встроенный поиск (`@xterm/addon-search`), fit-по-размеру (`@xterm/addon-fit`).
  - WebGL-рендер для больших объёмов логов.
  - Мгновенное узнавание интерфейса (все знают, как выглядит терминал).
- **Минусы:**
  - ~150 KB в сжатом виде (больше, чем весь наш HTML).
  - Нужен npm + сборка (ну или тянуть UMD-бандл с CDN — `xterm.js` есть на jsdelivr).
  - Не совсем «логи» — это полноценный эмулятор терминала, что может быть избыточно, если логи — просто текстовые строки без ANSI-escape.
- **Кривая внедрения:** ⭐⭐ **M** — нужно добавить WebSocket endpoint на бэкенде, terminal-контейнер на фронтенде. Дня 2-3 работы.

### Альтернативы попроще

Для случая «просто текстовые строки, без ANSI-escape»:

- **`<pre>` с автоскроллом + `fetch` + `appendChild`:** Текущий подход, можно улучшить:
  - Виртуальный скролл (рендерить только видимые строки) — для логов > 10000 строк.
  - `ResizeObserver` для автоскролла «прилипание к низу» (сейчас часто теряется).
- **`ansi-to-html`** (npm) + `<pre>`: Конвертация ANSI-escape в HTML— можно раскрасить логи без тяжёлого xterm.js.
- **`@xterm/headless`**: Серверная часть xterm.js для Node.js — можно держать состояние терминала на сервере и сериализовать через `@xterm/addon-serialize`.

### Вердикт по log viewer

> **xterm.js — «взять и встроить» с умеренными усилиями (M).** Это даст профессиональный вид терминала (цвета, поиск, автоскролл) ценой добавления WebSocket-стриминга и ~150 KB в бандле. Если логи без ANSI-escape — проще улучшить текущий `<pre>`-подход (виртуальный скролл + `ansi-to-html`), чем тащить xterm.js.

---

## 5. Итоговая рекомендация

### Для проекта масштаба «2 файла, 1200 строк»

**Ничего не менять глобально — усилить точечно:**

#### Рекомендуемый стек (минимальные усилия, максимальная выгода)

1. **htmx + SSE** — заменить polling на Server-Sent Events.
   - Бэкенд: добавить SSE endpoint на `GET /api/events` (30 строк кода на `http.createServer`).
   - Фронтенд: добавить `<script src="htmx.min.js">` + `<script src="htmx-ext-sse.js">`, заменить `<tbody>` на `hx-ext="sse" sse-connect="/api/events" sse-swap="jobs"`.
   - Эффект: мгновенные обновления вместо опроса раз в N секунд. Меньше запросов, меньше лага.

2. **Alpine.js** — для клиентского состояния (открытые вкладки, фильтры, сортировка).
   - `<script src="alpine.min.js" defer>` — одна строка.
   - Обернуть корневой элемент в `<div x-data="dashboard">`, определить `Alpine.data('dashboard', () => ({...}))` в отдельном `<script>`.
   - Эффект: перерисовка данных (через htmx или fetch) больше не сбрасывает открытую вкладку/фильтр.

3. **htmx + Alpine вместе:**
   - htmx отвечает за «как данные попадают на страницу» (SSE/AJAX).
   - Alpine отвечает за «что пользователь видит сейчас» (вкладки, скролл, фильтры).
   - Они не конфликтуют — Alpine работает внутри элемента, htmx меняет DOM снаружи.

#### Опционально (если есть время и желание)

4. **xterm.js** — замена самописного `<pre>` для просмотра логов.
   - Добавить WebSocket endpoint на `/ws/log/:jobId`.
   - Использовать `@xterm/xterm` + `@xterm/addon-fit` + `@xterm/addon-search`.
   - Усилия: 2-3 дня. Эффект: профессиональный terminal view с цветами, поиском, автоскроллом.

#### Что НЕ делать

- ❌ **Не переезжать на Redis/BullMQ ради Bull Board** — для 1200 строк это архитектурный overkill.
- ❌ **Не подключать AdminJS / React-Admin / Appsmith / Budibase** — это танк для перевозки одной коробки.
- ❌ **Не переписывать фронтенд на Lit/React/Vue SPA** — потеряется главное преимущество: один HTML-файл без сборки.
- ❌ **Не брать Petite-vue** — abandoned, нет смысла рисковать.

### Сравнительная таблица

| Вариант | Усилия | Сохраняет один HTML | Улучшает UX | Риски |
|---------|--------|--------------------|-------------|-------|
| htmx + SSE | S (1 день) | ✅ да | ✅ real-time | Минимальные |
| Alpine.js для стейта | S (1 день) | ✅ да | ✅ не теряются вкладки | Минимальные |
| htmx + Alpine вместе | S (1-2 дня) | ✅ да | ✅✅ оба эффекта | Минимальные |
| xterm.js для логов | M (2-3 дня) | ✅ да (CDN) | ✅ проф. терминал | ~150 KB веса |
| Bull Board + миграция на Redis | L (недели) | ❌ полная переделка | ✅ готовый UI | Зависимость от Redis |
| AdminJS/React-Admin | L (недели) | ❌ нужна сборка | ⚠️ избыточно | Сложность поддержки |
| Appsmith/Budibase | L (недели) | ❌ отдельный сервис | ⚠️ избыточно | Инфраструктура |
| Lit | M | ❌ нужна сборка | ✅ компоненты | Потеря простоты |

### Честный итог

> **«Остаться на vanilla + SSE + Alpine» — это не «сдаться и ничего не менять», а осознанный выбор в пользу простоты.** Для проекта такого размера выигрыш от готового фреймворка меньше, чем боль от интеграции. Улучшения через htmx (SSE вместо polling) и Alpine (сохранение стейта) дают 80% UX-выигрыша при 5% усилий — это правильный инженерный trade-off.

---

## Источники

1. Bull Board — [github.com/felixmosh/bull-board](https://github.com/felixmosh/bull-board), документация [felixmosh.github.io/bull-board](https://felixmosh.github.io/bull-board/)
2. Bull Arena — [github.com/bee-queue/arena](https://github.com/bee-queue/arena)
3. AdminJS — [github.com/SoftwareBrothers/adminjs](https://github.com/SoftwareBrothers/adminjs), [adminjs.co](https://adminjs.co)
4. React-Admin — [github.com/marmelab/react-admin](https://github.com/marmelab/react-admin), [marmelab.com/react-admin](https://marmelab.com/react-admin)
5. Appsmith — [github.com/appsmithorg/appsmith](https://github.com/appsmithorg/appsmith), [appsmith.com](https://www.appsmith.com)
6. Budibase — [github.com/Budibase/budibase](https://github.com/Budibase/budibase), [budibase.com](https://budibase.com)
7. htmx — [github.com/bigskysoftware/htmx](https://github.com/bigskysoftware/htmx), [htmx.org](https://htmx.org), [SSE extension](https://htmx.org/extensions/sse/)
8. Alpine.js — [github.com/alpinejs/alpine](https://github.com/alpinejs/alpine), [alpinejs.dev](https://alpinejs.dev)
9. Petite-vue — [github.com/vuejs/petite-vue](https://github.com/vuejs/petite-vue)
10. Lit — [lit.dev](https://lit.dev)
11. xterm.js — [github.com/xtermjs/xterm.js](https://github.com/xtermjs/xterm.js), [xtermjs.org](https://xtermjs.org/)
