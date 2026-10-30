import { createHash, timingSafeEqual } from "node:crypto";

import { McpApiHandler } from "./mcp.js";
import type { WorkerEnv } from "./env.js";

export async function handleSecretRequest(request: Request, env: WorkerEnv): Promise<Response> {
  const secret = env.MCP_SHARED_SECRET;
  if (!secret || !/^[A-Za-z0-9_-]{64,}$/.test(secret)) {
    return new Response("Secret authentication is not configured", {
      status: 503,
      headers: { "cache-control": "no-store" },
    });
  }

  const url = new URL(request.url);
  const pathSecret = /^\/([^/]+)\/mcp$/.exec(url.pathname)?.[1];
  const bearerSecret = /^Bearer ([^\s]+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
  const expected = createHash("sha256").update(secret).digest();
  const bearerMatches = timingSafeEqual(expected, createHash("sha256").update(bearerSecret ?? "").digest());
  const pathMatches = timingSafeEqual(expected, createHash("sha256").update(pathSecret ?? "").digest());

  if (!bearerMatches && !pathMatches) {
    return new Response("Unauthorized", {
      status: 401,
      headers: { "www-authenticate": 'Bearer realm="ynab"', "cache-control": "no-store" },
    });
  }
  if (url.pathname !== "/mcp" && pathSecret === undefined) {
    return new Response("Not found", { status: 404 });
  }

  url.pathname = "/mcp";
  return McpApiHandler.fetch(new Request(url, request), env);
}
