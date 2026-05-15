import { describe, expect, it, vi, beforeEach } from "vitest";

const callGatewayMock = vi.fn();
vi.mock("../../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));

vi.mock("../../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => ({
      session: { mainKey: "main", store: "/tmp/openclaw-supervision-test/{agentId}/sessions.json" },
      tools: { supervision: { enabled: true, allowAgents: ["main"] } },
    }),
  };
});

import { createSupervisionTool } from "./supervision-tool.js";

describe("supervision tool", () => {
  beforeEach(() => {
    callGatewayMock.mockReset();
  });

  it("lists cron-bound isolated run sessions when gateway exposes cron run aliases", async () => {
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: Record<string, unknown> };
      if (request.method === "sessions.list") {
        expect(request.params?.includeCronRuns).toBe(true);
        return {
          sessions: [
            {
              key: "agent:main:cron:pr-steward:run:run-123",
              sessionId: "sess-cron-run",
              updatedAt: 10,
              label: "Cron: pr-steward",
              totalTokens: 42,
            },
          ],
        };
      }
      return {};
    });
    const tool = createSupervisionTool({ agentSessionKey: "agent:main:telegram:default:direct:1" });
    const result = await tool.execute("call-1", { action: "list" });
    const details = result.details as {
      status?: string;
      runs?: Array<{ kind?: string; ownerCronJobId?: string; sessionKey?: string }>;
    };
    expect(details.status).toBe("ok");
    expect(details.runs?.[0]).toMatchObject({
      kind: "cron",
      ownerCronJobId: "pr-steward",
      sessionKey: "agent:main:cron:pr-steward:run:run-123",
    });
  });
});
