import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { DIR, HOME, ensureDir, exitOnSigterm, reloadLaunchAgent } from "./common.ts";
import { beginMeter } from "./meter-client.ts";
import { createProxyHandler, type ProxyObservation } from "./codex-proxy.ts";
import { proxyCredential, proxySelection, enableProxySelection, disableProxySelection } from "./codex.ts";

const SETTINGS = join(DIR, "codex-proxy.json");
const TOKEN = join(DIR, "codex-proxy.token");
const STATUS = join(DIR, "codex-proxy-status.json");
const LABEL = "dev.bryan.router.codex-proxy";
const PLIST = join(HOME, "Library/LaunchAgents", `${LABEL}.plist`);
const CONFIG = join(HOME, ".codex/config.toml");
const BACKUP = join(DIR, "codex-config-before-proxy.toml");
const BEGIN = "# router-proxy: begin";
const END = "# router-proxy: end";
const TABLE_BEGIN = "# router-proxy-provider: begin";
const TABLE_END = "# router-proxy-provider: end";

function settings(): { port: number } {
  const value = JSON.parse(readFileSync(SETTINGS, "utf8"));
  if (!Number.isInteger(value.port) || value.port < 1024 || value.port > 65535) throw new Error("Invalid proxy port");
  return value;
}
function token() {
  const value = readFileSync(TOKEN, "utf8").trim();
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("Invalid proxy token");
  return value;
}
function atomic(path: string, value: string) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, value, { mode: 0o600 });
  renameSync(tmp, path);
}
const xml = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

export function providerConfig(port: number, localToken: string): string {
  if (!/^[a-f0-9]{64}$/.test(localToken)) throw new Error("Invalid proxy token");
  return `[model_providers.router]
name = "OpenAI via Router"
base_url = "http://127.0.0.1:${port}/v1"
wire_api = "responses"
requires_openai_auth = true
http_headers = { "x-router-token" = "${localToken}" }
supports_websockets = false
stream_idle_timeout_ms = 300000
`;
}

export function configureProxy(original: string, port: number, localToken: string): string {
  const provider = providerConfig(port, localToken);
  if (original.includes(BEGIN)) {
    // Upgrade only our marked provider block, preserving the user's other edits
    // and the original pre-Router backup used by disable.
    if (!original.includes(TABLE_BEGIN) || !original.includes(TABLE_END)) throw new Error("Router provider markers are incomplete; refusing to overwrite config");
    const next = original.replace(new RegExp(`${TABLE_BEGIN}[\\s\\S]*?${TABLE_END}`), `${TABLE_BEGIN}\n${provider}${TABLE_END}`);
    Bun.TOML.parse(next);
    return next;
  }
  const parsed = Bun.TOML.parse(original) as any;
  if (parsed.model_providers?.router) throw new Error("A provider named router already exists; refusing to overwrite it");
  const firstTable = original.search(/^\s*\[/m);
  const root = firstTable < 0 ? original : original.slice(0, firstTable);
  const rest = firstTable < 0 ? "" : original.slice(firstTable);
  const next = `${BEGIN}\nmodel_provider = "router"\n${END}\n` + root.replace(/^model_provider\s*=.*\n?/m, "") + rest
    + `\n${TABLE_BEGIN}\n${provider}${TABLE_END}\n`;
  Bun.TOML.parse(next);
  return next;
}

export function unconfigureProxy(current: string, original: string): string {
  if (!current.includes(BEGIN)) return current;
  const old = Bun.TOML.parse(original) as any;
  let next = current.replace(new RegExp(`${BEGIN}[\\s\\S]*?${END}\\n?`), "")
    .replace(new RegExp(`\\n?${TABLE_BEGIN}[\\s\\S]*?${TABLE_END}\\n?`), "");
  if (old.model_provider) next = `model_provider = ${JSON.stringify(old.model_provider)}\n` + next;
  Bun.TOML.parse(next);
  return next;
}

async function health() {
  const r = await fetch(`http://127.0.0.1:${settings().port}/health`, {
    headers: { authorization: `Bearer ${token()}` }, signal: AbortSignal.timeout(1500),
  });
  if (!r.ok) throw new Error("Proxy health check failed");
  const result: any = await r.json();
  if (result.service !== "router-codex-proxy") throw new Error("Unexpected service on proxy port");
  return result;
}

export async function proxyDoctor(report: (good: boolean, message: string) => void) {
  if (!existsSync(CONFIG)) return;
  try {
    const config = Bun.TOML.parse(readFileSync(CONFIG, "utf8")) as any;
    if (config.model_provider !== "router") return;
    const provider = config.model_providers?.router;
    report(provider?.requires_openai_auth === true && !provider?.auth,
      "Router preserves ChatGPT browser/plugin authentication (repair: router proxy install && router proxy enable)");
    report(provider?.http_headers?.["x-router-token"] === token(), "Router provider local authentication matches the service");
    const live = await health();
    report(live.separateClientAuth === true, "Router proxy supports separate client authentication");
  } catch {
    report(false, "Router proxy config/service needs repair: router proxy install && router proxy enable");
  }
}

export async function proxyCommand(args: string[]) {
  const command = args[0];
  if (command === "token") { process.stdout.write(token()); return; }
  if (command === "serve") {
    const { port } = settings();
    const startedAt = new Date().toISOString();
    let requests = 0;
    const recent: ProxyObservation[] = [];
    const status = () => ({ metering: true, pid: process.pid, port, startedAt, selected: proxySelection(), requests, recent });
    const server = Bun.serve({ hostname: "127.0.0.1", port, idleTimeout: 0, maxRequestBodySize: 64 * 1024 * 1024,
      fetch: createProxyHandler({ token: token(), credential: proxyCredential, status,
        meter: credential => beginMeter({ provider: "codex", profile: credential.name, accessToken: credential.accessToken, accountId: credential.accountId }),
        observe(event) {
          requests++;
          recent.push(event);
          if (recent.length > 64) recent.shift();
          atomic(STATUS, JSON.stringify(status()) + "\n");
        },
      }),
      error() { return Response.json({ error: { message: "Router proxy request failed" } }, { status: 500 }); },
    });
    atomic(STATUS, JSON.stringify(status()) + "\n");
    exitOnSigterm(server);
    return;
  }
  if (command === "install") {
    ensureDir();
    if (!existsSync(TOKEN)) atomic(TOKEN, randomBytes(32).toString("hex") + "\n");
    if (!existsSync(SETTINGS)) atomic(SETTINGS, JSON.stringify({ port: 18789 }) + "\n");
    if (!proxySelection()) enableProxySelection();
    await proxyCredential();
    try {
      const live = await health();
      if (live.separateClientAuth) { console.log("Router proxy is already running."); return; }
      console.log("Updating Router proxy to support separate browser authentication.");
    } catch {}
    mkdirSync(join(HOME, "Library/LaunchAgents"), { recursive: true });
    const runtime = join(DIR, "lib/router.ts");
    if (!existsSync(runtime)) throw new Error("Run ./install.sh first");
    const envPath = process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin";
    atomic(PLIST, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${LABEL}</string>
<key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(runtime)}</string><string>proxy</string><string>serve</string></array>
<key>EnvironmentVariables</key><dict><key>HOME</key><string>${xml(HOME)}</string><key>PATH</key><string>${xml(envPath)}</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer>
<key>WorkingDirectory</key><string>${xml(DIR)}</string>
<key>StandardOutPath</key><string>${xml(join(DIR, "codex-proxy.log"))}</string>
<key>StandardErrorPath</key><string>${xml(join(DIR, "codex-proxy.log"))}</string>
</dict></plist>\n`);
    if (!await reloadLaunchAgent(LABEL, PLIST)) throw new Error("Could not start Router proxy service");
    for (let attempt = 0; attempt < 30; attempt++) {
      try { await health(); console.log("Router proxy is running on loopback."); return; } catch { await Bun.sleep(200); }
    }
    throw new Error("Proxy did not become healthy; inspect ~/.router/codex-proxy.log");
  }
  if (command === "enable") {
    const live = await health();
    if (!live.separateClientAuth) throw new Error("Restart the updated Router proxy before enabling browser-compatible authentication");
    const original = readFileSync(CONFIG, "utf8");
    const next = configureProxy(original, settings().port, token());
    if (next !== original) {
      if (!original.includes(BEGIN)) copyFileSync(CONFIG, BACKUP);
      else copyFileSync(CONFIG, join(DIR, `codex-config-before-auth-upgrade-${Date.now()}.toml`));
      atomic(CONFIG, next);
    }
    console.log("Codex now defaults to Router with ChatGPT browser/plugin authentication preserved. Resume existing sessions once to load the updated provider; future model account switches apply between requests.");
    return;
  }
  if (command === "disable") {
    atomic(CONFIG, unconfigureProxy(readFileSync(CONFIG, "utf8"), readFileSync(BACKUP, "utf8")));
    disableProxySelection();
    console.log("Restored the previous default provider. Existing routed sessions can finish; relaunch to use direct login.");
    return;
  }
  if (command === "status") { console.log(JSON.stringify(await health(), null, 2)); return; }
  throw new Error("usage: router proxy <install|enable|disable|status>");
}
