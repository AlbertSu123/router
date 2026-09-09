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
// What a switch does not do: reach a running Codex session. Codex pins the
// account a session started with and refuses to reload auth.json for a
// different account_id ("Skipping auth reload due to account id mismatch"),
// so a switch lands on the next session you start, not the one you are in.

import {
  mkdirSync,
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
const LOGIN_PID_FILE = join(DIR, "codex-login.pid");
const CACHE_DIR = join(DIR, "cache");
const SERVICE = "router-codex";

// Codex's own OAuth client. `codex login` runs the flow; router only reads
// the result and refreshes it, so this id is needed for refreshes alone.
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const USAGE_URL = "https://chatgpt.com/backend-api/codex/usage";
const REFRESH_SCOPE = "openid profile email offline_access";
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
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
  writeBlob(name, auth);
  if (currentName() !== name) setCurrent(name);
  return name;
}

// --- oauth --------------------------------------------------------------------

// Only an inactive profile is router's to refresh: Codex keeps the active
// one current itself, and the refresh token is single-use, so racing it
// would strand the session that is actually running.
async function refreshBlob(name: string, auth: Auth): Promise<Auth | null> {
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
    return next;
  } catch {
    return null;
  }
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
  const [short, long] = windowsOf(body?.rate_limit);
  const scoped: Record<string, Limit> = {};
  for (const extra of Array.isArray(body?.additional_rate_limits) ? body.additional_rate_limits : []) {
    const limit = windowsOf(extra?.rate_limit)[0];
    if (limit) scoped[extra.limit_name ?? extra.metered_feature ?? "scoped"] = limit;
  }
  if (!short && !long && !Object.keys(scoped).length) return null;
  return {
    five: short,
    week: long,
    scoped: Object.keys(scoped).length ? scoped : undefined,
    exact: true,
  };
}

async function fetchUsage(auth: Auth): Promise<any | null> {
  try {
    const r = await fetch(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${auth.tokens!.access_token}`,
        "chatgpt-account-id": auth.tokens!.account_id,
        originator: "codex_cli_rs",
      },
      signal: AbortSignal.timeout(8000),
    });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
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
      let auth = readBlob(name);
      if (!auth?.tokens) return;
      const exp = expiresAt(auth);
      if (name !== active && typeof exp === "number" && exp - Date.now() <= REFRESH_MARGIN_MS) {
        auth = (await refreshBlob(name, auth)) ?? auth;
      }
      const body = await fetchUsage(auth);
      const cache = join(CACHE_DIR, `codex-usage-${name}.json`);
      if (body) {
        const row = parseUsage(body);
        if (row) {
          out[name] = row;
          writeFileSync(cache, JSON.stringify(body), { mode: 0o600 });
        }
        return;
      }
      try {
        if (Date.now() - statSync(cache).mtimeMs < USAGE_CACHE_MS) {
          const row = parseUsage(JSON.parse(readFileSync(cache, "utf8")));
          if (row) out[name] = row;
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
export async function add(onUrl?: (url: string) => void): Promise<Added> {
  const bin = codexBin();
  const home = mkdtempSync(join(tmpdir(), "router-codex-"));
  const proc = Bun.spawn([bin, "login"], {
    env: codexEnv({ CODEX_HOME: home }),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  ensureDir();
  writeFileSync(LOGIN_PID_FILE, `${proc.pid}\n`, { mode: 0o600 });

  const timer = setTimeout(() => killLogin(proc.pid), LOGIN_TIMEOUT_MS);
  let stderr = "";
  const watch = (async () => {
    const decoder = new TextDecoder();
    let announced = false;
    for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) {
      stderr += decoder.decode(chunk, { stream: true });
      const url = announced ? null : stderr.match(/https:\/\/auth\.openai\.com\/\S+/)?.[0];
      if (url) {
        announced = true;
        onUrl?.(url);
      }
    }
  })();

  try {
    await proc.exited;
    await watch;
  } finally {
    clearTimeout(timer);
    rmSync(LOGIN_PID_FILE, { force: true });
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
export function cancelAdd() {
  let pid = 0;
  try {
    pid = Number(readFileSync(LOGIN_PID_FILE, "utf8").trim());
  } catch {}
  rmSync(LOGIN_PID_FILE, { force: true });
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
  const auth = readBlob(name);
  if (!auth?.tokens) fail(`codex profile "${name}" has no stored credential — re-add it`);
  guardLive();
  sync();
  writeAuth(auth);
  setCurrent(name);
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
  for (const name of Object.keys(loadProfiles())) {
    report(!!readBlob(name)?.tokens, `credential stored for "codex:${name}"`);
  }
}

export { CodexError };
export const authFile = AUTH_FILE;
