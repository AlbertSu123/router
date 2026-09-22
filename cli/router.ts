#!/usr/bin/env bun
// router: switch which Claude account Claude Code uses.
//
// Each profile is an OAuth token minted through the same PKCE flow as
// Claude Code's /login, with the full /login scope set (Remote Control
// needs user:sessions:claude_code). Tokens live in the macOS Keychain
// (service "router", account = profile name). Profiles are identified by
// the account email.
//
// A switch swaps the "Claude Code-credentials" keychain item, so it applies
// to running sessions too: Claude Code re-reads the item on its next API
// call (~30s credential cache). "main" is the normal keychain login; its
// real credential is stashed (service "router-stash") while another profile
// is active and restored on switch-back.
//
// Race to know about: a long-running session that started as "main" can
// refresh its OAuth pair and rewrite the keychain item while another
// profile is active. `router heal` detects that (a router-made item never
// has a refreshToken), re-stashes the fresh main credential, and re-asserts
// the active profile. The menu bar app calls it periodically.
//
// Codex accounts work differently enough to live in ./codex.ts; this file
// dispatches to it for anything named "codex:<profile>".

import { mkdirSync, readFileSync, statSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";

import * as codex from "./codex.ts";
import { proxyCommand } from "./proxy-control.ts";
import { meterCommand } from "./meter-control.ts";
import type { MeterCredential } from "./meter-client.ts";
import {
  DIR,
  HOME,
  ensureDir,
  fmtLimit,
  keychainDelete,
  keychainRead,
  keychainWrite,
  SignedOutError,
  uniqueName,
  type Credits,
  type Limit,
  type UsageRow,
} from "./common.ts";

const CURRENT_FILE = join(DIR, "current");
const PROFILES_FILE = join(DIR, "profiles.json");
const PENDING_FILE = join(DIR, "pending.json");
const ACCOUNT_STASH_FILE = join(DIR, "stash-account.json");
const SERVICE = "router";
const STASH_SERVICE = "router-stash";
const CLAUDE_SERVICE = "Claude Code-credentials";
const CLAUDE_ACCOUNT = process.env.USER ?? "";
const CLAUDE_JSON = join(HOME, ".claude.json");
const MAIN = "main";
const TOKEN_RE = /^sk-ant-oat01-[A-Za-z0-9_.-]+$/;

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const REDIRECT_URI = "https://platform.claude.com/oauth/code/callback";
const AUTHORIZE_URL = "https://claude.com/cai/oauth/authorize";
const TOKEN_URL = "https://api.anthropic.com/v1/oauth/token";
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
const YEAR_MS = 365 * 24 * 3600 * 1000;

// The full scope set a real /login grants. Remote Control needs
// user:sessions:claude_code to reach the claude.ai bridge; an
// inference-only token drops the bridge with "login expired".
const SCOPES = [
  "user:profile",
  "user:inference",
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload",
];
// What older router versions minted. heal upgrades these via refresh.
const LEGACY_SCOPES = ["user:profile", "user:inference"];

type Profile = {
  email?: string;
  addedAt: string;
  expiresAt?: number;
  // oauthAccount fields for ~/.claude.json (uuids, org) from PROFILE_URL.
  account?: Record<string, unknown>;
  accountCheckAt?: number;
  scopeCheckAt?: number;
  // Set when the token endpoint rejected the refresh token outright; only a
  // new sign-in, which rewrites the whole entry, clears it.
  signedOutAt?: number;
};
type Profiles = Record<string, Profile>;

function loadProfiles(): Profiles {
  try {
    return JSON.parse(readFileSync(PROFILES_FILE, "utf8")).profiles ?? {};
  } catch {
    return {};
  }
}

function saveProfiles(profiles: Profiles) {
  ensureDir();
  writeFileSync(PROFILES_FILE, JSON.stringify({ profiles }, null, 2) + "\n", { mode: 0o600 });
}

function markSignedOut(name: string) {
  const profiles = loadProfiles();
  if (!profiles[name] || profiles[name].signedOutAt) return;
  profiles[name].signedOutAt = Date.now();
  saveProfiles(profiles);
}

function currentName(): string {
  try {
    const name = readFileSync(CURRENT_FILE, "utf8").trim();
    return name || MAIN;
  } catch {
    return MAIN;
  }
}

function setCurrent(name: string) {
  ensureDir();
  writeFileSync(CURRENT_FILE, name + "\n", { mode: 0o600 });
}

// A profile's keychain entry is JSON
// {accessToken, refreshToken?, expiresAt?, scopes?}.
type StoredToken = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scopes?: string[];
};

function readToken(name: string): StoredToken | null {
  const raw = keychainRead(SERVICE, name);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed.accessToken === "string" ? parsed : null;
  } catch {
    return null;
  }
}

function writeToken(name: string, token: StoredToken) {
  keychainWrite(SERVICE, name, JSON.stringify(token));
}

// --- claude credential item ---------------------------------------------------

type ClaudeItem = Record<string, any>;

function readClaudeItem(): ClaudeItem | null {
  const raw = keychainRead(CLAUDE_SERVICE, CLAUDE_ACCOUNT);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeClaudeItem(item: ClaudeItem) {
  keychainWrite(CLAUDE_SERVICE, CLAUDE_ACCOUNT, JSON.stringify(item));
}

// A real login has a refresh token. A router-made item never does.
function isMainFamily(item: ClaudeItem | null): boolean {
  const refresh = item?.claudeAiOauth?.refreshToken;
  return typeof refresh === "string" && refresh.length > 0;
}

function syntheticItem(base: ClaudeItem | null, name: string, token: StoredToken): ClaudeItem {
  const item: ClaudeItem = { ...(base ?? {}) };
  item.claudeAiOauth = {
    accessToken: token.accessToken,
    expiresAt: token.expiresAt ?? Date.now() + YEAR_MS,
    scopes: token.scopes ?? LEGACY_SCOPES,
    subscriptionType: "max",
  };
  return item;
}

function stashMain(item: ClaudeItem) {
  keychainWrite(STASH_SERVICE, MAIN, JSON.stringify(item));
  try {
    const cfg = JSON.parse(readFileSync(CLAUDE_JSON, "utf8"));
    if (cfg.oauthAccount) {
      writeFileSync(ACCOUNT_STASH_FILE, JSON.stringify(cfg.oauthAccount) + "\n", { mode: 0o600 });
    }
  } catch {}
}

function readStash(): ClaudeItem | null {
  const raw = keychainRead(STASH_SERVICE, MAIN);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function dropStash() {
  keychainDelete(STASH_SERVICE, MAIN);
  rmSync(ACCOUNT_STASH_FILE, { force: true });
}

// Identity metadata in ~/.claude.json. Auth ignores it, but Remote Control
// reads organizationUuid from it and the UI shows the email, so keep it
// pointing at the active account. Falls back to an email-only patch until
// heal has fetched the profile's full account record.
function patchAccount(profile: Profile | undefined) {
  try {
    const cfg = JSON.parse(readFileSync(CLAUDE_JSON, "utf8"));
    if (!cfg.oauthAccount) return;
    if (profile?.account) {
      cfg.oauthAccount = { ...cfg.oauthAccount, ...profile.account };
    } else if (profile?.email) {
      cfg.oauthAccount.emailAddress = profile.email;
    } else {
      return;
    }
    writeFileSync(CLAUDE_JSON, JSON.stringify(cfg, null, 2));
  } catch {}
}

// The oauth profile endpoint returns the identity behind a token, mapped
// here to the oauthAccount keys Claude Code keeps in ~/.claude.json.
async function fetchAccount(accessToken: string): Promise<Record<string, unknown> | null> {
  try {
    const r = await fetch(PROFILE_URL, {
      headers: { Authorization: `Bearer ${accessToken}`, "anthropic-beta": "oauth-2025-04-20" },
      signal: AbortSignal.timeout(6000),
    });
    if (!r.ok) return null;
    const body: any = await r.json();
    const a = body.account;
    const o = body.organization;
    if (!a?.uuid) return null;
    return {
      accountUuid: a.uuid,
      emailAddress: a.email,
      displayName: a.display_name,
      accountCreatedAt: a.created_at,
      organizationUuid: o?.uuid,
      organizationName: o?.name,
      organizationType: o?.organization_type,
      billingType: o?.billing_type,
      organizationRateLimitTier: o?.rate_limit_tier,
      hasExtraUsageEnabled: o?.has_extra_usage_enabled,
      subscriptionCreatedAt: o?.subscription_created_at,
    };
  } catch {
    return null;
  }
}

// Fetch and store the account record for a profile. The caller guards the
// call rate; a failed fetch leaves the profile unchanged.
async function ensureAccount(name: string, accessToken: string) {
  const account = await fetchAccount(accessToken);
  if (!account) return;
  const profiles = loadProfiles();
  if (!profiles[name]) return;
  profiles[name].account = account;
  saveProfiles(profiles);
}

function restoreAccountStash() {
  try {
    const stashed = JSON.parse(readFileSync(ACCOUNT_STASH_FILE, "utf8"));
    const cfg = JSON.parse(readFileSync(CLAUDE_JSON, "utf8"));
    cfg.oauthAccount = stashed;
    writeFileSync(CLAUDE_JSON, JSON.stringify(cfg, null, 2));
  } catch {}
}

// While a profile is active, ~/.claude.json carries that profile's email;
// the real login's identity lives in the stash for that window.
function mainEmail(): string | null {
  try {
    const stashed = JSON.parse(readFileSync(ACCOUNT_STASH_FILE, "utf8"));
    if (stashed.emailAddress) return stashed.emailAddress;
  } catch {}
  try {
    const cfg = JSON.parse(readFileSync(CLAUDE_JSON, "utf8"));
    return cfg.oauthAccount?.emailAddress ?? null;
  } catch {
    return null;
  }
}

// --- oauth ------------------------------------------------------------------

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const PENDING_TTL_MS = 10 * 60 * 1000;

// A window reopen must not invalidate the code the user already has, so a
// fresh pending sign-in is reused unless the caller forces a new one.
function authStart(force: boolean): { url: string; fresh: boolean } {
  if (!force) {
    try {
      const pending = JSON.parse(readFileSync(PENDING_FILE, "utf8"));
      if (pending.url && Date.now() - pending.ts < PENDING_TTL_MS) {
        return { url: pending.url, fresh: false };
      }
    } catch {}
  }
  const verifier = b64url(randomBytes(32));
  const state = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const q = new URLSearchParams({
    code: "true",
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    // The full /login scope set. user:sessions:claude_code keeps Remote
    // Control alive; user:profile unlocks the usage endpoint.
    scope: SCOPES.join(" "),
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  });
  const url = `${AUTHORIZE_URL}?${q}`;
  ensureDir();
  writeFileSync(PENDING_FILE, JSON.stringify({ verifier, state, url, ts: Date.now() }) + "\n", {
    mode: 0o600,
  });
  return { url, fresh: true };
}

type Redeemed = {
  token: string;
  refreshToken?: string;
  email?: string;
  expiresAt?: number;
  scopes?: string[];
};

function parseScope(scope: unknown): string[] | undefined {
  return typeof scope === "string" && scope ? scope.split(" ") : undefined;
}

async function authRedeem(paste: string): Promise<Redeemed> {
  let pending: { verifier: string; state: string };
  try {
    pending = JSON.parse(readFileSync(PENDING_FILE, "utf8"));
  } catch {
    throw new Error("no sign-in in progress — start one first");
  }
  const [code, pastedState] = paste.trim().split("#");
  if (!code) throw new Error("empty code");
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      state: pastedState ?? pending.state,
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code_verifier: pending.verifier,
    }),
  });
  const body: any = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error(`sign-in failed: ${body.error_description ?? body.error ?? `HTTP ${r.status}`}`);
  }
  rmSync(PENDING_FILE, { force: true });
  const token = typeof body.access_token === "string" ? body.access_token : null;
  if (!token || !TOKEN_RE.test(token)) throw new Error("no token in the response");
  const refreshToken =
    typeof body.refresh_token === "string" && body.refresh_token ? body.refresh_token : undefined;
  const email = body.account?.email_address ?? body.account?.email ?? body.email ?? undefined;
  const expiresAt =
    typeof body.expires_in === "number" ? Date.now() + body.expires_in * 1000 : undefined;
  return { token, refreshToken, email, expiresAt, scopes: parseScope(body.scope) ?? SCOPES };
}

// `rejected` is the endpoint's verdict that the refresh token is dead
// (invalid_grant); a network or server failure is not.
async function postRefresh(refreshToken: string, scopes: string[]): Promise<{ body: any | null; rejected: boolean }> {
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
      scope: scopes.join(" "),
    }),
  });
  const body: any = await r.json().catch(() => ({}));
  if (r.ok && typeof body.access_token === "string") return { body, rejected: false };
  return { body: null, rejected: body?.error === "invalid_grant" };
}

// A refresh always asks for the full scope set — the token endpoint grants
// scope expansion on refresh for this client, which upgrades legacy
// inference-only profiles in place. A rejection falls back to the token's
// current scopes so the pair stays alive.
async function refreshStoredToken(name: string, stored: StoredToken): Promise<StoredToken | null> {
  if (!stored.refreshToken) return null;
  const want = [...new Set([...SCOPES, ...(stored.scopes ?? [])])];
  let { body, rejected } = await postRefresh(stored.refreshToken, want);
  let granted = want;
  if (!body && stored.scopes) {
    ({ body, rejected } = await postRefresh(stored.refreshToken, stored.scopes));
    granted = stored.scopes;
  }
  if (!body) {
    if (rejected) markSignedOut(name);
    return null;
  }
  const next: StoredToken = {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? stored.refreshToken,
    expiresAt:
      typeof body.expires_in === "number" ? Date.now() + body.expires_in * 1000 : undefined,
    scopes: parseScope(body.scope) ?? granted,
  };
  writeToken(name, next);
  const profiles = loadProfiles();
  if (profiles[name]) {
    profiles[name]!.expiresAt = next.expiresAt;
    saveProfiles(profiles);
  }
  return next;
}

// --- profile bookkeeping ------------------------------------------------------

// Profiles are identified by the account email. Re-adding the same account
// refreshes its token under the existing name.
async function saveNewProfile(redeemed: Redeemed): Promise<{ name: string; email?: string }> {
  const profiles = loadProfiles();
  const name =
    (redeemed.email
      ? Object.entries(profiles).find(([, p]) => p.email === redeemed.email)?.[0]
      : undefined) ?? uniqueName(redeemed.email, new Set(Object.keys(profiles)), [MAIN]);
  const expiresAt = redeemed.expiresAt ?? Date.now() + YEAR_MS;
  writeToken(name, {
    accessToken: redeemed.token,
    refreshToken: redeemed.refreshToken,
    expiresAt,
    scopes: redeemed.scopes,
  });
  profiles[name] = { email: redeemed.email, addedAt: new Date().toISOString(), expiresAt };
  saveProfiles(profiles);
  await ensureAccount(name, redeemed.token);
  return { name, email: redeemed.email };
}

function labelFor(email: string | undefined, fallback: string): string {
  return email ?? fallback;
}

// Provider credentials only cross to the usage server for transient verification.
async function meteringCredentials(): Promise<MeterCredential[]> {
  const result: MeterCredential[] = [];
  const item = readClaudeItem();
  const main = (isMainFamily(item) ? item : readStash())?.claudeAiOauth?.accessToken;
  if (main) result.push({ provider: "claude", profile: MAIN, accessToken: main });
  // A signed-out subscription can neither serve requests nor be verified,
  // and its row already says so.
  for (const [name, profile] of Object.entries(loadProfiles())) {
    const token = profile.signedOutAt ? null : readToken(name);
    if (token) result.push({ provider: "claude", profile: name, accessToken: token.accessToken });
  }
  for (const profile of codex.list().profiles) {
    try {
      const value = await codex.proxyCredential(profile.name);
      result.push({ provider: "codex", profile: value.name, accessToken: value.accessToken, accountId: value.accountId });
    } catch { /* Signed out, or no usable credential to prove. */ }
  }
  return result;
}

// --- commands -----------------------------------------------------------------

function die(msg: string): never {
  console.error(`router: ${msg}`);
  process.exit(1);
}

function switchTo(name: string) {
  const item = readClaudeItem();
  if (name === MAIN) {
    if (isMainFamily(item)) {
      // Already holding real login credentials (never left, a session's
      // refresh reverted the swap, or the user ran /login). Keep them.
      dropStash();
    } else {
      const stashed = readStash();
      if (!stashed) {
        die("the main login credential is missing — run `claude /login` once, then retry");
      }
      // Connectors may have re-authed while away; keep the newest mcpOAuth.
      if (item?.mcpOAuth) stashed.mcpOAuth = item.mcpOAuth;
      writeClaudeItem(stashed);
      restoreAccountStash();
      dropStash();
    }
    setCurrent(MAIN);
    return;
  }

  const profile = loadProfiles()[name];
  if (!profile) die(`no profile "${name}" — see: router list`);
  const token = readToken(name);
  if (!token) die(`profile "${name}" has no keychain token — re-add it`);
  if (isMainFamily(item)) stashMain(item!);
  writeClaudeItem(syntheticItem(item, name, token));
  patchAccount(profile);
  setCurrent(name);
}

function cmdUse(args: string[]) {
  const name = args[0];
  if (!name) die("usage: router use <name|main|codex:name>");
  if (name.startsWith(codex.PREFIX)) {
    const profile = name.slice(codex.PREFIX.length);
    codex.use(profile);
    console.log(`Switched Codex to "${profile}". ${codex.proxySelection() ? "Routed sessions use it on their next request." : "New Codex sessions use it."}`);
    return;
  }
  if (loadProfiles()[name]?.signedOutAt) throw new SignedOutError(name);
  switchTo(name);
  console.log(`Switched to "${name}". Sessions pick it up on their next request (about 30s).`);
}

// Housekeeping the menu bar app runs periodically:
// 1. Refresh any stored token that is close to expiry, and upgrade legacy
//    inference-only tokens to the full scope set (rate-limited retry).
// 2. Backfill the account record for profiles that predate it.
// 3. Undo a clobber: a running "main" session can refresh its OAuth pair
//    and rewrite the keychain item while a profile is active.
async function cmdHeal(args: string[]) {
  const quiet = args.includes("--quiet");
  const say = (msg: string) => {
    if (!quiet) console.log(msg);
  };

  const REFRESH_MARGIN_MS = 45 * 60 * 1000;
  const SCOPE_RETRY_MS = 6 * 3600 * 1000;
  const ACCOUNT_RETRY_MS = 3600 * 1000;
  for (const [name, profile] of Object.entries(loadProfiles())) {
    if (profile.signedOutAt) continue;
    const stored = readToken(name);
    if (!stored?.refreshToken) continue;
    const nearExpiry =
      typeof stored.expiresAt === "number" &&
      stored.expiresAt - Date.now() <= REFRESH_MARGIN_MS;
    const have = stored.scopes ?? LEGACY_SCOPES;
    const missingScopes = SCOPES.some((s) => !have.includes(s));
    const wantUpgrade =
      missingScopes && Date.now() - (loadProfiles()[name]?.scopeCheckAt ?? 0) > SCOPE_RETRY_MS;
    if (!nearExpiry && !wantUpgrade) continue;
    if (wantUpgrade) {
      const profiles = loadProfiles();
      if (profiles[name]) {
        profiles[name]!.scopeCheckAt = Date.now();
        saveProfiles(profiles);
      }
    }
    const next = await refreshStoredToken(name, stored);
    if (!next) continue;
    const upgraded = missingScopes && SCOPES.every((s) => next.scopes?.includes(s));
    say(upgraded ? `upgraded "${name}" to the full scope set` : `refreshed the token for "${name}"`);
    if (upgraded) await ensureAccount(name, next.accessToken);
  }

  for (const [name, profile] of Object.entries(loadProfiles())) {
    if (profile.account) continue;
    if (Date.now() - (profile.accountCheckAt ?? 0) < ACCOUNT_RETRY_MS) continue;
    const stored = readToken(name);
    if (!stored) continue;
    const profiles = loadProfiles();
    if (profiles[name]) {
      profiles[name]!.accountCheckAt = Date.now();
      saveProfiles(profiles);
    }
    await ensureAccount(name, stored.accessToken);
  }

  const cur = currentName();
  if (cur === MAIN) return;
  const token = readToken(cur);
  if (!token) return;
  const item = readClaudeItem();
  if (isMainFamily(item)) {
    stashMain(item!);
    writeClaudeItem(syntheticItem(item, cur, token));
    patchAccount(loadProfiles()[cur]);
    say(`healed: re-asserted "${cur}" after a main refresh`);
  } else if (item?.claudeAiOauth?.accessToken !== token.accessToken) {
    writeClaudeItem(syntheticItem(item, cur, token));
    patchAccount(loadProfiles()[cur]);
    say(`healed: updated the live credential for "${cur}"`);
  }

  // Codex needs no re-assertion — its credential is a file nothing else
  // rewrites behind router — but the file is where Codex leaves refreshed
  // tokens and where `codex login` lands, so keep the parked copies and the
  // active selection in step with it.
  codex.heal();
}

async function cmdAdd(args: string[]) {
  if (args.includes("--codex")) return cmdAddCodex(args);
  const { url } = authStart(true);
  console.log("Opening the Claude sign-in in your browser.");
  console.log("Tip: use a private window for an account that is not your browser default.\n");
  console.log(url + "\n");
  Bun.spawnSync(["open", url]);
  const code = prompt("Paste the code from the sign-in page:")?.trim() ?? "";
  if (!code) die("no code pasted");
  const saved = await saveNewProfile(await authRedeem(code));
  console.log(`\nAdded ${saved.email ?? `"${saved.name}"`}.`);
  console.log(`Switch with: router use ${saved.name}`);
}

// The Codex sign-in is Codex's own: it opens the browser and waits for its
// callback, so there is no code to paste here.
async function cmdAddCodex(args: string[]) {
  const device = args.includes("--device-auth");
  console.log(device ? "Authorize this Mac from another computer using the link and code below." : "Opening the ChatGPT sign-in in your browser.");
  console.log("Tip: use a private window for an account that is not your browser default.\n");
  const added = await codex.add((url) => console.log(url + "\n"), device, "cli", (code) => console.log(`One-time code: ${code}`));
  console.log(`Added ${added.email ?? `"${added.name}"`}${added.plan ? ` (${added.plan})` : ""}.`);
  console.log(`Switch with: router use ${codex.PREFIX}${added.name}`);
}

// Machine surface for the menu bar app.
async function cmdAuth(args: string[]) {
  const sub = args[0];
  if (sub === "start") {
    console.log(JSON.stringify(authStart(args.includes("--fresh"))));
    return;
  }
  if (sub === "redeem") {
    const paste = args[1];
    if (!paste) die("usage: router auth redeem <code>");
    try {
      const saved = await saveNewProfile(await authRedeem(paste));
      console.log(JSON.stringify({ name: saved.name, email: saved.email ?? null }));
    } catch (e: any) {
      console.log(JSON.stringify({ error: e.message ?? String(e) }));
      process.exit(1);
    }
    return;
  }
  // The Codex sign-in has no code to paste: it runs to completion here and
  // reports the account it landed on. The URL goes out first so a window
  // driving this can offer it when the browser did not open.
  if (sub === "codex") {
    if (args[1] === "cancel") {
      codex.cancelAdd(args.find(a => a.startsWith("--session="))?.slice(10));
      return;
    }
    if (args[1] === "login") {
      try {
        const added = await codex.add((url) => console.log(JSON.stringify({ url })), args.includes("--device-auth"), args.find(a => a.startsWith("--session="))?.slice(10) ?? "cli", (code) => console.log(JSON.stringify({ code })), args.includes("--replace"));
        console.log(JSON.stringify({ name: added.name, email: added.email ?? null }));
      } catch (e: any) {
        console.log(JSON.stringify({ error: e.message ?? String(e) }));
        process.exit(1);
      }
      return;
    }
    die("usage: router auth codex login|cancel");
  }
  die("usage: router auth start|redeem|codex");
}

function listData() {
  const current = currentName();
  const profiles = loadProfiles();
  const main = mainEmail() ?? undefined;
  const codexList = codex.list();
  return {
    current,
    codexCurrent: codexList.current,
    profiles: [
      { name: MAIN, label: labelFor(main, MAIN), email: main, current: current === MAIN },
      ...Object.entries(profiles).map(([name, p]) => ({
        name,
        label: labelFor(p.email, name),
        email: p.email,
        current: current === name,
      })),
    ],
    codex: codexList.profiles,
  };
}

function cmdList(args: string[]) {
  const data = listData();
  if (args.includes("--json")) {
    console.log(JSON.stringify(data));
    return;
  }
  for (const p of data.profiles) {
    console.log(`${p.current ? "*" : " "} ${p.name.padEnd(20)} ${p.label}`);
  }
  for (const p of data.codex) {
    console.log(`${p.current ? "*" : " "} ${p.id.padEnd(20)} ${p.label}${p.plan ? ` (${p.plan})` : ""}`);
  }
}

// Usage per account: 5-hour, 7-day, and model-scoped weekly (e.g. Fable)
// percentages, plus the credit pool for accounts metered on spend instead
// of on windows, for the menu bar app.
//
// Successful endpoint responses are written to the same per-account cache
// the statusline reads (`usage-limits-<name>.json`) — the endpoint often
// rate-limits inference-scoped tokens, so whichever fetcher succeeds feeds
// everyone. Fallbacks per account: that cache (2h), then the session-
// reported limits the statusline persists (`rate-limits-<name>.json`, 24h).
function resetEpoch(v: any): number | undefined {
  if (typeof v === "number") return v;
  if (typeof v !== "string") return undefined;
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.floor(t / 1000) : undefined;
}

function asLimit(l: any): Limit | undefined {
  if (typeof l?.percent !== "number") return undefined;
  return { pct: l.percent, reset: resetEpoch(l.resets_at) };
}

// An enterprise seat billed per use (profile `seat_tier`
// enterprise_usage_based, `rate_limit_tier` default_claude_zero) has no
// session or weekly window at all: the endpoint returns `limits: []` with
// every window null, and its requests come back with
// `anthropic-ratelimit-unified-representative-claim: overage`. The credit
// pool is what meters it, and `spend.enabled` marks the pool as the live
// meter — on plan accounts it is off, and the windows above are the truth.
function parseCredits(spend: any): Credits | undefined {
  if (spend?.enabled !== true || typeof spend.percent !== "number") return undefined;
  const money = (m: any) =>
    typeof m?.amount_minor === "number" ? m.amount_minor / 10 ** (m.exponent ?? 2) : undefined;
  const used = money(spend.used);
  const limit = money(spend.limit);
  if (used === undefined || limit === undefined) return undefined;
  return { pct: spend.percent, used, limit, currency: spend.used?.currency ?? "USD" };
}

function parseLimits(body: any): UsageRow | null {
  const limits = Array.isArray(body?.limits) ? body.limits : null;
  const credits = parseCredits(body?.spend);
  if (!limits && !credits) return null;
  const pick = (kind: string) => asLimit(limits?.find((l: any) => l.kind === kind));
  const scoped: Record<string, Limit> = {};
  for (const l of limits ?? []) {
    if (l.kind !== "weekly_scoped") continue;
    const limit = asLimit(l);
    if (limit) scoped[l.scope?.model?.display_name ?? l.scope?.surface ?? "scoped"] = limit;
  }
  return {
    five: pick("session"),
    week: pick("weekly_all"),
    scoped: Object.keys(scoped).length ? scoped : undefined,
    credits,
  };
}

function fmtCredits(c: Credits): string {
  const money = (v: number) => v.toLocaleString("en-US", { style: "currency", currency: c.currency });
  return `credits ${c.pct}% (${money(c.used)}/${money(c.limit)})`;
}

async function cmdUsage(args: string[]) {
  const codexRows = codex.usage();
  const item = readClaudeItem();
  const tokens: Record<string, string> = {};
  const mainToken = (isMainFamily(item) ? item : readStash())?.claudeAiOauth?.accessToken;
  if (mainToken) tokens[MAIN] = mainToken;
  const signedOut = new Set<string>();
  for (const [name, profile] of Object.entries(loadProfiles())) {
    const stored = profile.signedOutAt ? null : readToken(name);
    if (profile.signedOutAt) signedOut.add(name);
    else if (stored) tokens[name] = stored.accessToken;
  }
  const cacheDir = join(HOME, ".claude/cache");
  mkdirSync(cacheDir, { recursive: true });
  const out: Record<string, UsageRow> = {};
  await Promise.all(
    Object.entries(tokens).map(async ([name, token]) => {
      try {
        const get = (bearer: string) => fetch(USAGE_URL, {
          headers: { Authorization: `Bearer ${bearer}`, "anthropic-beta": "oauth-2025-04-20" },
          signal: AbortSignal.timeout(6000),
        });
        let r = await get(token);
        // The endpoint's 429s say nothing about the token; a 401 does, so
        // only that earns a refresh — main's pair belongs to Claude Code.
        if (r.status === 401 && name !== MAIN) {
          const stored = readToken(name);
          const next = stored && (await refreshStoredToken(name, stored));
          if (loadProfiles()[name]?.signedOutAt) { signedOut.add(name); return; }
          if (next) r = await get(next.accessToken);
        }
        if (!r.ok) return;
        const body: any = await r.json();
        const row = parseLimits(body);
        if (row) {
          out[name] = row;
          writeFileSync(join(cacheDir, `usage-limits-${name}.json`), JSON.stringify(body));
        }
      } catch {}
    }),
  );
  for (const name of signedOut) out[name] = { signedOut: true };
  for (const name of [MAIN, ...Object.keys(loadProfiles())]) {
    if (signedOut.has(name)) continue;
    if (!out[name]) {
      try {
        const path = join(cacheDir, `usage-limits-${name}.json`);
        if (Date.now() - statSync(path).mtimeMs < 2 * 3600 * 1000) {
          out[name] = parseLimits(JSON.parse(readFileSync(path, "utf8"))) ?? {};
        }
      } catch {}
    }
    if (out[name]?.five === undefined) {
      try {
        const cached = JSON.parse(readFileSync(join(cacheDir, `rate-limits-${name}.json`), "utf8"));
        if (Date.now() / 1000 - cached.ts < 24 * 3600) {
          out[name] = {
            ...out[name],
            five:
              typeof cached.five === "number"
                ? { pct: cached.five, reset: cached.fiveReset ?? undefined }
                : undefined,
            week:
              out[name]?.week ??
              (typeof cached.week === "number"
                ? { pct: cached.week, reset: cached.weekReset ?? undefined }
                : undefined),
          };
        }
      } catch {}
    }
  }
  for (const [name, row] of Object.entries(await codexRows)) out[codex.PREFIX + name] = row;

  if (args.includes("--json")) console.log(JSON.stringify(out));
  else {
    for (const [name, u] of Object.entries(out)) {
      // An account with no windows at all is not a withheld reading, so it
      // gets no "5h ?" placeholder — only whatever meter it does have.
      const parts = u.exact
        ? [u.five, u.week].flatMap((l) => (l ? [fmtLimit("window", l)] : []))
        : u.five || u.week
          ? [fmtLimit("5h", u.five), fmtLimit("7d", u.week)]
          : [];
      for (const [model, limit] of Object.entries(u.scoped ?? {})) {
        parts.push(fmtLimit(model, limit));
      }
      if (u.credits) parts.push(fmtCredits(u.credits));
      if (u.resets) {
        parts.push(`${u.resets.available} banked resets`);
        for (const credit of u.resets.credits) {
          parts.push(credit.expiresAt === null ? "no expiration" : credit.expiresAt === undefined
            ? "expiration unavailable" : `expires ${new Date(credit.expiresAt * 1000).toLocaleString()}`);
        }
        if (!u.resets.detailsComplete) parts.push("some expiration dates unavailable");
        if (u.stale) parts.push("cached reset data");
      }
      if (u.signedOut) parts.push("signed out — add the account again");
      console.log(`${name.padEnd(20)} ${parts.length ? parts.join("  ") : "no limits reported"}`);
    }
  }
}

function cmdRemove(args: string[]) {
  const name = args[0];
  if (name?.startsWith(codex.PREFIX)) {
    const profile = name.slice(codex.PREFIX.length);
    codex.remove(profile);
    console.log(`Removed "${name}".`);
    return;
  }
  if (!name || name === MAIN) die("usage: router remove <name|codex:name>");
  const profiles = loadProfiles();
  if (!profiles[name]) die(`no profile "${name}"`);
  if (currentName() === name) {
    switchTo(MAIN);
    console.log(`"${name}" was active — switched back to the main login.`);
  }
  keychainDelete(SERVICE, name);
  delete profiles[name];
  saveProfiles(profiles);
  console.log(`Removed "${name}".`);
}

async function cmdDoctor() {
  let ok = true;
  const report = (good: boolean, msg: string) => {
    console.log(`${good ? "ok " : "BAD"}  ${msg}`);
    if (!good) ok = false;
  };

  const cur = currentName();
  const profiles = loadProfiles();
  report(cur === MAIN || !!profiles[cur], `current profile "${cur}" exists`);

  const item = readClaudeItem();
  report(!!item, "Claude Code keychain item present");
  if (cur === MAIN) {
    report(isMainFamily(item), "keychain holds the real login (has a refresh token)");
  } else {
    const token = readToken(cur);
    report(!!token, `keychain token for "${cur}"`);
    report(
      item?.claudeAiOauth?.accessToken === token?.accessToken,
      "keychain item matches the active profile (run `router heal` if not)",
    );
    report(!!readStash(), "main login stashed for switch-back");
  }
  for (const [name, profile] of Object.entries(profiles)) {
    const stored = readToken(name);
    report(!!stored, `token stored for "${name}"`);
    report(!profile.signedOutAt, `"${name}" is signed in (re-add it if not)`);
    if (stored) {
      report(
        SCOPES.every((s) => (stored.scopes ?? []).includes(s)),
        `"${name}" has the full scope set — Remote Control needs it (heal upgrades it)`,
      );
    }
  }

  const app = Bun.spawnSync(["pgrep", "-x", "Router"]);
  report(app.exitCode === 0, "menu bar app is running");

  codex.doctor(report);
  process.exit(ok ? 0 : 1);
}

function help() {
  console.log(`router — switch Claude Code and Codex accounts

usage:
  router add              sign in and store a token for another Claude account
  router add --codex      sign in and store a credential for another Codex account
  router add --codex --device-auth  sign in from another computer
  router use <name|main>  switch every Claude Code session to this account
  router use codex:<name> switch Codex to this account
  router list [--json]    show all accounts
  router usage [--json]   show usage limits per account
  router remove <name>    delete an account's credential
  router heal [--quiet]   re-assert the active account after a refresh race
  router doctor           check the installation
  router meter login     sign in personally for shared usage tracking
  router meter dashboard open shared subscription usage (returns a URL)
  router meter status    show sign-in, sync health, and queued usage
  router proxy install   start the local Codex routing service
  router proxy enable    route Codex requests through Router
  router proxy disable   restore the previous Codex provider
  router proxy status    show recent routing results (no prompts or tokens)

"main" is the normal Claude Code keychain login. A Claude switch swaps the
keychain credential, so running sessions follow on their next request (about
30s). With the local proxy enabled, Codex switches between requests without
restarting. Direct Codex sessions adopt a switch when relaunched.`);
}

const [cmd, ...rest] = process.argv.slice(2);
try {
  switch (cmd) {
    case "proxy": await proxyCommand(rest); break;
    case "meter": await meterCommand(rest, meteringCredentials); break;
    case "add": await cmdAdd(rest); break;
    case "use": cmdUse(rest); break;
    case "heal": await cmdHeal(rest); break;
    case "auth": await cmdAuth(rest); break;
    case "list": cmdList(rest); break;
    case "usage": await cmdUsage(rest); break;
    case "remove": cmdRemove(rest); break;
    case "doctor": await cmdDoctor(); break;
    default: help(); process.exit(cmd ? 1 : 0);
  }
} catch (e) {
  if (process.argv[2] === "meter") {
    console.log(JSON.stringify({ error: e instanceof Error ? e.message : "Router usage command failed" }));
    process.exit(1);
  }
  if (!(e instanceof codex.CodexError || e instanceof SignedOutError)) throw e;
  die(e.message);
}
