# ТЗ: модуль crontab для mcp-server (aaPanel MCP)

## Контекст

`D:\work\vodovorot\mcp-server` — Go-проект (модуль `mcp_btpanel`), MCP-сервер для aaPanel
(203.168.179.18:10296), использует `github.com/mark3labs/mcp-go`. Аутентификация и HTTP —
через `utils.NewBTPanel(utils.GetBaseURL(), utils.GetApiToken())` и `bt.Request(path, params)`,
см. `modules/sites/sites.go` как образец паттерна (tool = `mcp.NewTool(...)`, handler =
`func(ctx, request) (*mcp.CallToolResult, error)`, регистрация в `main.go` в `registerTools`).

Сейчас в панели нет управления Cron-задачами (в aaPanel "计划任务" / Cron Jobs), только
sites, databases (mysql), email, docker, system. Нужно добавить модуль `crontab`.

## Задача

Создать `modules/crontab/crontab.go` по паттерну `modules/sites/sites.go` с четырьмя tools:

1. **`get_crontab_list`** — список задач.
   API aaPanel: `POST /crontab?action=GetCrontab` (без доп. параметров или с пустым body).
   Возвращает список задач с полями: id, name, type, where_hour, where_minute, status, sType, sBody, echo.

2. **`add_crontab`** — создать задачу.
   API: `POST /crontab?action=AddCrontab`.
   Параметры запроса: `name` (string, required), `type` (string, required — одно из:
   `minute-n`, `hour`, `day`, `week`, `month`), `where1` (string, required — число, интерпретация
   зависит от type, напр. для `day` — час запуска), `where2` (string, optional — минута, нужна
   для типов day/week/month), `sType` (string, required — `toShell` для shell-скрипта,
   есть и другие: toUrl, toPython и т.д., но реализовать только `toShell`), `sBody` (string,
   required — тело shell-команды).
   MCP tool должен принимать параметры: `name`, `type`, `hour` (where1), `minute` (where2,
   optional, default "0"), `shell_command` (sBody). `sType` фиксировать как `"toShell"`.

3. **`delete_crontab`** — удалить задачу.
   API: `POST /crontab?action=DelCrontab`, параметры: `id` (string, required).
   MCP tool: параметр `id` (string, required).

4. **`set_crontab_status`** — включить/выключить задачу.
   API: `POST /crontab?action=SetCrontabStatus` (в некоторых версиях — `cron_status` или
   `set_cron_status` — проверить оба варианта эндпоинта на реальном сервере через ручной
   тест curl/Postman-подобным запросом, если есть возможность; если нет — реализовать через
   `SetCrontabStatus` и оставить TODO-комментарий на случай 404).
   Параметры: `id` (string, required), `status` (string — `"1"` включить / `"0"` выключить).
   MCP tool: параметры `id`, `enabled` (bool) → мапить в `status: "1"/"0"`.

## Требования к коду

- Константы имён tools в верхней части файла (как `GetSitesList = "get_sites_list"`).
- Каждый tool — `mcp.NewTool(...)` с `mcp.WithDescription`, обязательные параметры —
  `mcp.Required()`.
- Хендлеры — `context.Context, mcp.CallToolRequest) (*mcp.CallToolResult, error)`,
  доставать параметры через `request.Params.Arguments["x"].(string)` с проверкой `ok`
  и понятной ошибкой при неверном типе (см. `AddSiteHandle`).
- Вызов `bt.Request("crontab?action=...", map[string]string{...})` — по аналогии с
  `bt.Request("site?action=AddSite", ...)`.
- Зарегистрировать все 4 tool/handler в `main.go`: импорт `mcp_btpanel/modules/crontab`,
  добавить `s.AddTool(crontab.GetCrontabListTool, crontab.GetCrontabListHandle)` и т.д.
  для всех четырёх.
- Собрать проект: `cd D:\work\vodovorot\mcp-server && go build -o ../mcp-server.exe .`
  должен пройти без ошибок (это и есть verify-команда).
- Не трогать существующие модули (sites, databases, email, docker, system) — только
  добавить новый файл + правки в `main.go`.
- Без комментариев на английском вперемешку — сохраняй стиль существующего кода
  (китайские комментарии в существующих файлах не нужно повторять, обычные короткие
  комментарии на русском/английском — по вкусу, но кратко).

## Как проверить результат (для ревью, не для агента)

После сборки владелец вручную протестирует `get_crontab_list` и `add_crontab` на реальном
сервере aaPanel через Claude Code (MCP tool call), т.к. агент не имеет доступа к живому
серверу и токену. Агенту достаточно добиться успешной компиляции и логической корректности
по документации https://docs.bt.cn/api/crontab/ и референсу
https://github.com/aaPanel/BaoTa/blob/master/class/crontab.py (структура параметров).
