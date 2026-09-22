import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { DIR, HOME, ensureDir, exitOnSigterm } from "./common.ts";
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

export function providerConfig(port: number, launcher: string): string {
  return `[model_providers.router]
name = "OpenAI via Router"
base_url = "http://127.0.0.1:${port}/v1"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
stream_idle_timeout_ms = 300000
[model_providers.router.auth]
command = ${JSON.stringify(launcher)}
args = ["proxy", "token"]
`;
}

export function configureProxy(original: string, port: number, launcher: string): string {
  if (original.includes(BEGIN)) return original;
  const parsed = Bun.TOML.parse(original) as any;
  if (parsed.model_providers?.router) throw new Error("A provider named router already exists; refusing to overwrite it");
  const firstTable = original.search(/^\s*\[/m);
  const root = firstTable < 0 ? original : original.slice(0, firstTable);
  const rest = firstTable < 0 ? "" : original.slice(firstTable);
  const next = `${BEGIN}\nmodel_provider = "router"\n${END}\n` + root.replace(/^model_provider\s*=.*\n?/m, "") + rest
    + `\n${TABLE_BEGIN}\n${providerConfig(port, launcher)}${TABLE_END}\n`;
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
    try { await health(); console.log("Router proxy is already running."); return; } catch {}
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
    const domain = `gui/${process.getuid!()}`;
    Bun.spawnSync(["launchctl", "bootout", `${domain}/${LABEL}`]);
    const result = Bun.spawnSync(["launchctl", "bootstrap", domain, PLIST]);
    if (result.exitCode) throw new Error("Could not start Router proxy service");
    for (let attempt = 0; attempt < 30; attempt++) {
      try { await health(); console.log("Router proxy is running on loopback."); return; } catch { await Bun.sleep(200); }
    }
    throw new Error("Proxy did not become healthy; inspect ~/.router/codex-proxy.log");
  }
  if (command === "enable") {
    await health();
    const original = readFileSync(CONFIG, "utf8");
    if (!original.includes(BEGIN)) {
      const next = configureProxy(original, settings().port, join(DIR, "bin/router"));
      copyFileSync(CONFIG, BACKUP);
      atomic(CONFIG, next);
    }
    console.log("Codex now defaults to Router. Relaunch existing sessions once; future account switches apply between requests.");
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
