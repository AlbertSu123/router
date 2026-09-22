// Shared by the Claude and Codex halves of router: the state directory, the
// keychain calls both store credentials with, and the small formatting
// helpers their output has in common.

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const HOME = homedir();
export const DIR = join(HOME, ".router");

// The provider rejected a profile's refresh token, so only a new sign-in
// can bring it back. Callers must not fall back to another account.
export class SignedOutError extends Error {
  constructor(readonly profile: string) {
    super(`"${profile}" is signed out — add the account again to reconnect it`);
  }
}

export function ensureDir() {
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
}

// --- keychain ---------------------------------------------------------------

export function keychainRead(service: string, account: string): string | null {
  const p = Bun.spawnSync(["security", "find-generic-password", "-s", service, "-a", account, "-w"]);
  if (p.exitCode !== 0) return null;
  const value = p.stdout.toString().replace(/\n$/, "");
  return value || null;
}

// The value travels via argv, visible in ps for the milliseconds the call
// runs; same exposure Claude Code's own credential tooling has on a
// single-user Mac.
export function keychainWrite(service: string, account: string, value: string) {
  const p = Bun.spawnSync([
    "security", "add-generic-password", "-U", "-s", service, "-a", account, "-w", value,
  ]);
  if (p.exitCode !== 0) throw new Error(`keychain write failed: ${p.stderr.toString().trim()}`);
}

export function keychainDelete(service: string, account: string) {
  Bun.spawnSync(["security", "delete-generic-password", "-s", service, "-a", account]);
}

// --- naming -------------------------------------------------------------------

// Profile names come from the account email's local part, kept unique
// against the names already in use.
export function uniqueName(email: string | undefined, taken: Set<string>, reserved: string[] = []) {
  let base =
    (email ?? "")
      .split("@")[0]!
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^[-_]+|[-_]+$/g, "")
      .slice(0, 24) || "account";
  if (reserved.includes(base)) base = "account";
  let name = base;
  for (let i = 2; taken.has(name); i++) name = `${base}${i}`;
  return name;
}

// --- formatting ---------------------------------------------------------------

export function humanUntil(epoch: number): string {
  const secs = Math.max(0, Math.floor(epoch - Date.now() / 1000));
  if (secs >= 86400) return `${Math.floor(secs / 86400)}d`;
  if (secs >= 3600) {
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    return m > 0 ? `${h}h${m}m` : `${h}h`;
  }
  if (secs >= 60) return `${Math.floor(secs / 60)}m`;
  return "<1m";
}

// A rate limit window named by its length, so a label never claims a
// window the provider did not report ("5h" for 18000s, "7d" for 604800s).
export function windowLabel(seconds: number): string {
  if (seconds % 86400 === 0) return `${seconds / 86400}d`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

// The shape both halves report usage in. `label` names the window when the
// provider's own window lengths decide it.
export type Limit = { pct: number; reset?: number; label?: string };
export type Credits = { pct: number; used: number; limit: number; currency: string };
export type UsageRow = {
  resets?: import("./codex-resets.ts").ResetCredits;
  observedAt?: number;
  stale?: boolean;
  // The provider rejected the account's refresh token: it needs a new
  // sign-in, and the row carries no readings.
  signedOut?: boolean;
  five?: Limit;
  week?: Limit;
  scoped?: Record<string, Limit>;
  credits?: Credits;
  // Set when the row lists exactly the windows the account has, so an empty
  // slot means "no such window" rather than "the endpoint withheld it" and
  // gets no "?" placeholder.
  exact?: boolean;
};

export function fmtLimit(label: string, limit: Limit | undefined): string {
  if (!limit) return `${label} ?`;
  const name = limit.label ?? label;
  return `${name} ${limit.pct}%${limit.reset ? ` (${humanUntil(limit.reset)})` : ""}`;
}
