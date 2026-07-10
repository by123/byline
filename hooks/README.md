# Byline status protocol

Byline shows a live status for every terminal tab. Heuristics cover any program, but an
agent (or anything else) can report its state **authoritatively** through a tiny
file-based protocol — no IPC, no dependencies, any language.

## The contract

Byline exports `BYLINE_SID` (a unique session id) into every tab's environment and
watches `/tmp/byline_sessions/`. To report state, write **one word** to the file named
after the session:

```
/tmp/byline_sessions/$BYLINE_SID
```

| word      | sidebar shows                                | typical trigger                |
| --------- | -------------------------------------------- | ------------------------------ |
| `think`   | 🫧 thinking (breathing dot) — agent working  | prompt submitted, tool running |
| `confirm` | 🟡 needs confirmation — waiting on the user  | permission / approval request  |
| `done`    | 🟢 done — finished, output ready for review  | agent turn completed           |
| `start` / `off` | 🔴 idle                                | session started / agent exited |

Write atomically (write a `.tmp` file, then rename) so the watcher never reads a partial
write. If `BYLINE_SID` is not set you are not inside Byline — do nothing. Byline falls
back to built-in heuristics for sessions that never report, and hands control back to
them when the agent's process exits.

The bundled [`byline-status`](byline-status) script implements exactly this in
dependency-free POSIX `sh`:

```sh
byline-status think     # no-op outside Byline; never fails; never prints
```

## Claude Code and Codex

`install.sh` copies `byline-status` to `~/.byline/` and registers it in **both**
`~/.claude/settings.json` and `~/.codex/hooks.json` (idempotent; a `.byline-backup` of each
edited file is kept; a config that doesn't exist is simply skipped):

```sh
./install.sh              # install (Claude Code + Codex)
./install.sh --uninstall  # remove the entries again
```

Event mapping it installs (Codex uses the same event names, minus `PostToolUseFailure`):

| hook event | state |
| --- | --- |
| `SessionStart` | `start` |
| `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure` | `think` |
| `PermissionRequest` | `confirm` |
| `Stop` | `done` |

From the JSON payload the agent sends on the hook's stdin, the script also records the tab's live
`session_id` + `transcript_path` to `/tmp/byline_sessions/$BYLINE_SID.session` (for Codex the
transcript is the rollout file). Byline uses that to hand over **this tab's** session — so a
handoff stays correct even when two tabs of the same agent share one project directory. Without
the hook it falls back to the most-recently-written session in that directory.

**Codex hook trust:** Codex gates newly registered hooks behind a one-time interactive review.
After installing, the next `codex` launch shows a **"Review hooks"** screen — choose **"Trust all
and continue"** so the Byline hook is allowed to run. (`codex --dangerously-bypass-hook-trust`
runs untrusted hooks for a single invocation, but trusting once is the normal path.)

## Other agents and consumers

Anything that can run a command on lifecycle events can integrate the same way — point
it at `byline-status <word>`. The protocol also works in the other direction: any
consumer can watch `/tmp/byline_sessions/` to mirror agent status elsewhere — the same hook
events can drive a physical status light on your desk just as well as a sidebar.
