# ТЗ: SaaS Фаза 0 — API v1 (0.2), telegram_groups (0.4), usage_daily (0.5)

Ты работаешь в своём git worktree репозитория online-chat (корень репозитория — твой cwd).
Все пути в этом ТЗ относительные. Не используй абсолютные пути к другим чек-аутам.

Контекст: подготовка к мультитенантной SaaS-платформе. План — `docs/saas-pivot-plan.md`,
раздел «9. Поэтапный план», Фаза 0. Ты реализуешь пункты 0.2, 0.4, 0.5. Пункты 0.1 (частично),
0.3, 0.6, 0.7 уже сделаны и закоммичены — их не трогать.

## Общие правила

- Перед правками прочитай: `docs/architecture.md`, `docs/api.md`, `docs/deployment.md`
  (особенно «Миграции» и ловушки), `backend/tests/conftest.py`, существующие роутеры
  в `backend/app/api/`, модели в `backend/app/models/`. Следуй стилю проекта
  (английские докстринги, структура, комментирование решений).
- Каждый пункт (A/B/C) — отдельным коммитом через git_commit с осмысленным сообщением
  (проект использует русские сообщения вида «fix: …»).
- Тесты обязательны на каждое изменение поведения. Запуск: `cd backend && python -m pytest -q`.
  ВЕСЬ существующий набор должен оставаться зелёным.
- Миграции Alembic: следующий свободный номер после `0013_add_topic_name_and_rating_requested_and_left_reminder.py`.
  Ловушка из deployment.md: для boolean-колонок с server_default использовать `sa.false()`/`sa.true()`,
  не `sa.text("0")`. Формат ревизий — как у существующих файлов в `backend/alembic/versions/`.
- НЕ трогать: WebSocket (`/ws/chat/{id}` остаётся без версии), ретрай 429 в
  `backend/app/telegram/bot.py` (сделан недавно, покрыт тестами), виджет, CORS, rate limiting
  (кроме пункта A.3 ниже).
- Решения ниже фиксированные — вопросов владельцу задать нельзя, следуй им.

## A. 0.2 — `/api/v1/*` + легаси-алиасы

Сейчас каждый роутер объявляет префикс `/api/<сегмент>` и включается в `main.py` как есть.
Задача: канонический путь становится `/api/v1/<...>`, старые `/api/<...>` остаются рабочими
алиасами (в браузерах живут закэшированные виджеты; снос алиасов — отдельная задача, не сейчас).

Фиксированный дизайн:

1. В роутерах префикс меняется с `/api/<сегмент>` на `/<сегмент>`:
   - `app/api/chats.py` → `prefix="/chats"`
   - `app/api/messages.py` → `prefix="/messages"`
   - `app/api/leads.py` → `prefix="/leads"`
   - `app/api/status.py` → `prefix="/status"`
   - `app/api/admin.py` → `prefix="/admin"`
   - `app/api/health.py` (если роутер там; фактически health-роутер лежит в `app/core/health.py` с `prefix="/api/health"`) → `prefix="/health"`
   - `app/api/widget_config.py` → `prefix="/widget-config"`
   Внутренние пути (`@router.get("/metrics")` и т.п.) не меняются.
2. В `backend/app/main.py` — единый помощник регистрации: каждый роутер включается дважды —
   с `prefix="/api/v1"` и с `prefix="/api"` (легаси-алиас). Чтобы не дублировать список,
   вынеси регистрацию в функцию, например `include_api_routers(app)` в новом модуле
   `backend/app/api/routing.py`. Её использует и `main.py`, и `backend/tests/conftest.py`
   (conftest собирает свой тестовый app без middleware — обнови его так, чтобы существующие
   тесты продолжали работать по тем же URL без правок в самих тестах).
3. Проверь `backend/app/core/rate_limit.py`: лимитер должен покрывать ОБА префикса.
   Если он матчит по `startswith("/api/")` — `/api/v1/*` покрыт автоматически, добавь
   тест-проверку. Если нет — поправь и покрой тестом.
4. НЕ трогать: `GET /health` (liveness без `/api`), `/telegram/webhook`, WebSocket, `/widget/*`, `/admin` (static mount).
5. Тесты: новый файл `backend/tests/test_api_versioning.py` — один и тот же сценарий работает
   и через `/api/v1/...`, и через `/api/...` (например `GET /api/v1/status` ≡ `GET /api/status`;
   и один POST-сценарий, например создание чата, по обоим префиксам). Обнови `docs/api.md`:
   канонический префикс `/api/v1`, легаси-алиасы `/api` отмечены как deprecated-алиасы.

## B. 0.4 — `telegram_groups` вместо env

ID форум-группы сейчас читается из env в `backend/app/telegram/settings.py`
(`TELEGRAM_FORUM_CHAT_ID`) и импортируется в десятке мест. Цель 0.4 — источник истины в БД:
таблица `telegram_groups` с одной строкой (водоворотовская группа); env остаётся только
bootstrap-сидом при первом старте. Подготовка к мультитенантности без переделки импорт-сайтов.

Фиксированный дизайн:

1. Миграция `0014_add_telegram_groups`:
   `telegram_groups(id BIGSERIAL PK, tg_chat_id BIGINT NOT NULL, is_forum BOOLEAN NOT NULL DEFAULT true, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`.
2. Модель `backend/app/models/telegram_group.py` в стиле остальных моделей.
3. Сервис `backend/app/services/telegram_group.py`: `async def ensure_forum_group() -> None`:
   - таблица пуста И env `TELEGRAM_FORUM_CHAT_ID` задан → вставить строку из env;
   - таблица пуста И env не задан → ERROR в лог, значение остаётся не заданным;
   - таблица непуста → env игнорируется;
   - в конце всегда: прочитать актуальное значение из БД и обновить кэш в
     `app.telegram.settings` — добавь туда функцию-сеттер (например `set_forum_chat_id(id: int)`),
     храни значение в модульной переменной, как сейчас. Все существующие
     `from app.telegram.settings import TELEGRAM_FORUM_CHAT_ID` продолжают работать без правок.
4. Вызов `ensure_forum_group()` — в lifespan (`backend/app/main.py`), сразу после создания
   shared-клиента и ДО запуска health-таска. БД вне request-контекста: используй `SessionLocal`
   из `app/database` (как это делает `app/core/health.py` для метрик). На старте при
   недоступной БД — залогировать ERROR, НЕ ронять приложение (health-таск потом покажет degraded).
5. Тесты: новый `backend/tests/test_telegram_group.py`:
   - пустая таблица + env → строка создаётся, кэш обновлён;
   - таблица непуста → env игнорируется, берётся значение из БД;
   - пустая таблица + env пуст → значение не задано (ошибка в лог).
   Внимание: conftest выставляет `TELEGRAM_FORUM_CHAT_ID` в env до импорта приложения — используй
   monkeypatch поверх этого, где нужно.
6. Обнови `docs/deployment.md`: в таблице env у `TELEGRAM_FORUM_CHAT_ID` пометка
   «bootstrap-сид: после первого старта источник истины — таблица telegram_groups».

## C. 0.5 — `usage_daily` + запись метрик

Для будущей тарификации (saas-pivot-plan.md §8): учёт потребления с первого дня,
задним числом не восстанавливается. Воркспейсов ещё нет — колонка `workspace_id` с дефолтом 1
(vodovorot станет workspace #1 в Фазе 1, план так и говорит).

1. Миграция `0015_add_usage_daily`:
   `usage_daily(id BIGSERIAL PK, workspace_id BIGINT NOT NULL DEFAULT 1, day DATE NOT NULL, metric TEXT NOT NULL, value BIGINT NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(workspace_id, day, metric))`.
2. Модель `backend/app/models/usage.py`.
3. Сервис `backend/app/services/usage.py`: `async def record_usage(db, metric: str, delta: int = 1) -> None` —
   upsert-инкремент на сегодняшний день (UTC): `INSERT … ON CONFLICT (workspace_id, day, metric) DO UPDATE
   SET value = usage_daily.value + EXCLUDED.value, updated_at = now()`. Через
   `sqlalchemy.dialects.postgresql.insert` + `on_conflict_do_update`; проверь, что работает и на
   SQLite (тесты). ВАЖНО: функция best-effort — ловит ВСЕ исключения внутри себя, логирует warning,
   никогда не роняет вызвавший эндпоинт (call-site остаётся чистым, без try/except).
4. Точки записи (минимальный набор метрик из §8 плана):
   - `dialogs_created` — создание НОВОГО чата в `backend/app/api/chats.py` (ветка «Genuinely new chat»,
     только когда реально создаётся новая запись Chat, не при возврате существующего).
   - `messages_incoming` — успешное сохранение сообщения посетителя в POST `/api/messages`
     (`backend/app/api/messages.py`).
   - `messages_outgoing` — настоящие ответы операторов в `backend/app/telegram/handler.py`
     (там, где обрабатывается сообщение оператора из топика). НЕ считать: auto-reply,
     сообщения с `is_automated`, системные/сервисные апдейты, редактирования.
   - `attachments_bytes` — POST `/api/messages/upload`, delta = фактический размер сохранённого
     файла в байтах.
   Запись — в той же транзакции/сессии, что и основная операция (у эндпоинтов есть db).
5. Видимость: добавь в `backend/app/api/admin.py` эндпоинт `GET /api/admin/usage?days=30`
   (параметр по умолчанию 30): сумма `value` по каждой метрике за последние N дней.
   Тесты в `backend/tests/test_usage.py`: два `record_usage` с одним метриком суммируются;
   `record_usage` с падающей сессией не бросает исключение; эндпоинт отдаёт агрегаты.
6. Обнови `docs/saas-pivot-plan.md`, раздел «9. Поэтапный план»: пометь 0.2/0.4/0.5 как
   сделанные (коротко, одна-две строки на пункт, с датой 2026-08-18).

## Приёмка

- `cd backend && python -m pytest -q` — весь набор зелёный.
- Три коммита (A, B, C) на твоей ветке.
- Финальный текст: что сделано, какие решения принял нестандартно, что НЕ сделано и почему.
