# router

Switch Claude Code between Claude accounts, and Codex between ChatGPT
accounts, from the macOS menu bar or the terminal.

Paste this into your agent (Claude Code) to get set up:

```text
Clone https://github.com/bryanhpchiang/router and follow its AGENTS.md to
install the router CLI and menu bar app. Verify each step. Stop and ask me
when a sign-in needs my browser.
```

- One click switches every Claude Code session, running ones included.
  Codex follows on the next session you start.
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

Requirements: macOS 15+, the Xcode command line tools (`swift`),
[Bun](https://bun.sh), and Claude Code logged in with a Claude
subscription account.

```bash
git clone https://github.com/bryanhpchiang/router
cd router
./install.sh                      # CLI + PATH entry in ~/.zshrc
menubar/Scripts/install_app.sh    # menu bar app, starts at login
```

## Use

Click the menu bar item to switch accounts or to add one. The same from the
terminal:

```bash
router add              # browser sign-in; paste the code; done
router add --codex      # browser sign-in for a ChatGPT account; nothing to paste
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
  you start.

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
- A Codex switch does not reach a Codex session that is already running;
  start a new one. Claude Code sessions do follow.
- `router add --codex` needs the `codex` CLI on `PATH` (or `ROUTER_CODEX_BIN`
  pointing at it) and, like `codex login` itself, a free port 1455.
- macOS only. Built for personal use; the credential layouts it relies on
  are Claude Code and Codex internals and can change.
