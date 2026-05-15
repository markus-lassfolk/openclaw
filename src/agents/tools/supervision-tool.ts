import { Type } from "@sinclair/typebox";
import { type OpenClawConfig, loadConfig } from "../../config/config.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import {
  appendSupervisionAudit,
  cancelSupervisedRun,
  listSupervisionRuns,
} from "../run-supervision.js";
import { optionalStringEnum } from "../schema/typebox.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

const SUPERVISION_ACTIONS = ["list", "cancel", "pause"] as const;
const SupervisionToolSchema = Type.Object({
  action: optionalStringEnum(SUPERVISION_ACTIONS),
  target: Type.Optional(Type.String()),
  reason: Type.Optional(Type.String()),
  includeTranscriptTail: Type.Optional(Type.Boolean()),
  transcriptTailLimit: Type.Optional(Type.Number({ minimum: 1 })),
});

function ensureAllowed(cfg: OpenClawConfig, actorSessionKey?: string) {
  const raw = (
    cfg.tools as { supervision?: { enabled?: unknown; allowAgents?: unknown } } | undefined
  )?.supervision;
  if (raw?.enabled !== true) {
    return {
      ok: false as const,
      error: "Supervision controls are disabled. Set tools.supervision.enabled=true.",
    };
  }
  const actorAgentId = actorSessionKey ? resolveAgentIdFromSessionKey(actorSessionKey) : undefined;
  const allowAgents = Array.isArray(raw.allowAgents) ? raw.allowAgents.map(String) : [];
  if (
    allowAgents.length > 0 &&
    !allowAgents.includes("*") &&
    (!actorAgentId || !allowAgents.includes(actorAgentId))
  ) {
    return { ok: false as const, error: "Supervision controls are not allowed for this agent." };
  }
  return { ok: true as const, actorAgentId };
}

export function createSupervisionTool(opts?: {
  agentSessionKey?: string;
  config?: OpenClawConfig;
}): AnyAgentTool {
  return {
    label: "Supervision",
    name: "supervision",
    description:
      "Audited local run supervision: list local agent/cron/subagent runs or cancel/pause a target by sessionKey, sessionId, or runId.",
    parameters: SupervisionToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = (readStringParam(params, "action") ??
        "list") as (typeof SUPERVISION_ACTIONS)[number];
      const cfg = opts?.config ?? loadConfig();
      const allowed = ensureAllowed(cfg, opts?.agentSessionKey);
      if (!allowed.ok) {
        return jsonResult({ status: "forbidden", error: allowed.error });
      }

      if (action === "list") {
        const includeTranscriptTail = params.includeTranscriptTail === true;
        const transcriptTailLimit =
          typeof params.transcriptTailLimit === "number" &&
          Number.isFinite(params.transcriptTailLimit)
            ? Math.max(1, Math.min(20, Math.floor(params.transcriptTailLimit)))
            : 5;
        const runs = await listSupervisionRuns({ cfg, includeTranscriptTail, transcriptTailLimit });
        await appendSupervisionAudit(cfg, {
          action: "observe",
          actorSessionKey: opts?.agentSessionKey,
          actorAgentId: allowed.actorAgentId,
          target: "*",
          targetType: "unknown",
          reason: "supervision list",
          result: { count: runs.length, includeTranscriptTail },
        });
        return jsonResult({ status: "ok", count: runs.length, runs });
      }

      const target = readStringParam(params, "target", { required: true });
      const reason =
        readStringParam(params, "reason")?.trim() || `${action} requested by supervisor`;
      const result = await cancelSupervisedRun({
        cfg,
        target,
        reason,
        actorSessionKey: opts?.agentSessionKey,
        actorAgentId: allowed.actorAgentId,
        mode: action === "pause" ? "pause-after-current-tool" : "hard",
      });
      return jsonResult(result);
    },
  };
}
