# .ai — CLI Agent Orchestration

A toolchain for delegating tasks to coding AI agents. Claude Code acts as the
orchestrator, with external CLIs as executors (currently `opencode`).

The folder is self-contained: no paths point outside, state lives inside. The
directory can be copied to another machine in its entirety.

This file covers "how" (commands, `--verify`, writing specs). "When and what" to
delegate (research vs. coding criteria, NEVER/ASK/ALWAYS, hung-task
troubleshooting) — [`docs/workflow.md`](docs/workflow.md).

## Requirements

- **Git Bash** (or any bash) — launcher
- **node** — JSON parsing (jq not needed)
- **opencode** in `PATH` — default executor

No WSL or tmux required. More on why in the "Why No tmux" section.

### Authentication (API keys)

This repository never stores API keys — it only holds `agents/*.json`
(model names, no credentials). Keys live in `opencode`'s own config,
outside this repo entirely:

```bash
opencode auth login      # interactive: pick a provider, paste your key
opencode auth list       # see what's already configured
```

The default free model (`opencode/deepseek-v4-flash-free`, OpenCode Zen)
needs no login at all. Paid providers (OpenRouter, etc.) need `auth login`
once per machine — after that, every project using this `.ai` install picks
it up automatically, nothing project-specific to configure. Never paste a
raw key into a prompt, a committed file, or a Claude Code permission
allowlist (`.claude/settings.local.json`) — that file is gitignored but
still plaintext on disk; `opencode auth` keeps it out of this repo's reach
entirely.

## Installation

Clone **once per machine**, to any location — not into each project.
`--repo <path>` on `delegate`/`start` points to the target project separately,
so a single `.ai` serves any number of projects on that machine.

```bash
git clone <this-repo-url> ~/tools/ai   # any path, doesn't have to be inside a project
~/tools/ai/bin/agent init
```

`init` does two things:
1. Installs the `agent-bridge` skill into `~/.claude/skills/agent-bridge/` —
   Claude Code picks it up in any project on this machine without editing
   CLAUDE.md. The absolute path to `.ai` (`~/tools/ai` from the example above)
   is already baked into the commands inside the installed skill — Claude
   doesn't have to guess it or spend calls searching for it.
2. Deploys all `agents/*.json` into `~/.config/opencode/agents/` — otherwise
   `opencode` won't find an agent by name outside of `.ai` itself.

Done — in any other Claude Code session on this machine,
`.ai/bin/agent agent list` / `delegate` works with no additional setup.
After editing `agents/*.json` (manually or via the dashboard), step 2 must
be repeated — `agent init` (auto-redeploy on save is not yet implemented,
see `docs/ideas.md`).

Optionally — the extended delegation criteria (`docs/workflow.md`) can be
included in a specific project's `CLAUDE.md` with the line
`@~/tools/ai/docs/workflow.md` (path — wherever `.ai` was cloned);
without this step, delegation still works, just without the
NEVER/ASK/ALWAYS checklist in the default context.

### Windows: local MCP commands must be wrapped in `cmd /c`

`~/.config/opencode/opencode.json` (global, machine-specific, NOT in this
git repository) — all local MCP servers installed via npm must use
`cmd /c` as the command wrapper on Windows, otherwise `spawn()` fails with
`ENOENT` (npm `.cmd` shims are not resolved without a shell). opencode does
not crash immediately — it hangs without a single line of output.

Correct config (one-time manual step when setting up `.ai` on a new Windows
machine — NOT something committed to this repo):

```json
{
  "mcp": {
    "browser-bot": {
      "type": "local",
      "command": ["cmd", "/c", "browser-bot-mcp"],
      "enabled": true
    },
    "agent-browser": {
      "type": "local",
      "command": ["cmd", "/c", "agent-browser mcp --tools core,debug,react"],
      "enabled": true
    }
  }
}
```

## Quick Start

The recommended entry point — `delegate`: one call instead of
`start`→`wait`→`result`, capability instead of a model name. Always run as a
background Bash (`run_in_background: true`) — the harness itself will send a
completion notification.

```bash
# --agent coding substitutes model/worktree from agents/coding.json —
# don't memorize the concrete model; it's configured in the dashboard/JSON
# and can change; the current one — `agent agent show coding` (see "Capability / Agent" below).
# --verify should set up the environment itself, otherwise the first run in a fresh
# worktree is guaranteed to fail on "Cannot find module" across the whole
# project, not just the agent's files (see "Before --verify" below).
.ai/bin/agent delegate \
  --task rozetka-ui \
  --repo /d/work/vodovorot/server/erp_core \
  --agent coding \
  --verify "npm install --prefer-offline --no-audit --no-fund && npm run typecheck && npm test" \
  --prompt-file tz.md

# view all tasks
.ai/bin/agent list

# details of one
.ai/bin/agent status rozetka-ui-20260726-140000
```

`delegate` already prints the agent's final answer at the end — a separate
`result` is not needed, but remains available for spot-checking a task launched
earlier.

The lower level (`start`+`wait`+`heal` individually) hasn't gone anywhere —
needed when you want to launch multiple tasks in parallel without waiting for
each one to finish in a single call.

## Commands

| Command | Purpose |
|---|---|
| `delegate` | **recommended entry point**: start + wait + (if needed) heal + result in one call |
| `start` | launch a task in the background (returns immediately, no waiting) |
| `chat` | interactive chat with the model in the terminal (foreground, not background); requires `--model` |
| `send <id> "<text>"` | continue a session with a new task |
| `list` | table of all tasks: model, status, check, time, cost |
| `stats [--days N] [--json]` | cost and token aggregation: total / by model / by capability |
| `status <id>` | task details; on check failure — tail of `verify.log`; shows `autoCommitted`, `changedFiles`, `diagnosis` |
| `tail <id> [n]` | last lines of agent output |
| `wait <id>...` | wait for task(s) to finish; run in background — provides notification (see `docs/workflow.md`) |
| `result <id>` | final answer only |
| `kill <id>` | stop |
| `heal <id>` | one-shot auto-recovery of a failed task (`validation_error`/`abandoned`) — sends a structured message into the session (see `diagnosis.json`, `outcome` field); `delegate` calls this automatically |
| `worktree-gc` | safe cleanup of worktree branches (only clean + merged); without `--apply` — dry-run |
| `clean [--days N]` | remove tasks older than N days (default 7) |
| `remember <key> "<value>"` | store a fact in long-term memory |
| `recall [<pattern>]` | find facts by key/tag/value |
| `forget <key>` | delete a fact |
| `learn <jobId>` | extract knowledge from a completed task's result |

`delegate` flags: `--timeout <sec>` (default 1800), `--no-heal` (don't attempt
recovery on failure).

`start` flags: `--max-parallel <N>` / env var `AGENT_MAX_PARALLEL`
(default 3) — limit on concurrently running tasks. `--force` launches
above the limit.

Also see `agent dashboard` — a local web UI for viewing tasks, statistics,
and configuring agents (opens in a browser at localhost:9191).

Full option list — `agent --help`.

## Capability / Agent

`--agent <name>` (or `--capability` for backward compatibility) on `start`
and `delegate` substitutes model/worktree/variant/permissions/systemPrompt
from `agents/<name>.json` — `.ai`'s canonical JSON format.

The agent roster is not fixed in this README and is not hardcoded — it grows
(as of 2026-08-06: `research`, `research-code`, `browser`, `testing`,
`coding`, `coding-cheap`, `copywriter`); the current list with
model/worktree/tools — a command, not a table:

```bash
.ai/bin/agent agent list          # name, model, worktree yes/no, tools
.ai/bin/agent agent show <name>   # full JSON, including description —
                                   # explicitly says when to pick a neighboring agent
.ai/bin/agent agent create <name> # create a new agent (scaffold in agents/<name>.json)
```

### Browser agents (two independent, do not confuse)

Two agents provide browser access through different MCP servers for different
use cases. Both are `worktree: false` — read the project, write a report,
never touch code or git.

| Agent | MCP server | Browser | Port | For |
|---|---|---|---|---|
| `browser` | `browser-bot` (Real Browser MCP) | User's personal Chrome (profile `chrome-bot-profile`, saved logins) | ws://9333 | Visiting sites "as yourself" — forms, comments, data behind login |
| `testing` | `agent-browser` (vercel-labs) | Headless Chromium (self-installed, self-launched, zero relation to personal browser) | none | Dev/frontend checks: start server → open → screenshot/snapshot → close |

Each now has an explicit `"mcp": [...]` field in its JSON — exactly one
server. `deploy-agent.js` converts it to `tools:` globs that opencode
actually understands (the `mcp` field in opencode markdown frontmatter is
silently ignored — `lib/deploy-agent.js` reads known MCP servers from
`~/.config/opencode/opencode.json`, generates `tools:` with allow for the
listed server and deny for every other known server). Before this fix,
`browser` could see all MCP servers including `agent-browser` — an
accidental mix-up.

The `agent-browser` MCP server has a cold-start hang on Windows: when the
daemon is not yet running, the first MCP tool call spawns a child CLI
process — on Windows this hits a handle-inheritance bug (upstream
`vercel-labs/agent-browser#1408`, open PR at time of writing) where the
daemon process keeps a duplicate of the MCP layer's stdout pipe open
forever, so `read_to_end()` never sees EOF. Workaround in `lib/run-job.sh`:
the CLI `agent-browser open about:blank` is called before starting the
agent (wrapped in `timeout 30 ... || true`) — this warms up the session so
the daemon is already alive when the MCP layer touches it. Cold MCP:
infinite hang. Warm MCP: ~60ms. The same call through bare CLI works fine
(2-4s) — no intermediate pipe reading there.

Agent-browser sessions are isolated per job via
`AGENT_BROWSER_SESSION=$(basename "$JOB_DIR")` in `run-job.sh` — without
this, parallel tasks share one daemon and fight over it, and an orphaned
process from a previous task hangs the next one on a dead CDP connection.

General rule about `worktree` (independent of the specific name): `no` —
agent only reads and writes a report, `--repo` can be any folder;
`yes` — agent commits to its own branch, `--repo` must be a
git repository (otherwise `start` fails with "not a git repository: `<path>`"
before the model even launches).

`agent init` generates opencode-compatible `.md` files in
`~/.config/opencode/agents/` for all `agents/*.json` — after that,
`opencode run --agent <name>` works in any project without copying.
Important: this is a manual step — editing `agents/<name>.json` (or saving via
the dashboard) does not redeploy `.md` to global automatically; you must re-run
`agent init` (see `docs/ideas.md`, "agents in other projects run with an
outdated config").

## Multi-Model

Below the capability level — models still determine the executor
automatically via `--model`:

| Model prefix | Runner | Status |
|---|---|---|
| `opencode/*` | opencode | **production** — primary, battle-tested |
| `opencode-go/*` | opencode | **production** — models of current agents (`agents/*.json`) |
| `deepseek/*` | opencode | **production** |
| `openai/*` | opencode | **production** |
| `anthropic/*` | opencode | **production** |
| `claude/*` | claude | **experimental** — untested, cost tracking not implemented |
| `gemini/*` | gemini | **experimental** — untested, CLI flags not verified |
| `codex/*` | codex | **experimental** — parser mismatch (Codex does not emit JSON) |

Default when neither `--model` nor `--agent` is specified —
`opencode/deepseek-v4-flash-free` (OpenCode Zen, $0, no login). You can also
set the runner explicitly: `--runner opencode --model claude/sonnet-4`.

Runners other than opencode are experimental stubs. They are correctly
registered in `lib/models.json` and `lib/runners/`, but **not ready for
use**: the claude/gemini adapters are untested on real tasks,
and codex cannot read the output (Codex CLI does not emit a JSON stream).

## Memory

Facts live in `.ai/memory/index.json`. Available across any sessions:

```bash
.ai/bin/agent remember "project:db-name" "v96800_vodovorot" --tags "opencart,mysql"
.ai/bin/agent recall "db"              # search
.ai/bin/agent learn <jobId>            # extract from a task result
.ai/bin/agent forget "project:db-name" # delete
.ai/bin/agent recall                   # show all
```

## Architecture

```
.ai/
  bin/agent              CLI: delegate, start, worktree, detached launch
  lib/run-job.sh         wrapper that hosts the agent (auto-commit, verify)
  lib/agent.js           JSON handling, event stream parsing, table output
  lib/diagnosis.js       failure classification (outcome for heal)
  lib/models.json        model prefix → runner mapping
  lib/runners/*.js       executor adapters (opencode, claude, gemini, codex)
  lib/dashboard.js       web dashboard (HTTP API + server, localhost)
  lib/dashboard.html     dashboard SPA interface (vanilla JS)
  agents/*.json          agent definitions (canonical JSON: model, variant,
                          worktree, permissions, systemPrompt)
  lib/deploy-agent.js    JSON → opencode agent.md (YAML frontmatter)
  plugins/index.js       custom tools for opencode (git_commit)
  .opencode/             config + deployed agents/plugins (generated)
  hooks/                 PreToolUse hooks: delegation reminders
  scripts/               one-off maintenance scripts
  backups/               backups
  test/                  unit/integration tests (agent-crud, dashboard-api,
                          deploy-agent, diagnosis, diffStatusLines, pad)
  jobs/<jobId>/          job.json · prompt.md · out.jsonl · result.md · verify.log · diagnosis.json
  memory/index.json      long-term memory (remember/recall)
```

Research agent reports do not land here — they are saved in
`ai-research/` at the root of the **target project** (`--repo`), not inside
`.ai` (see "Where research agents save reports" below).

Three principles everything rests on:

1. **The spec is passed at launch**, as a positional argument. Not "appended"
   after start — otherwise multi-line text breaks.
2. **The result is finalized by the wrapper.** `run-job.sh` itself writes the
   exit code to `job.json`, so status is reliable even if the orchestrator is
   already closed.
3. **JSONL is the single source of truth.** Status, tokens, cost, and
   `sessionId` are taken from the event stream, not from parsing screen output.

## Verification (`--verify`)

The command from `--verify` is executed by the wrapper **after** the agent, in
its working directory. The full output goes to `verify.log`, and only the
verdict goes into `job.json`. The point is that the test run shouldn't clog
the orchestrator's context — `passed` / `failed` is enough.

If the agent exits with an error, the check is not run (`skipped`).

### Before `--verify`: worktree environment

`--worktree` is a clean `git checkout`. It has no `node_modules` and nothing
generated at runtime (Prisma client, codegen, etc.), even if those already
exist in the main repository. The first `--verify` in a fresh worktree without
installing dependencies **will fail on imports across the whole project**, not
just on files the agent touched — that's a false failure, not broken code.
It's easy to tell: errors are identical across different, unrelated tasks and
hit files the agent never touched.

Rule: `--verify` always starts with environment setup specific to the
project's stack — `npm install …` and, if applicable, client/schema generation
(`npx prisma generate` etc.). Don't rely on the environment "already being
there" — the worktree does not inherit it.

## Auto-Commit in Worktree

If a task is launched with a worktree (`--agent coding` or `--worktree`),
the `run-job.sh` wrapper automatically commits uncommitted changes at the
end — in case the model forgot to `git commit` itself.
The commit message is generated from `task`, `model`, and the first lines of
`result.md`. For tasks WITHOUT a worktree, auto-commit is skipped (committing
to the main branch is the orchestrator's decision, not automation's).

The `autoCommitted` flag (true/false) is visible in `agent status` and
`job.json`. If `autoCommitted: false` for a worktree task — either there were
no changes, or the auto-commit couldn't execute (verify manually:
`git diff --stat` in the worktree).

## Failure Diagnosis (`diagnosis.json`)

On a non-success outcome (`validation_error`, `permission_rejected`,
`abandoned`, `error`, `no_events`), `agent.js finalize` writes
`diagnosis.json` into the task directory:

```json
{
  "outcome": "validation_error",
  "prompt": "text of the request from the event stream",
  "toolCalls": [
    {"tool": "write", "status": "error", "error": "invalid arguments: content is required"}
  ],
  "lastErrorMessage": "invalid arguments: content is required",
  "textAfterLastError": "Let me fix the arguments",
  "resumedAfterError": true
}
```

- `outcome` — `success | validation_error | permission_rejected | abandoned | error | no_events`
- `toolCalls` — all tool invocations with their statuses and errors
- `lastErrorMessage` — text of the last error
- `textAfterLastError` — what the model wrote after the error (if it tried to self-repair)
- `resumedAfterError` — boolean, whether the model self-repaired after an error

`agent heal` reads `diagnosis.json` and sends a structured message into the
same session for retry. `agent status` shows the outcome in the diagnosis line.

## Hooks and Tests

- **`hooks/`** — PreToolUse hooks that inject reminders into the
  orchestrator's context (non-blocking):
  - `research-delegation-reminder.js` — counts consecutive
    WebFetch/WebSearch calls; on the 3rd one, reminds to delegate
    multi-source research
  - `prefer-ai-agent-over-subagent.js` — intercepts Claude Code's
    built-in subagent call and suggests using `.ai/bin/agent`
    (cheaper, isolated context)
- **`test/`** — unit/integration tests on bare Node (no external
  dependencies, `node test/<file>.test.js`):
  - `diagnosis.test.js` — task outcome classification
  - `diff-status-lines.test.js` — git diff change filtering with pre-status snapshot
  - `pad.test.js` — table formatting in CLI output
  - `deploy-agent.test.js` — JSON→YAML/markdown conversion + freshness-check
    (don't overwrite `.md` if it's newer than the source `.json`)
  - `agent-crud.test.js` — CLI create/list/show/delete for `agents/*.json`
  - `dashboard-api.test.js` — dashboard HTTP API (`/api/jobs`, `/api/agents`,
    `/api/stats`, etc.), spawns `createServer()` on a random port

## How Much Detail to Put in a Spec

The point of delegation is saving the orchestrator's tokens. That point is
lost if the orchestrator, before `delegate`, reads files itself, looks up line
numbers, and essentially solves the problem, leaving the executor only to print
a ready-made answer — then it would have been cheaper to do it yourself.

- **Don't specify line numbers, exact function signatures, "where things
  live"**, unless it's the only way to resolve ambiguity. The executor has its
  own `read`/`grep`/`glob` budget specifically for that — the spec's job is to
  give the goal and constraints, not step-by-step instructions resulting from
  the orchestrator's own research.
- **Specify what's cheaper to say than to rediscover**: which pattern to
  follow (a sample file, not its content), report format/structure for a
  research agent, acceptance criteria ("tests green", "report contains X, Y,
  Z"), explicit scope constraints ("don't touch migrations").
- A sign the spec is too detailed: if you could rewrite the prompt as a
  ready-made diff/report text — the executor is unnecessary, the savings
  disappeared. A sign it's too sparse: the agent can't determine the "done"
  criterion without an additional question — then it either guesses or stalls;
  it can't wait for an answer in headless mode (see "Continue a session"
  above).
- Below — not about volume, but about specific format pitfalls caught twice:
  paths, references to uncommitted files, silently giving up on the first
  error, trusting `verify: passed` without a diff.

**Where research agents save reports** — already fixed in their
`systemPrompt` (`agents/research.json`/`research-code.json`): always
`ai-research/<file>.md` at the root of the target `--repo`; the folder is
created by the agent itself. There's no need to specify the path in the
spec — this is the case where a convention saves a line in every prompt. If
you need a report outside this folder (rare) — override explicitly. Important:
`ai-research/` is created **inside `--repo` (the target project)**, not inside
`.ai` — if someone includes `.ai` in their own project as a tool, their own
reports shouldn't leak into the tool directory.

## Writing Specs — Mandatory Rules

Discovered from two failures on erp_core on 2026-07-26 (task formally
`completed`/`verify: passed`, but `git diff --stat` in the worktree — empty,
the agent did nothing). Causes and rules:

1. **Paths in the spec — relative only.** The executor model sometimes
   fabricates an absolute path to the MAIN checkout of the repository (e.g.
   `D:\work\vodovorot\server\erp_core\...`) instead of its worktree working
   directory — and such accesses are silently rejected by the sandbox
   (`external_directory`, `auto-rejecting`, without prompting a human in
   headless mode). Outwardly, this looks like normal completion with an empty
   result. Write explicitly in every spec: "paths are relative; don't
   construct an absolute path to another checkout — it is inaccessible."

2. **Everything referenced by the spec must already be committed** in the
   `base ref` from which the worktree branches (usually `master`). A reference
   to a file that only exists as uncommitted in another working copy
   (including another worktree) is guaranteed to fail — the agent's worktree
   branches from git history, not from copying someone else's working
   directory. Before `agent start` — check `git status`/`git log` for files
   mentioned in the spec.

3. **Explicitly require: don't silently give up on the first read error.**
   Without this line, the executor model (observed with DeepSeek via opencode)
   may stop after the very first rejected/failed call, without trying an
   alternative path and without leaving any textual response. A phrase like
   "if a file doesn't open — search differently or proceed based on what you
   managed to read; always provide a textual summary of what was done/not
   done at the end" — measurably reduces the chance of a silent loss.

4. **After receiving `verify: passed` — always check `git diff --stat` in the
   worktree, not just the status.** `verify: passed` with a zero diff — is not
   a sign of success, but a sign that tests ran against unchanged code. The
   only reliable signal that the agent actually did work — a non-empty diff
   matching the expected files from the spec.

## Switching Executors

The `agent` interface is executor-agnostic. To add a new one, you need one
file in `lib/runners/` with three things:

```js
module.exports = {
  capabilities: { resume: true, cost: true, json: true },
  buildArgs(job, prompt) { /* -> string[] */ },
  parse(events)          { /* -> { sessionId, resultText, tokens, cost, error } */ },
};
```

Then `--runner <name>`. The `job.json` records which executor ran the
task — old tasks remain readable after a switch.

Important: it's not just flags that differ, but **capabilities**. For an
executor without session continuation, `send` won't work — this can't be fixed
by an abstraction layer.

### About ACP

[Agent Client Protocol](https://agentclientprotocol.com/) — a standard supported
by many agents, including opencode (`opencode acp`). It could become a single
adapter for all of them at once.

Currently not used, deliberately: ACP is a live JSON-RPC session over stdio
with callbacks, i.e. a persistently running process. This maps poorly onto the
"tool call within a turn" model and brings back the complexity that the whole
thing was designed to escape.

## Why No tmux

Ready-made orchestrators (e.g. `codex-orchestrator`) keep agents in tmux —
but only because they wrap **TUI applications** that need a pseudo-terminal.
Hence their `script` wrapper and ANSI code scrubbing.

`opencode run --format json` is a regular batch process with clean JSONL
output. That entire layer is unnecessary, and with it goes the WSL requirement
on Windows.

Resilience doesn't suffer: it's based not on process liveness, but on the fact
that state lives on disk — log, `sessionId`, session history inside opencode
itself. Even a killed task is visible up to where it got, and can be continued
via `send`. This survives a machine reboot; tmux doesn't.
