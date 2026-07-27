# Идеи и задачи на будущее

Накоплено по итогам тестового прогона 2026-07-27 (v3 agents).

## ⚠️ Тесты (критично)

### test/deploy-agent.test.js
JSON → YAML генерация. Покрыть: все поля frontmatter, permissions как
вложенный объект, пустой systemPrompt, кастомные поля variant/worktree.

### test/agent-crud.test.js
agent list/show/create/delete. Покрыть: чтение несуществующего агента (404),
создание с невалидным именем, удаление защищённых агентов.

### test/dashboard-api.test.js
`/api/jobs`, `/api/stats`, `/api/agents`, `/api/models`. Покрыть: фильтрация,
сортировка, 404 на несуществующую задачу, CRUD агентов.

## 🔶 Dashboard (удобство)

### Пагинация в таблице задач
Сейчас 41 задача — таблица растёт. Добавить `?limit=50&offset=0` в API и
кнопки «← newer / older →» в UI. На сервере: параметры запроса, на клиенте:
состояние страницы.

### Кнопка «Удалить задачу» в дашборде
Сейчас удаление — только через CLI (`agent clean`). Добавить кнопку в detail-панели
и подтверждение. API: `DELETE /api/jobs/:id`.

### Кнопка «Убить задачу» (kill) в дашборде
Нельзя остановить зависшую задачу из UI. API: `POST /api/jobs/:id/kill`.

### Статистика по agent вместо worktree-прокси
`byCapability` в `/api/stats` определяет тип через `j.worktree` (coding/research).
С v3 в job.json есть поле `agent` — переключить на него. Позволит считать
статистику по каждому агенту отдельно, а не только по двум категориям.

### verifyStatus для research — показывать «не требуется»
Сейчас `verifyStatus: null` у research → UI показывает `---`. Лучше писать
«не требуется» когда verifyCmd отсутствовал.

### Авто-деплой агента при сохранении в дашборде
Сейчас Save → только JSON. Добавить вызов `deploy-agent.js` после сохранения,
чтобы `.opencode/agents/<name>.md` обновлялся сразу.

## 🔹 Мелкие оптимизации

### Системный промпт coding — упомянуть авто-коммит
Модель пишет «не закоммитил, не было инструкций», хотя `run-job.sh` спасает.
Добавить в `agents/coding.json` systemPrompt: «Changes are auto-committed
by the wrapper after you finish, but prefer to commit your own changes
with descriptive messages during the session.»

### Deploy-agent — проверка freshness
Каждый `delegate` вызывает deploy-agent заново, даже если агент не менялся.
Добавить проверку: если `.opencode/agents/<name>.md` новее чем
`agents/<name>.json` — пропустить генерацию.

### Путаница bin/agent vs .ai/bin/agent
Изнутри `.ai` нужно `bin/agent`, из родительского репо — `.ai/bin/agent`.
Документация везде пишет `.ai/bin/agent`. Не критично, но можно добавить
автоопределение в CLI: если `$PWD` уже внутри `.ai` — использовать `bin/agent`.

## 💡 Крупные фичи (на подумать)

### Вкладка «Memory» в дашборде
Просмотр и редактирование `memory/index.json` через UI. Сейчас только CLI
(`remember`/`recall`/`forget`).

### Health dashboard — мониторинг агентов
График успешности по дням, топ ошибок, среднее время выполнения.
Сейчас `/api/stats` даёт сырые агрегаты — можно визуализировать.

### WebSocket вместо polling
Сейчас дашборд опрашивает `/api/jobs` каждые 5 секунд. WebSocket дал бы
мгновенные обновления. Но требует переработки сервера (сейчас чистый HTTP).

### ACP-адаптер (исследовать позже)
Agent Client Protocol мог бы стать одним адаптером на всех исполнителей.
Сейчас отложено намеренно (см. `research/acp.md`).

---

*Последнее обновление: 2026-07-27*
