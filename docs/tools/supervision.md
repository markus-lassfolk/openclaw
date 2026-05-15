# Agent supervision controls

OpenClaw can expose an audited local supervision tool for an operator/orchestrator agent such as Maeve. It is disabled by default.

## Enable safely

```ts
export default {
  tools: {
    supervision: {
      enabled: true,
      allowAgents: ["main"], // Maeve / primary orchestrator only
    },
  },
};
```

This does **not** bypass branch protection, merge checks, credential policy, or external-action approvals. It only grants local observability and emergency brake controls for local agent, cron, and subagent runs.

Keep recurring PR Stewardship cron disabled separately; supervision does not create or enable cron jobs.

## Capabilities

The `supervision` tool supports:

- `action: "list"` — read-only listing of local sessions/runs, including isolated cron run aliases when present.
- `action: "cancel"` — hard emergency brake by `sessionKey`, `sessionId`, or `runId`.
- `action: "pause"` — deny further tool calls and clear queued turns without forcing a model abort when a softer stop is safer.

List rows include session/run identifiers, kind (`main`, `cron`, `subagent`, etc.), active model/tool state when available, queue-depth placeholder, cron owner ids parsed from cron session keys, run age, token/cost fields when stored, transcript path/tail when requested, last side-effect/tool summary, and cancellation state.

## Guardrails

Every observe/cancel/pause operation appends JSONL audit records under:

```text
~/.openclaw/audit/supervision.jsonl
```

Audit records include actor session/agent, action, target, reason, timestamp, mode, and result summary.

Transcript tails are opt-in (`includeTranscriptTail: true`) so read-only run listing does not leak private transcript content into shared contexts by default.

## Emergency behavior

`cancel`/`pause` performs best-effort layered shutdown:

1. Mark the run as tool-denied so any resumed/restarted attempt receives no tools.
2. Clear queued turns/follow-ups for the target session/sessionId.
3. For hard cancel, abort the active embedded model/tool cycle when the sessionId is active.
4. Attempt gateway `chat.abort` for chat-bound active runs.
5. Mark the session `abortedLastRun=true` and `sendPolicy="deny"` to block further sends until the operator deliberately clears it.
6. Mark matching subagent registry records terminated.

Architectural note: there is no queue depth introspection API yet; list rows include `queueDepth: 0` as an explicit placeholder rather than pretending to know hidden queue state. A follow-up should expose read-only queue counts from `auto-reply/reply/queue.ts`.
