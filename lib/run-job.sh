#!/usr/bin/env bash
# run-job.sh — обёртка, внутри которой реально живёт агент.
#
# Запускается отсоединённо (nohup) из bin/agent. Сама дописывает итог в
# job.json, поэтому статус задачи остаётся достоверным, даже если
# оркестратор (Claude Code) к этому моменту уже закрыт.
#
# set -e здесь НЕ используется намеренно: ненулевой код возврата агента —
# это нормальный исход, который нужно записать, а не повод падать.

set -uo pipefail

JOB_DIR="${1:?run-job.sh: не передан путь к задаче}"
LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# -a (absolute) обязателен — см. пояснение в bin/agent::winpath().
winpath() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -am "$1"; return; fi
  if command -v wslpath >/dev/null 2>&1; then wslpath -am "$1"; return; fi
  echo "$1"
}

NODE="${NODE:-$(command -v node)}"
NODE="${NODE:-$(command -v node.exe)}"
NODE="${NODE:-node}"

AGENT_JS="${AGENT_JS_WIN:-}"
if [[ -z "$AGENT_JS" ]]; then
  AGENT_JS="$(winpath "$LIB/agent.js")"
fi
JOB_DIR_WIN="$(winpath "$JOB_DIR")"

jset() { "$NODE" "$AGENT_JS" set "$JOB_DIR_WIN" "$@" >/dev/null 2>&1; }
jget() { "$NODE" "$AGENT_JS" get "$JOB_DIR_WIN" "$1"; }

CWD="$(jget cwd)"
[[ -d "$CWD" ]] || CWD="."

# --- собрать argv через адаптер исполнителя (значения разделены NUL) ---
ARGS=()
while IFS= read -r -d '' item; do
  ARGS+=("$item")
done < <("$NODE" "$AGENT_JS" build-args "$JOB_DIR_WIN")

if (( ${#ARGS[@]} == 0 )); then
  jset status=failed exitCode=127 "error=не удалось собрать команду запуска"
  exit 127
fi

jset status=running "startedAt=$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# --- снепшот git-status до старта (для фильтрации pre-existing файлов) ---
( cd "$CWD" && git status --porcelain 2>/dev/null ) > "$JOB_DIR/pre-status.txt" || true

# --- зафиксировать HEAD до старта, чтобы позже найти закоммиченные агентом изменения ---
START_COMMIT="$(cd "$CWD" && git rev-parse HEAD 2>/dev/null)" || true
[[ -n "$START_COMMIT" ]] && jset "startCommit=$START_COMMIT"

# --- собственно агент: stdout -> JSONL, stderr отдельно ---
cd "$CWD" || true
"${ARGS[@]}" > "$JOB_DIR/out.jsonl" 2> "$JOB_DIR/stderr.log" &
CHILD=$!
jset "pid=$CHILD"
wait "$CHILD"
EXIT=$?

# --- разобрать поток, записать итог, извлечь result.md ---
"$NODE" "$AGENT_JS" finalize "$JOB_DIR_WIN" "$EXIT" >/dev/null 2>&1

# --- авто-коммит незакоммиченных изменений в worktree-задачах ---
# Модель-исполнитель не всегда сама коммитит свою работу (замечено
# 2026-07-27 на задаче research-archive-cleanup: файлы перенесены и
# отредактированы, но `git commit` агент не сделал — verify видел
# только uncommitted diff, а последующий `git merge` показывал "Already
# up to date", пока коммит не сделали вручную). Раз worktree и так
# существует именно для review+merge оркестратором — надёжнее
# коммитить туда детерминированно здесь, а не полагаться на то, что
# модель не забудет. Для НЕ-worktree задач (обычно ресёрч прямо в
# основном репо) это осознанно не делается — коммит в основную ветку
# остаётся решением оркестратора, не автоматикой.
IS_WORKTREE="$(jget worktree)"
if [[ "$IS_WORKTREE" == "1" && -n "$(cd "$CWD" && git status --porcelain 2>/dev/null)" ]]; then
  MSG_FILE="$JOB_DIR/auto-commit-message.txt"
  {
    echo "agent: $(jget task) (авто-коміт наприкінці задачі)"
    echo
    if [[ -f "$JOB_DIR/result.md" ]]; then
      head -c 2000 "$JOB_DIR/result.md"
      echo
    fi
    echo
    echo "Job: $(jget id)"
    echo "Модель сама не закомітила зміни — закомічено обгорткою run-job.sh."
  } > "$MSG_FILE"
  if ( cd "$CWD" && git add -A && git commit -F "$MSG_FILE" ) >/dev/null 2>&1; then
    jset "autoCommitted=true"
  else
    jset "autoCommitted=false"
  fi
fi

# --- проверка: гоняется здесь, чтобы её вывод не попадал в контекст чата ---
VERIFY="$(jget verifyCmd)"
if [[ -n "$VERIFY" && "$VERIFY" != "null" ]]; then
  if (( EXIT != 0 )); then
    jset verifyStatus=skipped
  else
    jset verifyStatus=running
    ( cd "$CWD" && bash -c "$VERIFY" ) > "$JOB_DIR/verify.log" 2>&1
    VEXIT=$?
    if (( VEXIT == 0 )); then
      jset verifyStatus=passed "verifyExitCode=$VEXIT"
    else
      jset verifyStatus=failed "verifyExitCode=$VEXIT"
    fi
  fi
fi

jset "finishedAt=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
exit "$EXIT"
