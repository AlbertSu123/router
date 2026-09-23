# Shared Router usage

Production: https://router-usage.gudvc.com — Docker Compose on `ssh gud`, in
`~/router-metering`. The service listens only on loopback port 8791; a dedicated
Cloudflare tunnel provides HTTPS. Existing services and tunnels are unchanged.
SQLite lives in `~/router-metering/data/usage.sqlite` (WAL mode). No provider
credentials, prompts, output text, conversation IDs, or filesystem paths are
stored on the server. Provider access tokens are sent over HTTPS **transiently**
to verify the subscription against the provider, then discarded. Provider ID tokens are verified with fixed issuer JWKS, expected audience,
signature, expiry, and a 15-minute freshness limit; Google also requires a nonce.
Session secrets are stored as SHA-256 hashes on the server. Router has no
password registration/sign-in flow.

## Use

Install the CLI and menu app as usual. Click **Sign in to Router** and choose
**Sign in with ChatGPT** (primary) or **Continue with Google** (fallback).
Personal identity is separate from subscription login. ChatGPT uses a fresh
Codex browser login in a temporary `CODEX_HOME`; Router does not select a saved
shared account, and deletes the temporary provider credentials after reading
the ID token. Google uses the owner's installed-app OAuth client, PKCE, state,
a nonce, and a random loopback callback. It requests only `openid email profile`.
Matching **verified** email addresses on these trusted providers join one Router
identity, so switching to Google preserves history. Unverified emails never
merge identities. Provider sign-in alone grants no subscription access. The menu then
opens **Shared usage** in the browser via a single-use, 30-second sign-in link.

On first personal sign-in, Router installs a background usage service, enables
the local Claude transport via `~/.claude/settings.json` →
`env.ANTHROPIC_BASE_URL=http://127.0.0.1:18790`, and enables the existing Codex
proxy when Codex profiles are present. A pre-existing custom Claude endpoint is
not overwritten; the menu explains the conflict. Existing Claude sessions and
existing direct Codex sessions must be restarted/resumed once to pick up their
new endpoint. Requests already using Router's Codex endpoint need no restart.
Custom environment/project overrides can bypass these endpoints.

Claude uses the same native curl HTTP/2 transport as Codex, with credentials
passed through a private pipe. Large Claude request bodies are losslessly gzip
compressed before upload when that reduces their size; client-supplied encodings
are preserved. No messages or tool results are removed. Router never automatically replays failed
inference or changes accounts. Anthropic rate limits and retry headers pass
through unchanged. Local `~/.router/claude-proxy-status.json` keeps the last
50 response-header outcomes (time, route, status, original and transmitted byte counts, encoding, elapsed time,
and bounded transport error code). It contains no tokens, prompts, or replies;
a 200 here means headers arrived, not that the entire stream completed.

Only requests routed through these transports **after personal sign-in** are
metered. Signing out stops collection. Shared provider percentages are never
attributed to one person by subtraction; other apps/direct clients remain
unattributed. All users need this Router update and their own personal sign-in.
The dashboard is visible only for subscriptions proved by that person's devices.
There is no global admin dashboard that bypasses this boundary.

## Access and accounting

- Each device proves provider credentials independently. The server derives the
  subscription ID from the provider response, never from a client-supplied email.
  Codex verifies the returned `account_id`; Claude uses organization and account
  UUIDs. The local credential fingerprint binds inference to that proof.
- Proof is renewed every ten minutes while the service is active; grants expire
  after an hour. Removing a local account revokes that device's grant at the next
  successful minute sync. Another device with its own proof can retain access.
  Offline machines cannot revoke instantly; the one-hour expiry bounds exposure.
- Every request snapshots personal identity and actual subscription before
  inference. Switching accounts or signing out mid-stream does not reattribute it.
- Inference stays local-to-provider. Streaming inspection stores counters only,
  preserves original response bytes and backpressure, and records partial/unknown
  results honestly when canceled. A crash can leave an incomplete request with
  unknown token counts; it is not presented as a successful zero-token request.
- Events queue in private `~/.router/meter-queue.sqlite`, including across service
  restarts and network failures. Completed events upload in idempotent batches.
  A different personal login cannot upload the previous person's events. Access
  must be re-proved before a revoked subscription's backlog can sync. Events
  older than 30 days remain local and require manual reconciliation.
- Raw tokens = inclusive input + cache writes + output. Cached input is a subset
  of inclusive input, not an extra charge. Model-level raw totals are available.
- Pressure score = raw tokens × `(0.25 + 0.75 × sharedDemand × (peak / 100)^2)`,
  using the highest weight across the request's applicable short/weekly quota
  windows. `sharedDemand` is 1 when multiple Router users requested that window,
  otherwise 0: consuming spare capacity alone keeps the 25% baseline, even if
  the sole user fills it. Rate-limited requests count as competing demand.
  A later high reading in the same reset window reweights all earlier requests
  in that window. Different reset windows stay separate. Scores are provisional
  until reset; unknown-pressure tokens are separately labeled, not discounted.
- Scores are an operational fairness indicator, **not billing or exact provider
  quota accounting**. Models, cache hits, output tokens, scoped limits, and
  provider-specific accounting have different real costs. Counts are reported
  by the authenticated local Router client, not a tamper-proof billing ledger.

## Commands

```
router meter login       # fresh personal ChatGPT browser sign-in
router meter login --google # Google fallback; no Codex CLI needed
router meter status      # personal identity, sync health, and pending event count
router meter dashboard   # return a one-use browser link
router meter sync        # verify available accounts and flush local usage
router meter logout      # revoke this device session/grants and stop tracking
router meter install     # install/start the background service
router meter enable      # configure the Claude endpoint
router meter disable     # remove only Router's Claude endpoint override
```

Both CLI login commands wait for the browser flow and finish setup automatically.
The dashboard sign-in buttons open the native app via `router://signin/chatgpt`
or `router://signin/google`; authenticated dashboard access still uses one-use tickets. The service and proxy launchd labels are
`dev.bryan.router.metering` and `dev.bryan.router.codex-proxy`. Loopback endpoints
reject browser-origin requests and accept only locally stored provider credentials
(Claude) or the private Router proxy token (Codex).

## Deploy and verify

```
bun test cli/*.test.ts metering/*.test.ts
swift build --package-path menubar
python3 cli/tests/login_integration.py
```

Deploy `server.ts`, `core.ts`, `identity.ts`, `dashboard.html`, `Dockerfile`, and `compose.yml`
to the VPS directory, then `docker compose -p router-metering up -d --build`.
Tunnel credentials belong only in the private server deployment, never Git.
The Google installed-client configuration lives in private
`secrets/google-oauth.json`, mounted read-only at `/run/secrets/google-oauth.json`.
It is the existing owner-managed `gudcandidatedb` client; no Gmail or candidate
data scopes are requested. `/auth/providers` exposes availability, never secrets.
The deployment uses the existing `router-usage` tunnel and its DNS record.
`backup.sh` makes SQLite-consistent daily backups in `data/backups`, retaining
14 days. Backups are on the same VPS; host-loss protection still requires an
independent off-host backup destination.

To restore, stop the metering container, move the current database and WAL/SHM
files aside, copy a backup to `data/usage.sqlite`, preserve owner UID 1000, and
restart. Dashboard/API authorization tests cover separate users, shared and
private subscriptions, revocation, expiry, forged proofs, duplicate events,
invalid batches, and pressure-window recalculation.
