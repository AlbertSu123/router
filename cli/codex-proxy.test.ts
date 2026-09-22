import { expect, test } from "bun:test";
import { createProxyHandler, type ProxyCredential } from "./codex-proxy.ts";
import { configureProxy, unconfigureProxy } from "./proxy-control.ts";
import { SignedOutError } from "./common.ts";

const accounts: Record<string, ProxyCredential> = {
  a: { name: "a", accessToken: "secret-a", accountId: "account-a" },
  b: { name: "b", accessToken: "secret-b", accountId: "account-b" },
};
const request = (path = "/v1/responses", extra: Record<string, string> = {}) => new Request(`http://127.0.0.1${path}`, {
  method: "POST", headers: { authorization: "Bearer local", "content-type": "application/json", ...extra }, body: '{"input":"test"}',
});
test("same session changes account on the next request, replacing client credentials", async () => {
  let selected = "a";
  const seen: Headers[] = [];
  const handler = createProxyHandler({ token: "local", credential: async () => accounts[selected]!,
    upstream: (async (_url, init) => { seen.push(new Headers(init!.headers)); return new Response("data: done\n\n"); }) as typeof fetch });
  await handler(request("/v1/responses", { session_id: "same", "chatgpt-account-id": "stale", cookie: "secret" }));
  selected = "b";
  await handler(request("/v1/responses", { session_id: "same" }));
  expect(seen.map(h => h.get("authorization"))).toEqual(["Bearer secret-a", "Bearer secret-b"]);
  expect(seen.map(h => h.get("chatgpt-account-id"))).toEqual(["account-a", "account-b"]);
  expect(seen[0]!.get("cookie")).toBeNull();
});
test("refresh stays on the request's account when selection changes", async () => {
  let selected = "a", attempts = 0;
  const handler = createProxyHandler({ token: "local", credential: async (name, refresh) => {
    if (refresh) expect(name).toBe("a");
    return accounts[name ?? selected]!;
  }, upstream: (async (_url, init) => {
    expect(new Headers(init!.headers).get("chatgpt-account-id")).toBe("account-a");
    selected = "b";
    return new Response("", { status: ++attempts === 1 ? 401 : 200 });
  }) as typeof fetch });
  expect((await handler(request())).status).toBe(200);
  expect(attempts).toBe(2);
});
test("a signed-out selection is a 401 that names it, and never reaches upstream", async () => {
  let calls = 0;
  const handler = createProxyHandler({ token: "local", credential: async () => { throw new SignedOutError("codex:a"); },
    upstream: (async () => { calls++; return new Response(""); }) as typeof fetch });
  const response = await handler(request());
  expect(response.status).toBe(401);
  expect((await response.json()).error.message).toContain('"codex:a" is signed out');
  expect(calls).toBe(0);
});
test("a revoked token whose refresh is rejected is a 401, not an unreachable 502", async () => {
  let attempts = 0;
  const handler = createProxyHandler({ token: "local", credential: async (name, refresh) => {
    if (refresh) throw new SignedOutError(`codex:${name}`);
    return accounts.a!;
  }, upstream: (async () => { attempts++; return new Response("revoked", { status: 401 }); }) as typeof fetch });
  const response = await handler(request());
  expect(response.status).toBe(401);
  expect((await response.json()).error.message).toContain('"codex:a" is signed out');
  expect(attempts).toBe(1);
});
test("streams immediately and leaves in-flight responses on their original account", async () => {
  let selected = "a", controller: ReadableStreamDefaultController<Uint8Array>;
  const handler = createProxyHandler({ token: "local", credential: async () => accounts[selected]!,
    upstream: (async () => new Response(new ReadableStream({ start(c) { controller = c; c.enqueue(new TextEncoder().encode("first")); } }))) as typeof fetch });
  const response = await handler(request());
  selected = "b";
  const reader = response.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toBe("first");
  expect(response.headers.get("x-router-profile")).toBe("a");
  controller!.close();
});
test("rejects browser origins, missing tokens, arbitrary routes and never falls back on quota errors", async () => {
  let calls = 0;
  const handler = createProxyHandler({ token: "local", credential: async () => accounts.a!,
    upstream: (async () => { calls++; return new Response("quota", { status: 429 }); }) as typeof fetch });
  expect((await handler(request("/v1/responses", { origin: "https://example.com" }))).status).toBe(401);
  expect((await handler(request("/v1/responses", { authorization: "wrong" }))).status).toBe(401);
  expect((await handler(request("/v1/anything"))).status).toBe(404);
  expect(calls).toBe(0);
  expect((await handler(request())).status).toBe(429);
  expect(calls).toBe(1);
});

test("enable/disable preserves unrelated config edits and the original provider", () => {
  const original = 'model_provider = "previous"\nmodel = "gpt-6-astra"\n[features]\nfoo = true\n';
  const configured = configureProxy(original, 18789, "/tmp/router");
  expect((Bun.TOML.parse(configured) as any).model_provider).toBe("router");
  expect(configureProxy(configured, 18789, "/tmp/router")).toBe(configured);
  const restored = unconfigureProxy(configured.replace("foo = true", "foo = false"), original);
  expect((Bun.TOML.parse(restored) as any).model_provider).toBe("previous");
  expect((Bun.TOML.parse(restored) as any).features.foo).toBe(false);
  expect(restored).not.toContain("model_providers.router");
  expect(() => configureProxy('[model_providers.router]\nname = "existing"\n', 18789, "/tmp/router")).toThrow();
});

test("preserves compressed request framing without forwarding arbitrary auth", async () => {
  const bytes = new Uint8Array([40, 181, 47, 253, 1, 2, 3]);
  const handler = createProxyHandler({ token: "local", credential: async () => accounts.a!,
    upstream: (async (_url, init) => {
      const headers = new Headers(init!.headers);
      expect(headers.get("content-encoding")).toBe("zstd");
      expect(new Uint8Array(init!.body as ArrayBuffer)).toEqual(bytes);
      return new Response("ok");
    }) as typeof fetch });
  expect((await handler(new Request("http://127.0.0.1/v1/responses", {method:"POST", headers:{authorization:"Bearer local","content-type":"application/json","content-encoding":"zstd"},body:bytes}))).status).toBe(200);
});
test("distinguishes client cancellation and records safe network codes without leaking error text", async () => {
  const events: any[] = [];
  const controller = new AbortController();
  const handler = createProxyHandler({ token:"local",credential:async()=>accounts.a!,observe:e=>events.push(e),
    upstream:(async()=>{throw Object.assign(new Error("secret request content"),{code:"ECONNRESET"})}) as typeof fetch });
  const response = await handler(request());
  expect(response.status).toBe(502);
  expect(await response.text()).not.toContain("secret request content");
  expect(events[0].failure).toBe("ECONNRESET");
  controller.abort();
  const canceled = await handler(new Request(request(),{signal:controller.signal}));
  expect(canceled.status).toBe(499);
  expect(events[1].failure).toBe("client_canceled");
});
test("compresses large conversation uploads losslessly and never retries failed inference", async () => {
  const original = JSON.stringify({input:'Long conversation. '.repeat(10000)});
  let calls = 0;
  const handler = createProxyHandler({token:'local',credential:async()=>accounts.a!,upstream:(async(_url,init)=>{
    calls++;
    expect(new Headers(init!.headers).get('content-encoding')).toBe('zstd');
    const wire = init!.body as Uint8Array;
    expect(wire.byteLength).toBeLessThan(original.length / 10);
    expect(new TextDecoder().decode(await Bun.zstdDecompress(wire))).toBe(original);
    throw Object.assign(new Error('reset'),{code:'ECONNRESET'});
  }) as typeof fetch});
  const response = await handler(new Request('http://127.0.0.1/v1/responses',{method:'POST',headers:{authorization:'Bearer local','content-type':'application/json'},body:original}));
  expect(response.status).toBe(502);
  expect(calls).toBe(1);
});
