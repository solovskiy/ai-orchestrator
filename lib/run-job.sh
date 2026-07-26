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
AGENT_JS="$LIB/agent.js"

jset() { node "$AGENT_JS" set "$JOB_DIR" "$@" >/dev/null 2>&1; }
jget() { node "$AGENT_JS" get "$JOB_DIR" "$1"; }

CWD="$(jget cwd)"
[[ -d "$CWD" ]] || CWD="."

# --- собрать argv через адаптер исполнителя (значения разделены NUL) ---
ARGS=()
while IFS= read -r -d '' item; do
  ARGS+=("$item")
done < <(node "$AGENT_JS" build-args "$JOB_DIR")

if (( ${#ARGS[@]} == 0 )); then
  jset status=failed exitCode=127 "error=не удалось собрать команду запуска"
  exit 127
fi

jset status=running "startedAt=$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# --- собственно агент: stdout -> JSONL, stderr отдельно ---
cd "$CWD" || true
"${ARGS[@]}" > "$JOB_DIR/out.jsonl" 2> "$JOB_DIR/stderr.log" &
CHILD=$!
jset "pid=$CHILD"
wait "$CHILD"
EXIT=$?

# --- разобрать поток, записать итог, извлечь result.md ---
node "$AGENT_JS" finalize "$JOB_DIR" "$EXIT" >/dev/null 2>&1

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
