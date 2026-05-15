import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { clearSessionQueues } from "../auto-reply/reply/queue.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveStorePath, updateSessionStore, type SessionEntry } from "../config/sessions.js";
import { callGateway } from "../gateway/call.js";
import { logVerbose } from "../globals.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import {
  getActiveEmbeddedRunInfos,
  getDeniedEmbeddedRunIds,
  denyEmbeddedPiRunTools,
} from "./pi-embedded-runner/runs.js";
import { abortEmbeddedPiRun, waitForEmbeddedPiRunEnd } from "./pi-embedded.js";
import {
  listSubagentRuns,
  markSubagentRunTerminated,
  type SubagentRunRecord,
} from "./subagent-registry.js";

export type SupervisionAuditAction = "observe" | "cancel" | "pause";

export type SupervisionAuditRecord = {
  id: string;
  timestamp: string;
  action: SupervisionAuditAction;
  actorSessionKey?: string;
  actorAgentId?: string;
  target: string;
  targetType: "sessionKey" | "sessionId" | "runId" | "unknown";
  reason: string;
  mode?: string;
  result?: Record<string, unknown>;
};

export type SupervisionRunView = {
  sessionKey: string;
  sessionId?: string;
  runId?: string;
  agentId?: string;
  kind: "main" | "cron" | "subagent" | "hook" | "node" | "other";
  status: "active" | "idle" | "cancelled" | "done" | "unknown";
  activeModelCall: boolean;
  activeToolCall?: { name?: string; toolCallId?: string; startedAt?: number; args?: unknown };
  toolsDenied?: boolean;
  queueDepth: number;
  ownerCronJobId?: string;
  ownerCronRunId?: string;
  subagentRunId?: string;
  parentSessionKey?: string;
  ageMs?: number;
  updatedAt?: number;
  model?: string;
  contextTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  transcriptPath?: string;
  transcriptTail?: unknown[];
  lastSideEffect?: { toolName?: string; meta?: string; error?: string; timestamp?: number };
  activeProcessIds?: number[];
  sendPolicy?: string;
  abortedLastRun?: boolean;
};

function supervisionAuditPath(cfg: OpenClawConfig): string {
  const rawStateDir = (cfg as { stateDir?: unknown }).stateDir;
  const base = typeof rawStateDir === "string" && rawStateDir.trim() ? rawStateDir : "~/.openclaw";
  const expanded = base.startsWith("~/")
    ? path.join(process.env.HOME || process.cwd(), base.slice(2))
    : base;
  return path.join(expanded, "audit", "supervision.jsonl");
}

export async function appendSupervisionAudit(
  cfg: OpenClawConfig,
  record: Omit<SupervisionAuditRecord, "id" | "timestamp">,
): Promise<SupervisionAuditRecord> {
  const entry: SupervisionAuditRecord = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    ...record,
  };
  const file = supervisionAuditPath(cfg);
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.appendFile(file, `${JSON.stringify(entry)}\n`, "utf8");
  return entry;
}

function classifyKind(sessionKey: string): SupervisionRunView["kind"] {
  if (sessionKey.includes(":cron:") || sessionKey.startsWith("cron:")) {
    return "cron";
  }
  if (sessionKey.includes(":subagent:") || sessionKey.startsWith("subagent:")) {
    return "subagent";
  }
  if (sessionKey.includes(":hook:") || sessionKey.startsWith("hook:")) {
    return "hook";
  }
  if (sessionKey.includes(":node:") || sessionKey.startsWith("node:")) {
    return "node";
  }
  if (sessionKey === "main" || sessionKey.endsWith(":main")) {
    return "main";
  }
  return "other";
}

function resolveTranscriptPath(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  entry: SessionEntry;
}) {
  if (typeof params.entry.sessionFile === "string" && path.isAbsolute(params.entry.sessionFile)) {
    return params.entry.sessionFile;
  }
  if (!params.entry.sessionId) {
    return undefined;
  }
  const agentId = resolveAgentIdFromSessionKey(params.sessionKey);
  const storePath = resolveStorePath(params.cfg.session?.store, { agentId });
  const sessionsDir = path.join(path.dirname(storePath), "sessions");
  if (typeof params.entry.sessionFile === "string" && params.entry.sessionFile.trim()) {
    return path.resolve(sessionsDir, params.entry.sessionFile);
  }
  return path.join(sessionsDir, `${params.entry.sessionId}.jsonl`);
}

function parseJsonlTail(file: string | undefined, limit: number): unknown[] | undefined {
  if (!file || limit <= 0) {
    return undefined;
  }
  try {
    const stat = fs.statSync(file);
    const fd = fs.openSync(file, "r");
    try {
      const readSize = Math.min(stat.size, 64 * 1024);
      const buffer = Buffer.alloc(readSize);
      fs.readSync(fd, buffer, 0, readSize, stat.size - readSize);
      return buffer
        .toString("utf8")
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(-limit)
        .map((line) => {
          try {
            return JSON.parse(line) as unknown;
          } catch {
            return { raw: line.slice(0, 1000) };
          }
        });
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

function getQueueDepth(sessionKey: string, sessionId?: string): number {
  // Non-destructive queue inspection is not exposed by the queue module yet. Keep
  // the field explicit for operators instead of silently omitting it.
  void sessionKey;
  void sessionId;
  return 0;
}

function cronOwner(sessionKey: string): { ownerCronJobId?: string; ownerCronRunId?: string } {
  const match = sessionKey.match(/(?:^|:)cron:([^:]+)(?::run:([^:]+))?/);
  return {
    ownerCronJobId: match?.[1],
    ownerCronRunId: match?.[2],
  };
}

function indexSubagentRuns() {
  const bySession = new Map<string, SubagentRunRecord>();
  const byRun = new Map<string, SubagentRunRecord>();
  for (const run of listSubagentRuns()) {
    bySession.set(run.childSessionKey, run);
    byRun.set(run.runId, run);
  }
  return { bySession, byRun };
}

export async function listSupervisionRuns(params: {
  cfg: OpenClawConfig;
  includeTranscriptTail?: boolean;
  transcriptTailLimit?: number;
}): Promise<SupervisionRunView[]> {
  const list = await callGateway<{
    sessions: Array<SessionEntry & { key?: string }>;
    path?: string;
  }>({
    method: "sessions.list",
    params: {
      includeGlobal: true,
      includeUnknown: true,
      includeCronRuns: true,
    },
  });
  const sessions = Array.isArray(list?.sessions) ? list.sessions : [];
  const activeRuns = new Map(getActiveEmbeddedRunInfos().map((info) => [info.sessionId, info]));
  const deniedRunIds = getDeniedEmbeddedRunIds();
  const subagents = indexSubagentRuns();
  const rows: SupervisionRunView[] = [];
  for (const raw of sessions) {
    const sessionKey = typeof raw.key === "string" ? raw.key : "";
    if (!sessionKey) {
      continue;
    }
    const entry = raw as SessionEntry;
    const sessionId = typeof entry.sessionId === "string" ? entry.sessionId : undefined;
    const active = sessionId ? activeRuns.get(sessionId) : undefined;
    const subagent = subagents.bySession.get(sessionKey);
    const transcriptPath = resolveTranscriptPath({ cfg: params.cfg, sessionKey, entry });
    const startedAt = active?.startedAt ?? subagent?.startedAt;
    rows.push({
      sessionKey,
      sessionId,
      runId: active?.runId ?? subagent?.runId,
      agentId: resolveAgentIdFromSessionKey(sessionKey),
      kind: classifyKind(sessionKey),
      status: active
        ? "active"
        : entry.abortedLastRun
          ? "cancelled"
          : subagent?.endedAt
            ? "done"
            : "idle",
      activeModelCall: Boolean(active?.isStreaming),
      activeToolCall: active?.activeToolCall,
      toolsDenied: active?.runId ? deniedRunIds.has(active.runId) : undefined,
      queueDepth: getQueueDepth(sessionKey, sessionId),
      ...cronOwner(sessionKey),
      subagentRunId: subagent?.runId,
      parentSessionKey: subagent?.controllerSessionKey ?? subagent?.requesterSessionKey,
      ageMs: startedAt ? Date.now() - startedAt : undefined,
      updatedAt: typeof entry.updatedAt === "number" ? entry.updatedAt : undefined,
      model: typeof entry.model === "string" ? entry.model : undefined,
      contextTokens: typeof entry.contextTokens === "number" ? entry.contextTokens : undefined,
      totalTokens: typeof entry.totalTokens === "number" ? entry.totalTokens : undefined,
      costUsd:
        typeof (entry as { costUsd?: unknown }).costUsd === "number"
          ? (entry as unknown as { costUsd: number }).costUsd
          : undefined,
      transcriptPath,
      transcriptTail: params.includeTranscriptTail
        ? parseJsonlTail(transcriptPath, params.transcriptTailLimit ?? 5)
        : undefined,
      lastSideEffect: active?.lastSideEffect,
      activeProcessIds: active?.activeProcessIds,
      sendPolicy: entry.sendPolicy,
      abortedLastRun: entry.abortedLastRun,
    });
  }
  return rows.toSorted((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

export async function cancelSupervisedRun(params: {
  cfg: OpenClawConfig;
  target: string;
  reason: string;
  actorSessionKey?: string;
  actorAgentId?: string;
  mode?: "hard" | "pause-after-current-tool";
}): Promise<Record<string, unknown>> {
  const target = params.target.trim();
  const mode = params.mode ?? "hard";
  const runs = await listSupervisionRuns({ cfg: params.cfg });
  const view = runs.find(
    (entry) => entry.sessionKey === target || entry.sessionId === target || entry.runId === target,
  );
  const targetType =
    view?.sessionKey === target
      ? "sessionKey"
      : view?.sessionId === target
        ? "sessionId"
        : view?.runId === target
          ? "runId"
          : "unknown";
  const sessionKey = view?.sessionKey ?? target;
  const sessionId = view?.sessionId;
  const runId = view?.runId;
  const cleared = clearSessionQueues([sessionKey, sessionId]);
  const toolsDenied = runId ? denyEmbeddedPiRunTools(runId, params.reason) : false;
  const abortedModel = mode === "hard" && sessionId ? abortEmbeddedPiRun(sessionId) : false;
  const waited = abortedModel ? await waitForEmbeddedPiRunEnd(sessionId!, 5_000) : false;
  let chatAbort: unknown;
  if (runId && sessionKey) {
    try {
      chatAbort = await callGateway({
        method: "chat.abort",
        params: { sessionKey, runId },
        timeoutMs: 5_000,
      });
    } catch (err) {
      chatAbort = { error: err instanceof Error ? err.message : String(err) };
    }
  }
  if (sessionKey) {
    try {
      const agentId = resolveAgentIdFromSessionKey(sessionKey);
      const storePath = resolveStorePath(params.cfg.session?.store, { agentId });
      await updateSessionStore(storePath, (store) => {
        const current = store[sessionKey];
        if (!current) {
          return;
        }
        current.abortedLastRun = true;
        current.sendPolicy = "deny";
        current.updatedAt = Date.now();
        store[sessionKey] = current;
      });
    } catch (err) {
      logVerbose(
        `supervision cancel: session patch failed target=${sessionKey} err=${String(err)}`,
      );
    }
  }
  if (runId || sessionKey) {
    for (const subagent of listSubagentRuns()) {
      if (subagent.runId === runId || subagent.childSessionKey === sessionKey) {
        markSubagentRunTerminated({
          runId: subagent.runId,
          childSessionKey: subagent.childSessionKey,
          reason: "supervision_cancel",
        });
      }
    }
  }
  const result = {
    status: "ok",
    target,
    targetType,
    sessionKey,
    sessionId,
    runId,
    mode,
    toolsDenied,
    abortedModel,
    activeRunEnded: waited,
    queuesCleared: cleared,
    chatAbort,
  };
  await appendSupervisionAudit(params.cfg, {
    action: mode === "hard" ? "cancel" : "pause",
    actorSessionKey: params.actorSessionKey,
    actorAgentId: params.actorAgentId,
    target,
    targetType,
    reason: params.reason,
    mode,
    result,
  });
  return result;
}
