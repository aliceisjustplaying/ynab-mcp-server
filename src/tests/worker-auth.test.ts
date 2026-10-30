import { afterEach, describe, expect, it, vi } from "vitest";

import worker from "../worker/index.js";
import * as nag from "../worker/nag.js";
import type { WorkerEnv } from "../worker/env.js";

vi.mock("@cloudflare/workers-oauth-provider", () => ({
  default: class {
    fetch() {
      throw new Error("OAuth must not run in secret mode");
    }
    purgeExpiredData() {
      throw new Error("OAuth housekeeping must not run in secret mode");
    }
  },
}));

const secret = "a1".repeat(32);
const env: WorkerEnv = {
  YNAB_API_TOKEN: "test-token",
  MCP_AUTH_MODE: "secret",
  MCP_SHARED_SECRET: secret,
};
const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "secret-auth-test", version: "1" },
  },
};

async function call(path: string, authorization?: string, body: unknown = initialize, overrides: Partial<WorkerEnv> = {}) {
  const headers = new Headers({
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  });
  if (authorization !== undefined) headers.set("authorization", authorization);
  return worker.fetch(new Request(`https://example.com${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  }), { ...env, ...overrides }, ctx);
}

async function readResult(response: Response) {
  const text = await response.text();
  const dataLine = text.split("\n").find((line) => line.startsWith("data:"));
  return JSON.parse(dataLine ? dataLine.slice(5).trim() : text);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe.each(["bearer", "path"] as const)("Worker %s secret authentication", (form) => {
  const endpoint = (value: string) => form === "path" ? `/${value}/mcp` : "/mcp";
  const header = (value: string) => form === "bearer" ? `Bearer ${value}` : undefined;

  it("rejects a request without the secret", async () => {
    const response = await call("/mcp");
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe('Bearer realm="ynab"');
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("Unauthorized");
  });

  it.each(["b2".repeat(32), "wrong", `${secret}extra`])("rejects an incorrect secret %s", async (wrong) => {
    const response = await call(endpoint(wrong), header(wrong));
    expect(response.status).toBe(401);
    const text = await response.text();
    expect(text).not.toContain(secret);
    expect(text).not.toContain(wrong);
  });

  it("accepts initialize with the secret and no GitHub configuration", async () => {
    const response = await call(endpoint(secret), header(secret));
    expect(response.status).toBe(200);
    expect((await readResult(response)).result.serverInfo.name).toBe("ynab-mcp-server");
  });

  it("lists write tools with the secret", async () => {
    const response = await call(endpoint(secret), header(secret), {
      jsonrpc: "2.0", id: 2, method: "tools/list",
    });
    expect(response.status).toBe(200);
    const names = (await readResult(response)).result.tools.map((tool: { name: string }) => tool.name);
    expect(names).toContain("ynab_create_transaction");
    expect(names).toContain("ynab_update_transaction");
    expect(names).toContain("ynab_delete_transaction");
    expect(names).toContain("ynab_move_money");
  });

  it("never makes an upstream request for rejected credentials", async () => {
    const upstream = vi.spyOn(globalThis, "fetch");
    expect((await call(endpoint("wrong"), header("wrong"))).status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each([undefined, "", "short"])("fails closed for invalid configured secret %s", async (configured) => {
    const response = await call(endpoint(secret), header(secret), initialize, { MCP_SHARED_SECRET: configured });
    expect(response.status).toBe(503);
  });
});

it.each(["/authorize", "/token", "/register", "/callback", "/.well-known/oauth-authorization-server"])(
  "does not expose OAuth at %s in secret mode", async (path) => {
    expect((await call(path)).status).toBe(401);
    expect((await call(path, `Bearer ${secret}`)).status).toBe(404);
  },
);

it.each(["Basic", "Bearer", "Bearer wrong", `Token ${secret}`])("rejects malformed authorization %s", async (header) => {
  expect((await call("/mcp", header)).status).toBe(401);
});

it("does not accept a query-string secret", async () => {
  expect((await call(`/mcp?secret=${secret}`)).status).toBe(401);
});

it("requires credentials on GET and DELETE too", async () => {
  for (const method of ["GET", "DELETE"]) {
    const response = await worker.fetch(new Request("https://example.com/mcp", { method }), env, ctx);
    expect(response.status).toBe(401);
  }
});

it("fails closed for an unknown authentication mode", async () => {
  const response = await call("/mcp", `Bearer ${secret}`, initialize, { MCP_AUTH_MODE: "typo" as "secret" });
  expect(response.status).toBe(503);
});

it("does not require OAuth KV housekeeping after a scheduled reminder in secret mode", async () => {
  vi.spyOn(nag, "runNag").mockResolvedValue({
    ran: true,
    pending: { unapproved: 0, uncategorized: 0, total: 0, amount: 0, backlog: 0 },
    result: "nothing-to-do",
  });
  const pending: Promise<unknown>[] = [];
  const scheduledCtx = { waitUntil: (promise: Promise<unknown>) => pending.push(promise) } as unknown as ExecutionContext;
  await worker.scheduled({} as ScheduledController, env, scheduledCtx);
  await Promise.all(pending);
  expect(nag.runNag).toHaveBeenCalledWith(env);
});
