// Local Responses transport. Selection is captured once per request, never
// changed mid-stream, and never silently falls back to another paid account.
import { codexTransport } from "./codex-transport.ts";
import { timingSafeEqual } from "node:crypto";
import { SignedOutError } from "./common.ts";

export type ProxyCredential = { name: string; accessToken: string; accountId: string };
export type ProxyObservation = { profile: string; path: string; status: number; session: string | null; at: string; failure?: string; bytes?: number; wireBytes?: number; elapsedMs?: number; encoding?: string | null };
// 401, not 5xx: a revoked sign-in will not recover on retry.
const signedOut = (e: SignedOutError) => Response.json({ error: { message: `Router account ${e.message}; no other account was used` } }, { status: 401 });

export function createProxyHandler(options: {
  token: string;
  credential: (name?: string, refresh?: boolean) => Promise<ProxyCredential>;
  upstream?: typeof fetch;
  observe?: (event: ProxyObservation) => void;
  status?: () => unknown;
  meter?: (credential: ProxyCredential) => Promise<(response: Response) => Response>;
}) {
  const upstream = options.upstream ?? codexTransport;
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    // New clients retain ChatGPT auth for browser/plugins and authenticate to
    // this loopback service separately. Keep legacy clients working, but never
    // accept a ChatGPT bearer token alone as authorization to use Router.
    const separateToken = request.headers.get("x-router-token");
    const supplied = Buffer.from(separateToken ?? request.headers.get("authorization") ?? "");
    const expected = Buffer.from(separateToken === null ? `Bearer ${options.token}` : options.token);
    if (request.headers.has("origin") || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      return Response.json({ error: { message: "Router proxy authentication required" } }, { status: 401 });
    }
    if (url.pathname === "/health" && request.method === "GET") {
      return Response.json({ ...(options.status?.() as object ?? {}), service: "router-codex-proxy", separateClientAuth: true });
    }
    const allowed = (request.method === "POST" && ["/v1/responses", "/v1/responses/compact"].includes(url.pathname))
      || (request.method === "GET" && url.pathname === "/v1/models");
    if (!allowed || request.headers.has("upgrade")) return new Response("Not found", { status: 404 });
    let credential: ProxyCredential;
    try { credential = await options.credential(); }
    catch (e) {
      if (e instanceof SignedOutError) return signedOut(e);
      return Response.json({ error: { message: "Selected Router account needs sign-in; run router doctor" } }, { status: 503 });
    }
    let metered = (response: Response) => response;
    if (request.method === "POST" && options.meter) {
      try { metered = await options.meter(credential); }
      catch { return Response.json({ error: { message: "Router could not verify usage attribution. Open Router to refresh subscription access." } }, { status: 503 }); }
    }
    const path = url.pathname.slice(3);
    // Only client protocol headers: never forward a stale account, cookie,
    // organization, proxy token, or an arbitrary upstream destination.
    const headers = new Headers();
    for (const name of ["accept", "content-type", "content-encoding", "openai-beta", "session_id", "conversation_id", "user-agent", "x-codex-turn-state", "x-codex-turn-metadata"]) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    headers.set("originator", "codex_cli_rs");
    let body: ArrayBuffer | Uint8Array | undefined = request.method === "POST" ? await request.arrayBuffer() : undefined;
    const bytes = body?.byteLength ?? 0;
    // Custom-provider Codex clients send long conversation histories without
    // compression. The Codex backend accepts zstd; keep existing encodings intact.
    if (body && bytes >= 4096 && !headers.has("content-encoding")) {
      body = await Bun.zstdCompress(new Uint8Array(body));
      headers.set("content-encoding", "zstd");
    }
    const target = new URL(`https://chatgpt.com/backend-api/codex${path}`);
    if (path === "/models" && url.searchParams.has("client_version")) target.searchParams.set("client_version", url.searchParams.get("client_version")!);
    const started = Date.now();
    const metadata = () => ({ bytes, wireBytes: body?.byteLength ?? 0, elapsedMs: Date.now()-started, encoding: headers.get("content-encoding")?.slice(0,24) ?? null });
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
        try { credential = await options.credential(credential.name, true); }
        catch (e) {
          options.observe?.({ profile: credential.name, path, status: 401, session: null, at: new Date().toISOString() });
          return metered(e instanceof SignedOutError ? signedOut(e)
            : Response.json({ error: { message: `Router could not renew the sign-in for "${credential.name}"; no other account was used` } }, { status: 401 }));
        }
        response = await send();
      }
      const session = request.headers.get("session_id");
      options.observe?.({ profile: credential.name, path, ...metadata(), status: response.status,
        session: session && /^[a-zA-Z0-9_-]{1,128}$/.test(session) ? session : null, at: new Date().toISOString() });
      const outgoing = new Headers(response.headers);
      // The transport requests uncompressed response bytes; framing belongs to Bun.
      for (const name of ["content-encoding", "content-length", "transfer-encoding", "connection", "set-cookie"]) outgoing.delete(name);
      outgoing.set("cache-control", "no-store");
      outgoing.set("x-router-profile", credential.name);
      return metered(new Response(response.body, { status: response.status, headers: outgoing }));
    } catch (error) {
      // A canceled client is not an upstream outage. Store only a bounded error
      // code, never error.message (which can contain request data/credentials).
      const code = (error as { code?: unknown })?.code;
      const failure = request.signal.aborted ? "client_canceled"
        : typeof code === "string" && /^[A-Z_0-9]{1,64}$/.test(code) ? code : "transport_error";
      const status = request.signal.aborted ? 499 : 502;
      options.observe?.({ profile: credential.name, path, ...metadata(), status, failure, session: null, at: new Date().toISOString() });
      return metered(Response.json({ error: { message: status === 499 ? "Router request canceled by client"
        : `Router could not reach account "${credential.name}" (${failure}); retry this request. No other account was used.` } }, { status }));
    }
  };
}
