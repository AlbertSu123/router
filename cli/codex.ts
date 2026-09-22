// codex: the Codex half of router — switch which ChatGPT account the Codex
// CLI signs its requests with.
//
// Codex keeps its credential in a file (~/.codex/auth.json), not the
// keychain, so a switch is a file swap rather than a keychain swap. That
// file is also the source of truth for which account is active: Codex
// rewrites it every time it refreshes the token pair, and `codex login` and
// `codex logout` write it too. So every command here starts with sync(),
// which parks whatever the file currently holds in that account's own
// profile slot and re-points `current` at it. Inactive profiles wait in the
// keychain (service "router-codex"); nothing but the active credential is
// ever on disk.
//
// There is no "main" here, unlike the Claude side. A Claude profile is a
// token router minted itself, weaker than the real login, so the real login
// has to be stashed and restored. A Codex profile is the complete auth.json
// Codex itself wrote, refresh token included — every account is a peer, and
// none needs stashing.
//
// Direct Codex authentication cannot reach a running session. Codex pins the
// account a session started with and refuses to reload auth.json for a
// different account_id ("Skipping auth reload due to account id mismatch"),
// so a file swap lands on the next session you start. The optional local
// proxy selects credentials for every request instead, reaching running
// sessions that were launched with the router model provider.

import { parseResetCredits } from "./codex-resets.ts";
import { deviceChallenge } from "./codex-login.ts";

import {
  mkdirSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  DIR,
  HOME,
  ensureDir,
  keychainDelete,
  keychainRead,
  keychainWrite,
  SignedOutError,
  uniqueName,
  windowLabel,
  type Limit,
  type UsageRow,
} from "./common.ts";

export const PREFIX = "codex:";

const CODEX_HOME = process.env.CODEX_HOME ?? join(HOME, ".codex");
const AUTH_FILE = join(CODEX_HOME, "auth.json");
const PROFILES_FILE = join(DIR, "codex-profiles.json");
const CURRENT_FILE = join(DIR, "codex-current");
const PROXY_SELECTION = join(DIR, "codex-proxy-selection");
const LOGIN_PID_FILE = join(DIR, "codex-login.pid");
const LOGIN_SESSION_FILE = join(DIR, "codex-login-session");
const LOGIN_STATUS_FILE = join(DIR, "codex-login-status.json");
const CACHE_DIR = join(DIR, "cache");
const SERVICE = "router-codex";

// Codex's own OAuth client. `codex login` runs the flow; router only reads
// the result and refreshes it, so this id is needed for refreshes alone.
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const USAGE_URL = "https://chatgpt.com/backend-api/codex/usage";
const REFRESH_SCOPE = "openid profile email offline_access";
// Let Codex enforce its 15-minute device-code expiry; allow startup overhead.
const LOGIN_TIMEOUT_MS = 16 * 60 * 1000;
const REFRESH_MARGIN_MS = 30 * 60 * 1000;
const USAGE_CACHE_MS = 2 * 3600 * 1000;

// auth.json as Codex writes it for a ChatGPT login. An API key or Bedrock
// login fills other fields instead and leaves `tokens` out.
type Auth = {
  auth_mode?: string;
  OPENAI_API_KEY?: string | null;
  tokens?: {
    id_token: string;
    access_token: string;
    refresh_token: string;
    account_id: string;
  };
  last_refresh?: string;
};

type CodexProfile = {
  accountId: string;
  email?: string;
  plan?: string;
  addedAt: string;
  // Set when OpenAI rejected the refresh token outright; only a new sign-in,
  // which rewrites the whole entry, clears it.
  signedOutAt?: number;
};
type CodexProfiles = Record<string, CodexProfile>;

class CodexError extends Error {}

function fail(msg: string): never {
  throw new CodexError(msg);
}

// --- state --------------------------------------------------------------------

function loadProfiles(): CodexProfiles {
  try {
    return JSON.parse(readFileSync(PROFILES_FILE, "utf8")).profiles ?? {};
  } catch {
    return {};
  }
}

function saveProfiles(profiles: CodexProfiles) {
  ensureDir();
  writeFileSync(PROFILES_FILE, JSON.stringify({ profiles }, null, 2) + "\n", { mode: 0o600 });
}

function currentName(): string | null {
  try {
    return readFileSync(CURRENT_FILE, "utf8").trim() || null;
  } catch {
    return null;
  }
}

export function proxySelection(): string | null {
  try { return readFileSync(PROXY_SELECTION, "utf8").trim() || null; } catch { return null; }
}

export function setProxySelection(name: string) {
  const tmp = `${PROXY_SELECTION}.${process.pid}.tmp`;
  writeFileSync(tmp, name + "\n", { mode: 0o600 });
  renameSync(tmp, PROXY_SELECTION);
}

export function enableProxySelection() {
  const name = sync();
  if (!name) fail("sign in to a Codex account before enabling the proxy");
  setProxySelection(name);
}

export function disableProxySelection() { rmSync(PROXY_SELECTION, { force: true }); }

export function isSignedOut(name: string): boolean {
  return !!loadProfiles()[name]?.signedOutAt;
}

function markSignedOut(name: string) {
  const profiles = loadProfiles();
  if (!profiles[name] || profiles[name].signedOutAt) return;
  profiles[name].signedOutAt = Date.now();
  saveProfiles(profiles);
}

function setCurrent(name: string | null) {
  ensureDir();
  if (name) writeFileSync(CURRENT_FILE, name + "\n", { mode: 0o600 });
  else rmSync(CURRENT_FILE, { force: true });
}

function readBlob(name: string): Auth | null {
  const raw = keychainRead(SERVICE, name);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeBlob(name: string, auth: Auth) {
  const blob = JSON.stringify(auth);
  if (keychainRead(SERVICE, name) === blob) return;
  keychainWrite(SERVICE, name, blob);
}

// --- the live credential file ---------------------------------------------------

function readAuth(): Auth | null {
  try {
    return JSON.parse(readFileSync(AUTH_FILE, "utf8"));
  } catch {
    return null;
  }
}

// Codex may be reading the file at any moment, so the swap is a rename.
function writeAuth(auth: Auth) {
  mkdirSync(CODEX_HOME, { recursive: true, mode: 0o700 });
  const tmp = join(CODEX_HOME, `.auth.json.router-${process.pid}`);
  writeFileSync(tmp, JSON.stringify(auth, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, AUTH_FILE);
}

function claims(jwt: string | undefined): Record<string, any> {
  if (!jwt) return {};
  try {
    const part = jwt.split(".")[1];
    if (!part) return {};
    return JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
  } catch {
    return {};
  }
}

type Identity = { accountId: string; email?: string; plan?: string };

function identify(auth: Auth): Identity | null {
  const accountId = auth.tokens?.account_id;
  if (!accountId) return null;
  const id = claims(auth.tokens?.id_token);
  const access = claims(auth.tokens?.access_token);
  const openai = id["https://api.openai.com/auth"] ?? access["https://api.openai.com/auth"] ?? {};
  return {
    accountId,
    email: id.email ?? access["https://api.openai.com/profile"]?.email,
    plan: openai.chatgpt_plan_type,
  };
}

function expiresAt(auth: Auth): number | undefined {
  const exp = claims(auth.tokens?.access_token).exp;
  return typeof exp === "number" ? exp * 1000 : undefined;
}

// Router can only park a ChatGPT login. Anything else in auth.json (an API
// key, a Bedrock credential) would be lost by a swap, so a switch stops
// rather than overwrite it.
function guardLive() {
  const auth = readAuth();
  if (!auth) return;
  if (identify(auth)) return;
  fail(
    `${AUTH_FILE} holds a credential router does not manage ` +
      `(auth mode "${auth.auth_mode ?? "unknown"}") — move it aside before switching`,
  );
}

// Reconcile router's view with the file. Whatever account auth.json holds
// is the active one, and its contents are the freshest copy of that
// account's tokens; an account seen for the first time becomes a profile.
function sync(): string | null {
  const auth = readAuth();
  const id = auth ? identify(auth) : null;
  if (!auth || !id) {
    if (currentName()) setCurrent(null);
    return null;
  }
  const profiles = loadProfiles();
  let name = Object.entries(profiles).find(([, p]) => p.accountId === id.accountId)?.[0];
  const before = name ? JSON.stringify(profiles[name]) : null;
  if (name) {
    profiles[name] = {
      ...profiles[name]!,
      email: id.email ?? profiles[name]!.email,
      plan: id.plan ?? profiles[name]!.plan,
    };
  } else {
    name = uniqueName(id.email, new Set(Object.keys(profiles)));
    profiles[name] = {
      accountId: id.accountId,
      email: id.email,
      plan: id.plan,
      addedAt: new Date().toISOString(),
    };
  }
  // The menu bar app calls this every few seconds; only a real change is
  // worth a write.
  if (JSON.stringify(profiles[name]) !== before) saveProfiles(profiles);
  // A legacy client can still hold the old refresh-token generation. Never
  // overwrite a newer Router refresh with that older on-disk snapshot.
  const stored = readBlob(name);
  if (!stored || Date.parse(stored.last_refresh ?? "") <= Date.parse(auth.last_refresh ?? "") || !stored.last_refresh) writeBlob(name, auth);
  const selected = proxySelection();
  const current = selected && profiles[selected] ? selected : name;
  if (currentName() !== current) setCurrent(current);
  return current;
}

// --- oauth --------------------------------------------------------------------

// Only an inactive profile is router's to refresh: Codex keeps the active
// one current itself, and the refresh token is single-use, so racing it
// would strand the session that is actually running.
async function refreshBlob(name: string, auth: Auth): Promise<Auth | null> {
  // Menu usage polling and the proxy are separate processes. Serialize token
  // rotation, then re-read in case another process already rotated this token.
  const lock = join(DIR, `codex-refresh-${name}.lock`);
  const until = Date.now() + 15000;
  while (true) {
    try { mkdirSync(lock, { mode: 0o700 }); break; }
    catch {
      try { if (Date.now() - statSync(lock).mtimeMs > 45000) { rmSync(lock, { recursive: true, force: true }); continue; } } catch {}
      if (Date.now() > until) return null;
      await Bun.sleep(100);
    }
  }
  try {
    const latest = readBlob(name);
    if (latest?.tokens && latest.tokens.refresh_token !== auth.tokens?.refresh_token) return latest;
    return await refreshBlobLocked(name, latest ?? auth);
  } finally { rmSync(lock, { recursive: true, force: true }); }
}

async function refreshBlobLocked(name: string, auth: Auth): Promise<Auth | null> {
  const refreshToken = auth.tokens?.refresh_token;
  if (!refreshToken) return null;
  try {
    const r = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        scope: REFRESH_SCOPE,
      }),
      signal: AbortSignal.timeout(10000),
    });
    // 400/401 is a verdict on the token itself (revoked, reused, expired);
    // anything else may be transient and must not sign the account out.
    if (r.status === 400 || r.status === 401) markSignedOut(name);
    if (!r.ok) return null;
    const body: any = await r.json();
    if (typeof body.access_token !== "string") return null;
    const next: Auth = {
      ...auth,
      tokens: {
        ...auth.tokens!,
        access_token: body.access_token,
        id_token: typeof body.id_token === "string" ? body.id_token : auth.tokens!.id_token,
        refresh_token:
          typeof body.refresh_token === "string" ? body.refresh_token : auth.tokens!.refresh_token,
      },
      last_refresh: new Date().toISOString(),
    };
    writeBlob(name, next);
    if (readAuth()?.tokens?.account_id === next.tokens?.account_id) writeAuth(next);
    return next;
  } catch {
    return null;
  }
}

export async function proxyCredential(name = proxySelection() ?? currentName() ?? "", force = false) {
  const profile = loadProfiles()[name];
  if (!profile) fail("no selected Codex profile");
  if (profile.signedOutAt) throw new SignedOutError(PREFIX + name);
  let auth = readBlob(name);
  if (!auth?.tokens || auth.tokens.account_id !== profile.accountId) fail("selected profile has invalid credentials");
  const expires = expiresAt(auth);
  if (force || (typeof expires === "number" && expires < Date.now() + 60000)) {
    auth = await refreshBlob(name, auth);
    if (isSignedOut(name)) throw new SignedOutError(PREFIX + name);
    if (!auth?.tokens) fail("selected profile could not refresh; sign in again");
  }
  return { name, accessToken: auth.tokens.access_token, accountId: auth.tokens.account_id };
}

// --- usage --------------------------------------------------------------------

// The windows the endpoint reports, shortest first: the short one is what
// stops the next request, the long one is the plan's outer bound. Their
// lengths differ by plan, so each carries the label its length implies
// rather than an assumed "5h"/"7d".
function asLimit(w: any): { limit: Limit; seconds: number } | null {
  if (typeof w?.used_percent !== "number") return null;
  const seconds = typeof w.limit_window_seconds === "number" ? w.limit_window_seconds : 0;
  return {
    seconds,
    limit: {
      pct: Math.round(w.used_percent),
      reset: typeof w.reset_at === "number" ? w.reset_at : undefined,
      label: seconds ? windowLabel(seconds) : undefined,
    },
  };
}

function windowsOf(rateLimit: any): Limit[] {
  return [rateLimit?.primary_window, rateLimit?.secondary_window]
    .map(asLimit)
    .filter((w): w is { limit: Limit; seconds: number } => w !== null)
    .sort((a, b) => a.seconds - b.seconds)
    .map((w) => w.limit);
}

function parseUsage(body: any): UsageRow | null {
  const resets = parseResetCredits(body?.rate_limit_reset_credits, body?.router_reset_details);
  const [short, long] = windowsOf(body?.rate_limit);
  const scoped: Record<string, Limit> = {};
  for (const extra of Array.isArray(body?.additional_rate_limits) ? body.additional_rate_limits : []) {
    const limit = windowsOf(extra?.rate_limit)[0];
    if (limit) scoped[extra.limit_name ?? extra.metered_feature ?? "scoped"] = limit;
  }
  if (!short && !long && !Object.keys(scoped).length && !resets) return null;
  return {
    resets,
    five: short,
    week: long,
    scoped: Object.keys(scoped).length ? scoped : undefined,
    exact: true,
  };
}

async function fetchUsage(auth: Auth, url = USAGE_URL): Promise<any | null> {
  return (await fetchUsageStatus(auth, url)).body;
}

async function fetchUsageStatus(auth: Auth, url = USAGE_URL): Promise<{ status: number; body: any | null }> {
  try {
    const r = await fetch(url, {
      headers: {
        Authorization: `Bearer ${auth.tokens!.access_token}`,
        "chatgpt-account-id": auth.tokens!.account_id,
        originator: "codex_cli_rs",
      },
      signal: AbortSignal.timeout(8000),
    });
    return { status: r.status, body: r.ok ? await r.json() : null };
  } catch {
    return { status: 0, body: null };
  }
}

// Usage per Codex account, keyed by profile name. A failed fetch falls back
// to the last successful reading for that account (2h), so a transient
// error does not blank the row.
export async function usage(): Promise<Record<string, UsageRow>> {
  const active = sync();
  const profiles = loadProfiles();
  mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 });
  const out: Record<string, UsageRow> = {};
  await Promise.all(
    Object.keys(profiles).map(async (name) => {
      if (profiles[name]!.signedOutAt) { out[name] = { signedOut: true }; return; }
      let auth = readBlob(name);
      if (!auth?.tokens) return;
      const exp = expiresAt(auth);
      if (name !== active && typeof exp === "number" && exp - Date.now() <= REFRESH_MARGIN_MS) {
        auth = (await refreshBlob(name, auth)) ?? auth;
      }
      let { status, body } = await fetchUsageStatus(auth);
      // A rejected access token is dead for whoever holds it, the active
      // profile included, so refreshing it cannot strand a working session.
      if (status === 401) {
        const next = await refreshBlob(name, auth);
        if (isSignedOut(name)) { out[name] = { signedOut: true }; return; }
        if (next) { auth = next; ({ body } = await fetchUsageStatus(auth)); }
      }
      const cache = join(CACHE_DIR, `codex-usage-${name}.json`);
      if (body) {
        if (body.rate_limit_reset_credits?.available_count > 0) {
          body.router_reset_details = await fetchUsage(auth, "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits");
        }
        const row = parseUsage(body);
        if (row) {
          out[name] = { ...row, observedAt: Date.now() / 1000, stale: false };
          writeFileSync(cache, JSON.stringify(body), { mode: 0o600 });
        }
        return;
      }
      try {
        if (Date.now() - statSync(cache).mtimeMs < USAGE_CACHE_MS) {
          const row = parseUsage(JSON.parse(readFileSync(cache, "utf8")));
          if (row) out[name] = { ...row, observedAt: statSync(cache).mtimeMs / 1000, stale: true };
        }
      } catch {}
    }),
  );
  return out;
}

// --- the codex binary -----------------------------------------------------------

function isExec(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

// The npm-installed codex is a `#!/usr/bin/env node` script, and the menu
// bar app inherits launchd's PATH, which has no node in it. Whatever
// runtime the CLI came with sits next to it, so its directory is added as a
// last resort — appended, not prepended, because a codex that is itself a
// PATH shim resolves the real one by looking further down the same PATH.
function pathFor(bin: string): string {
  return [process.env.PATH, dirname(bin)].filter(Boolean).join(":");
}

export function codexEnv(extra: Record<string, string> = {}): Record<string, string> {
  return { ...process.env, ...extra, PATH: pathFor(codex().bin) } as Record<string, string>;
}

// A candidate counts as found only if it answers `--version`. Being on
// PATH is not enough: a wrapper script that re-execs the real codex is
// itself on PATH and fails when it cannot reach it, and asking is cheaper
// than guessing which entry is a shim.
function runs(bin: string): string | null {
  if (!isExec(bin)) return null;
  const p = Bun.spawnSync([bin, "--version"], { env: { ...process.env, PATH: pathFor(bin) } });
  if (p.exitCode !== 0) return null;
  return p.stdout.toString().trim().split("\n")[0] ?? "";
}

let resolved: { bin: string; version: string } | null = null;

// The menu bar app inherits launchd's bare PATH, so a login shell lookup is
// the first try and the usual install locations are the fallback.
export function codex(): { bin: string; version: string } {
  if (resolved) return resolved;
  const candidates: string[] = [];
  if (process.env.ROUTER_CODEX_BIN) candidates.push(process.env.ROUTER_CODEX_BIN);
  // `whence -p` skips a shell function of the same name, which many
  // people wrap codex in.
  const shell = Bun.spawnSync(["/bin/zsh", "-lc", "whence -p codex"]);
  const found = shell.stdout.toString().trim().split("\n").pop()?.trim();
  if (found) candidates.push(found);
  candidates.push(
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
    join(HOME, ".local/bin/codex"),
    join(HOME, ".bun/bin/codex"),
  );
  try {
    const nvm = join(HOME, ".nvm/versions/node");
    for (const version of readdirSync(nvm).sort().reverse()) {
      candidates.push(join(nvm, version, "bin/codex"));
    }
  } catch {}
  for (const bin of candidates) {
    const version = runs(bin);
    if (version !== null) {
      resolved = { bin, version };
      return resolved;
    }
  }
  fail("no working codex CLI was found — install it, or set ROUTER_CODEX_BIN to its path");
}

function codexBin(): string {
  return codex().bin;
}

// --- commands -------------------------------------------------------------------

export type Added = { name: string; email?: string; plan?: string };

// The sign-in is Codex's own: `codex login` runs the OAuth flow, binds its
// callback port, and opens the browser. Pointing it at a throwaway
// CODEX_HOME means the live credential is never touched — the new account
// lands in a temp auth.json that router reads and parks.
export async function add(onUrl?: (url: string) => void, device = false, session = "cli", onCode?: (code: string) => void, replace = false): Promise<Added> {
  const bin = codexBin();
  ensureDir();
  if (replace) {
    cancelAdd();
    // Wait for the old command to finish its cleanup before publishing a new
    // PID/challenge, otherwise its finally block could erase the new request.
    for (let attempt = 0; attempt < 100; attempt++) {
      let oldPid = 0;
      try { oldPid = Number(readFileSync(LOGIN_PID_FILE, "utf8").trim()); } catch { break; }
      const command = Bun.spawnSync(["ps", "-p", String(oldPid), "-o", "command="]).stdout.toString();
      if (!command.includes("codex")) {
        // Allow the parent to drain its pipes and remove the old state.
        await Bun.sleep(200);
        rmSync(LOGIN_PID_FILE, { force: true });
        break;
      }
      await Bun.sleep(50);
    }
  }
  try {
    const pid = Number(readFileSync(LOGIN_PID_FILE, "utf8").trim());
    if (pid > 0) {
      try { process.kill(pid, 0); fail("A Codex sign-in is already running. Close it before starting another."); }
      catch (e) { if (e instanceof CodexError) throw e; }
    }
  } catch (e) { if (e instanceof CodexError) throw e; }
  rmSync(LOGIN_STATUS_FILE, { force: true });
  const home = mkdtempSync(join(tmpdir(), "router-codex-"));
  const proc = Bun.spawn([bin, "login", "-c", 'cli_auth_credentials_store="file"', ...(device ? ["--device-auth"] : [])], {
    env: codexEnv({ CODEX_HOME: home }),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  ensureDir();
  writeFileSync(LOGIN_PID_FILE, `${proc.pid}\n`, { mode: 0o600 });
  writeFileSync(LOGIN_SESSION_FILE, session, { mode: 0o600 });

  const timer = setTimeout(() => killLogin(proc.pid), LOGIN_TIMEOUT_MS);
  let stderr = "";
  let announced = false;
  const watch = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    let output = "";
    for await (const chunk of stream) {
      output += decoder.decode(chunk, { stream: true });
      if (stream === proc.stderr) stderr = output;
      if (announced) continue;
      if (device) {
        const challenge = deviceChallenge(output);
        if (challenge) {
          announced = true;
          writeFileSync(LOGIN_STATUS_FILE, JSON.stringify({ session, ...challenge }), { mode: 0o600 });
          onUrl?.(challenge.url);
          onCode?.(challenge.code);
        }
      } else {
        const url = output.match(/https:\/\/auth\.openai\.com\/\S+/)?.[0];
        if (url) { announced = true; onUrl?.(url); }
      }
    }
  };

  try {
    await Promise.all([proc.exited, watch(proc.stdout), watch(proc.stderr)]);
  } catch {
    killLogin(proc.pid);
    rmSync(home, { recursive: true, force: true });
    fail("The Codex sign-in was interrupted. Try again.");
  } finally {
    clearTimeout(timer);
    try {
      if (Number(readFileSync(LOGIN_PID_FILE, "utf8").trim()) === proc.pid) {
        rmSync(LOGIN_PID_FILE, { force: true });
        rmSync(LOGIN_STATUS_FILE, { force: true });
        rmSync(LOGIN_SESSION_FILE, { force: true });
      }
    } catch {}
  }

  let auth: Auth | null = null;
  try {
    auth = JSON.parse(readFileSync(join(home, "auth.json"), "utf8"));
  } catch {}
  rmSync(home, { recursive: true, force: true });

  const id = auth ? identify(auth) : null;
  if (!auth || !id) {
    const detail = stderr.trim().split("\n").filter(Boolean).pop();
    fail(`the Codex sign-in did not complete${detail ? ` — ${detail}` : ""}`);
  }

  // Adding an account router already knows refreshes it in place.
  const profiles = loadProfiles();
  const existing = Object.entries(profiles).find(([, p]) => p.accountId === id.accountId)?.[0];
  const name = existing ?? uniqueName(id.email, new Set(Object.keys(profiles)));
  profiles[name] = {
    accountId: id.accountId,
    email: id.email,
    plan: id.plan,
    addedAt: profiles[name]?.addedAt ?? new Date().toISOString(),
  };
  saveProfiles(profiles);
  writeBlob(name, auth);
  // A re-add of the account that is live also refreshes what Codex is
  // holding; anything else stays parked until it is switched to.
  if (name === currentName()) writeAuth(auth);
  return { name, email: id.email, plan: id.plan };
}

// An abandoned sign-in keeps Codex's callback port bound, which makes the
// next one fail, so the window that started it can call this off.
export function cancelAdd(session?: string) {
  if (session) {
    try { if (readFileSync(LOGIN_SESSION_FILE, "utf8") !== session) return; }
    catch { return; }
  }
  let pid = 0;
  try {
    pid = Number(readFileSync(LOGIN_PID_FILE, "utf8").trim());
  } catch {}
  rmSync(LOGIN_STATUS_FILE, { force: true });
  if (pid > 0) killLogin(pid);
}

// The npm-installed codex is a node script that re-execs the real binary,
// so the process router spawned is not the one holding the callback port —
// its grandchild is. Signalling only the child leaves 1455 bound and the
// next sign-in fails.
function killLogin(pid: number) {
  // A stale pid file outlives the sign-in it named and pids get reused, so
  // the process has to still be the codex it claims to be. `command`
  // rather than `comm`: through the node shim, comm is just "node".
  const command = Bun.spawnSync(["ps", "-p", String(pid), "-o", "command="]).stdout.toString();
  if (!command.includes("codex")) return;
  for (const target of [...descendants(pid).reverse(), pid]) {
    try {
      process.kill(target, "SIGTERM");
    } catch {}
  }
}

function descendants(root: number): number[] {
  const children = new Map<number, number[]>();
  for (const line of Bun.spawnSync(["ps", "-axo", "pid=,ppid="]).stdout.toString().split("\n")) {
    const [pid, parent] = line.trim().split(/\s+/).map(Number);
    if (!pid || !parent) continue;
    children.set(parent, [...(children.get(parent) ?? []), pid]);
  }
  const found: number[] = [];
  const walk = (pid: number) => {
    for (const child of children.get(pid) ?? []) {
      found.push(child);
      walk(child);
    }
  };
  walk(root);
  return found;
}

export function use(name: string) {
  const profiles = loadProfiles();
  if (!profiles[name]) fail(`no codex profile "${name}" — see: router list`);
  guardLive();
  sync();
  if (profiles[name].signedOutAt) throw new SignedOutError(PREFIX + name);
  const auth = readBlob(name);
  if (!auth?.tokens) fail(`codex profile "${name}" has no stored credential — re-add it`);
  writeAuth(auth);
  setCurrent(name);
  if (existsSync(PROXY_SELECTION)) setProxySelection(name);
}

export function remove(name: string) {
  const profiles = loadProfiles();
  if (!profiles[name]) fail(`no codex profile "${name}"`);
  if (sync() === name) {
    fail(`"${name}" is the account Codex is signed in to — switch to another one first`);
  }
  keychainDelete(SERVICE, name);
  delete profiles[name];
  saveProfiles(profiles);
}

export type Row = {
  name: string;
  id: string;
  label: string;
  email?: string;
  plan?: string;
  current: boolean;
};

export function list(): { current: string | null; profiles: Row[] } {
  const current = sync();
  const profiles = loadProfiles();
  return {
    current,
    profiles: Object.entries(profiles)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, p]) => ({
        name,
        id: PREFIX + name,
        label: p.email ?? name,
        email: p.email,
        plan: p.plan,
        current: current === name,
      })),
  };
}

export function heal() {
  sync();
}

export function doctor(report: (good: boolean, msg: string) => void) {
  const profiles = loadProfiles();
  if (!Object.keys(profiles).length && !readAuth()) return;

  // Resolution already means "answers --version", so this covers both
  // finding the CLI and being able to run it — the npm build needs a node
  // on PATH, which the menu bar app does not inherit.
  let found: { bin: string; version: string } | null = null;
  try {
    found = codex();
  } catch {}
  report(!!found, found ? `codex CLI runs (${found.version} — ${found.bin})` : "codex CLI runs");

  const auth = readAuth();
  report(!!auth, `${AUTH_FILE} readable`);
  if (auth) report(!!identify(auth), "Codex is signed in with a ChatGPT account router can park");

  const current = sync();
  report(!!current, "an account is active for Codex");
  for (const [name, profile] of Object.entries(loadProfiles())) {
    report(!!readBlob(name)?.tokens, `credential stored for "codex:${name}"`);
    report(!profile.signedOutAt, `"codex:${name}" is signed in (re-add it if not)`);
  }
}

export { CodexError };
export const authFile = AUTH_FILE;
