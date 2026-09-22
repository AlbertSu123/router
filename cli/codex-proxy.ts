// Local Responses transport. Selection is captured once per request, never
// changed mid-stream, and never silently falls back to another paid account.
import { timingSafeEqual } from "node:crypto";

export type ProxyCredential = { name: string; accessToken: string; accountId: string };
export type ProxyObservation = { profile: string; path: string; status: number; session: string | null; at: string };
export function createProxyHandler(options: {
  token: string;
  credential: (name?: string, refresh?: boolean) => Promise<ProxyCredential>;
  upstream?: typeof fetch;
  observe?: (event: ProxyObservation) => void;
  status?: () => unknown;
  meter?: (credential: ProxyCredential) => Promise<(response: Response) => Response>;
}) {
  const upstream = options.upstream ?? fetch;
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const supplied = Buffer.from(request.headers.get("authorization") ?? "");
    const expected = Buffer.from(`Bearer ${options.token}`);
    if (request.headers.has("origin") || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      return Response.json({ error: { message: "Router proxy authentication required" } }, { status: 401 });
    }
    if (url.pathname === "/health" && request.method === "GET") {
      return Response.json({ service: "router-codex-proxy", ...(options.status?.() as object ?? {}) });
    }
    const allowed = (request.method === "POST" && ["/v1/responses", "/v1/responses/compact"].includes(url.pathname))
      || (request.method === "GET" && url.pathname === "/v1/models");
    if (!allowed || request.headers.has("upgrade")) return new Response("Not found", { status: 404 });
    let credential: ProxyCredential;
    try { credential = await options.credential(); }
    catch { return Response.json({ error: { message: "Selected Router account needs sign-in; run router doctor" } }, { status: 503 }); }
    let metered = (response: Response) => response;
    if (request.method === "POST" && options.meter) {
      try { metered = await options.meter(credential); }
      catch { return Response.json({ error: { message: "Router could not verify usage attribution. Open Router to refresh subscription access." } }, { status: 503 }); }
    }
    const path = url.pathname.slice(3);
    // Only client protocol headers: never forward a stale account, cookie,
    // organization, proxy token, or an arbitrary upstream destination.
    const headers = new Headers();
    for (const name of ["accept", "content-type", "openai-beta", "session_id", "conversation_id", "user-agent", "x-codex-turn-state", "x-codex-turn-metadata"]) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    headers.set("originator", "codex_cli_rs");
    const body = request.method === "POST" ? await request.arrayBuffer() : undefined;
    const target = new URL(`https://chatgpt.com/backend-api/codex${path}`);
    if (path === "/models" && url.searchParams.has("client_version")) target.searchParams.set("client_version", url.searchParams.get("client_version")!);
    const send = () => {
      headers.set("authorization", `Bearer ${credential.accessToken}`);
      headers.set("chatgpt-account-id", credential.accountId);
      return upstream(target, { method: request.method, headers, body, redirect: "error", signal: request.signal });
    };
    try {
      let response = await send();
      // Retry only authentication rejection, before any response is streamed.
      // Refresh the SAME profile even if selection changed during this call.
      if (response.status === 401) {
        await response.body?.cancel();
        credential = await options.credential(credential.name, true);
        response = await send();
      }
      const session = request.headers.get("session_id");
      options.observe?.({ profile: credential.name, path, status: response.status,
        session: session && /^[a-zA-Z0-9_-]{1,128}$/.test(session) ? session : null, at: new Date().toISOString() });
      const outgoing = new Headers(response.headers);
      // fetch decodes compressed responses; framing belongs to Bun's server.
      for (const name of ["content-encoding", "content-length", "transfer-encoding", "connection", "set-cookie"]) outgoing.delete(name);
      outgoing.set("cache-control", "no-store");
      outgoing.set("x-router-profile", credential.name);
      return metered(new Response(response.body, { status: response.status, headers: outgoing }));
    } catch {
      options.observe?.({ profile: credential.name, path, status: 502, session: null, at: new Date().toISOString() });
      return metered(Response.json({ error: { message: "Router could not reach the selected account; no other account was used" } }, { status: 502 }));
    }
  };
}
