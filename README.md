# router

Switch Claude Code between Claude accounts, and Codex between ChatGPT
accounts, from the macOS menu bar or the terminal.

Paste this into your agent (Claude Code) to get set up:

```text
Clone https://github.com/AlbertSu123/router
and follow its AGENTS.md to install the router CLI and menu bar app. Verify each step. Stop and ask me
when a sign-in needs my browser.
```

- One click switches every Claude Code session, running ones included.
  Codex follows on the next request when the local proxy is enabled.
- Accounts are identified by email. Credentials live in the macOS Keychain.
- Adding an account is one browser sign-in. Switching never asks you to
  log in again.
- The menu bar carries one segment per tool — that tool's icon, the window
  it meters, and how much of it is spent (`5h 8%`, `7d 10%`). Account names
  live in the panel behind it.
- The panel lists every account with all of its limits: the 5-hour and
  7-day windows, per-model windows, or the credit pool for accounts billed
  per use instead of by plan window. Which windows exist is up to the plan,
  and each is labelled with the period it actually covers.

## Manual install

Requirements: macOS 15+, a Swift 6.2+ toolchain (Xcode command line tools),
[Bun](https://bun.sh), and Claude Code logged in with a Claude
subscription account.

```bash
git clone https://github.com/AlbertSu123/router.git
cd router
./install.sh                      # CLI + PATH entry in ~/.zshrc
menubar/Scripts/install_app.sh    # menu bar app, starts at login
```

## Distributing this fork

Share the repository link and the manual install commands above for
source installs. ChatGPT personal sign-in additionally requires the Codex CLI;
Google personal sign-in does not. Users add their own subscription credentials
and sign in personally to enable shared metering.

There is no standalone binary release yet. Copying only `Router.app` to another
Mac is insufficient: it currently invokes `~/.router/bin/router`, whose runtime
requires Bun and the installed CLI sources.

For a download-and-install release, package the app together with its CLI and
Bun runtime, provide first-run installation, and test it on a clean Mac without
build tools. Sign all executable components with the publisher's Developer ID
Application certificate, notarize and staple the release, then upload the DMG
or ZIP to this fork's GitHub Releases. Publish architecture requirements (or
build a universal release) and the macOS 15 minimum. Verify both personal
sign-in providers with an external user before opening public distribution.

## Use

Click the menu bar item to switch accounts or to add one. The same from the
terminal:

```bash
router add              # browser sign-in; paste the code; done
router add --codex      # browser sign-in for a ChatGPT account; nothing to paste
router add --codex --device-auth # authorize this Mac from another computer
router use <name>       # switch every Claude Code session to this account
router use main         # back to the normal keychain login
router use codex:<name> # switch Codex to this account
router list             # all accounts, active one starred
router usage            # usage limits per account
router remove <name>    # delete an account's credential
router doctor           # check the installation
```

`router add` opens the Claude sign-in page. Sign in as the account you want
to add. Use a private browser window for an account that is not your
browser default. The profile takes its name from the account email.

`router add --codex` hands the sign-in to `codex login` itself, pointed at a
throwaway `CODEX_HOME`, so the account you are currently signed in to is
never disturbed. Codex accounts are addressed as `codex:<name>` everywhere.

### Add a Codex account from another computer

In the menu bar, choose **Add Codex → Another computer → Get sign-in code**.
Use **Copy instructions** to give the account owner the link and one-time code.
They sign in and approve access in their own browser; keep Router’s window open.
Router stores the authorized account in this Mac’s Keychain, available for usage
checks and switching. Adding it does not select it automatically. The other
computer does not need Router or an SSH connection.

The account must allow device code login in ChatGPT security settings or workspace
permissions. Device codes expire 15 minutes after they are issued; cancel or retry to get a fresh code.
This grants this Mac access to use the account; it does not run Codex on the other
computer. The terminal equivalent is `router add --codex --device-auth`.

## How it works

- `router add` runs the same OAuth (PKCE) flow as `claude setup-token` and
  stores the token in the Keychain (service `router`).
- A switch swaps the `Claude Code-credentials` keychain item. Running
  Claude Code sessions re-read it on their next request; they cache the
  credential in memory for up to ~30 seconds, so a switch reaches them
  within that window. Conversations survive switches.
- `main` is your normal login. Its credential is stashed while another
  account is active, and restored on switch-back.
- A running `main` session can refresh its OAuth pair and overwrite the
  swap. The menu bar app runs `router heal` every 10 seconds, which
  re-stashes the fresh credential and re-asserts your selection.

Codex works the other way around, because it keeps its credential in a file
rather than the Keychain:

- `~/.codex/auth.json` is the source of truth for which ChatGPT account is
  active. `heal` reads it, parks a copy of whatever it holds under that
  account's profile (Keychain service `router-codex`), and points the menu
  at it — so `codex login`, `codex logout`, and Codex's own token refreshes
  are all picked up rather than fought.
- A switch parks the live credential and writes the chosen profile's in its
  place. There is no `main`: a parked Codex credential is the complete
  `auth.json` Codex itself wrote, refresh token included, so every account
  is a peer and none needs stashing.
- Codex pins a session to the account it started with and refuses to reload
  `auth.json` for a different account, so a switch lands on the next session
  you start unless the local proxy below is enabled.

### Switch running Codex sessions with the local proxy

```bash
./install.sh
router proxy install
router proxy enable
router proxy status
```

Relaunch existing Codex sessions once, resuming their original conversation
IDs. Future `router use codex:<name>` and menu-bar switches apply on each
session's next request. Requests already streaming stay on their starting
account. There is no automatic fallback: if the selected account is out of
quota, select another account and retry in the same conversation.

The launchd service listens only on `127.0.0.1:18789` and requires a private
local token. Codex sends it in a separate `x-router-token` header stored in
its owner-readable config. The provider keeps `requires_openai_auth = true`
and does not use a provider token command: command-backed auth replaces
Codex's normal auth manager and can leave browser tools without a ChatGPT
token. A normal ChatGPT sign-in is still required for those tools. The proxy forwards
Responses and compaction requests directly to OpenAI, replacing credentials
per request. It uses macOS’s native curl HTTP/2 transport, not WebSockets. Credentials pass
to curl through a private pipe, never command arguments or temporary files. Large conversation uploads
are losslessly compressed with zstd; already encoded requests keep their encoding. Diagnostics include only
profile names, session IDs, timestamps, and HTTP status, never request bodies
or tokens. Do not run `router proxy token` interactively or paste its output.

Enabling backs up `~/.codex/config.toml` under `~/.router/` and adds the
`router` model provider. `router proxy disable` removes only Router's managed
configuration and restores the previous default provider while preserving
other edits. The service stays available for existing routed sessions.

To upgrade an older command-auth setup, rerun the install/enable commands
above when no responses are streaming, then resume each existing Codex
conversation once. Enable upgrades only Router's marked provider block and
saves a separate pre-upgrade backup; it preserves the original disable backup.
Older sessions can still use the previous local bearer-token authentication.
The incoming ChatGPT credential and local token are never forwarded upstream:
model requests use the Router-selected account. Browser/plugin identity remains
the Codex session's signed-in ChatGPT identity and does not follow model-account
switches. Do not share the managed provider block; it contains a local secret.
`router doctor` checks for the legacy auth configuration, mismatched local
tokens, and an outdated proxy service, and prints the repair command.

Regression checks run on pushes and pull requests through GitHub Actions:
`bun test cli metering`, `python3 -m unittest discover -s cli/tests -p '*integration.py' -v`,
and the Swift build/reset checks. They cover both authentication modes,
account switching, credential isolation, old-config migration and backups,
idempotent enable/disable, and launchd's delayed shutdown during upgrades.

Desktop Codex clients that read the same config may also use this provider
after relaunch; desktop UI identity and ChatGPT chat traffic are not switched
by this proxy. Provider-filtered history lists may hide conversations created
with the old provider; explicit `codex resume <session-id>` preserves them.

State lives in `~/.router/` (no credentials on disk; they stay in the
Keychain, except the one live `~/.codex/auth.json` that Codex reads).

## Statusline (optional)

To show the active account in the Claude Code statusline, resolve it like
this in your statusline script:

```bash
acct=$(cat "$HOME/.router/current" 2>/dev/null)
if [ -z "$acct" ] || [ "$acct" = "main" ]; then
  acct=$(jq -r '.oauthAccount.emailAddress // ""' "$HOME/.claude.json")
else
  acct=$(jq -r --arg n "$acct" '.profiles[$n].email // $n' "$HOME/.router/profiles.json")
fi
```

Optional, feeds `router usage` for switched accounts: persist the
`rate_limits` numbers your statusline receives on stdin:

```bash
[ -n "$five_pct" ] && printf '{"ts":%s,"five":%s,"week":%s}\n' \
  "$(date +%s)" "$five_pct" "${week_pct:-null}" \
  > "$HOME/.claude/cache/rate-limits-${acct_name:-main}.json"
```

## Uninstall

```bash
router use main
launchctl bootout "gui/$(id -u)/dev.bryan.router" 2>/dev/null
rm -rf ~/Applications/Router.app ~/Library/LaunchAgents/dev.bryan.router.plist ~/.router
# then delete the "router", "router-stash" and "router-codex" Keychain items
# and the PATH line in ~/.zshrc
```

## Caveats

- The sign-in page uses your browser's claude.ai session; the account you
  are logged into there is the account you add.
- If a switched account stops authenticating, run `router use main` and
  re-add it (tokens can expire; `router heal` renews them when the sign-in
  returned a refresh token).
- Direct Codex sessions keep their starting account. Enable the local proxy
  and restart/resume once to switch on subsequent requests.
- `router add --codex` needs the `codex` CLI on `PATH` (or `ROUTER_CODEX_BIN`
  pointing at it) and a free port 1455 for browser sign-in. Device sign-in does not need that port.
- macOS only. Built for personal use; the credential layouts it relies on
  are Claude Code and Codex internals and can change.

## Banked Codex reset tracking

Each Codex account shows its available banked resets, how many can be used now,
and each reset's expiration date, local time zone, and live countdown. Reset
credits are read from OpenAI alongside usage. Usage polls run every 30 seconds
after the previous check finishes, independently of account repair. Opening the
menu also refreshes usage; each row shows when its reading was received.
Resets expiring within seven days are highlighted in the account list, even for
inactive accounts.

Unknown or partial expiration data is explicitly labeled. If a usage request
fails, cached readings are marked and retained for at most two hours. Tracking
never consumes a reset. Use Codex Settings → Usage to review and apply one.

## Menu-bar visibility

Router shows the Claude and OpenAI logos, each followed by the active usage
window and percentage (for example, `5h 12%` or `7d 56%`). Click for all account
usage and reset expiration details. The rendered label is cached and has no
animation timer, preventing the previous rendering loop.
Reopening Router from Finder or Spotlight opens the same account panel.

Router starts at login and launchd relaunches it after a crash or abnormal exit.
Choosing Quit intentionally stops it until you reopen it or log in again.
macOS still controls menu-bar layout: Command-drag Router nearer the clock if
other menu-bar items crowd it out. No app can reserve unlimited menu-bar space.

## Shared usage and personal sign-in

Click **Sign in to Router**, then **Sign in with ChatGPT** or **Continue with
Google**, to connect your personal identity without a Router password. After
sign-in, **Shared usage** opens a dashboard showing each person's raw tokens and
pressure-weighted usage, restricted to subscriptions you have signed into.
Spare capacity carries less weight than usage in quota windows that fill up.

The server runs at [router-usage.gudvc.com](https://router-usage.gudvc.com) on the
`gud` VPS. Provider credentials are verified transiently; only usage metadata is
stored. Existing direct sessions need a one-time restart/resume to use Router's
metered transports. See [metering setup and accounting](metering/README.md) for
coverage, access expiry, scoring, deployment, and rollback commands.
