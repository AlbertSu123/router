#!/usr/bin/env bash
# Package Router.app, install it to ~/Applications, start it at login.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="dev.bryan.router"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DEST="$HOME/Applications/Router.app"

APP_NAME=Router BUNDLE_ID="$LABEL" MENU_BAR_APP=1 SIGNING_MODE=adhoc \
  MACOS_MIN_VERSION=15.0 "$ROOT/Scripts/package_app.sh" release

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
pkill -x Router 2>/dev/null || true
"$ROOT/../install.sh"
rm -rf "$DEST"
mkdir -p "$HOME/Applications"
cp -R "$ROOT/Router.app" "$DEST"

mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>$LABEL</string>
    <key>Program</key><string>$DEST/Contents/MacOS/Router</string>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key>
    <dict><key>SuccessfulExit</key><false/></dict>
    <key>ThrottleInterval</key><integer>5</integer>
</dict>
</plist>
PLIST
# bootout can return before launchd has finished removing its registration.
# Retry bootstrap briefly rather than reporting success for an old process.
BOOTSTRAPPED=0
for _ in {1..20}; do
  if launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null; then
    BOOTSTRAPPED=1
    break
  fi
  sleep 0.25
done
[[ "$BOOTSTRAPPED" == 1 ]] || { echo "ERROR: Could not register Router with launchd." >&2; exit 1; }

for _ in {1..10}; do
  pgrep -x Router >/dev/null && { echo "Router.app is running."; exit 0; }
  sleep 0.4
done
echo "ERROR: Router.app did not start. Check Console.app." >&2
exit 1
