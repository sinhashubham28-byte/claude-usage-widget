# Claude Usage Desktop Widget — macOS Setup

A native, always-on-top, frosted-glass floating panel showing your Claude
Pro/Max usage: **Session (5h)**, **Weekly** (a shared quota — usage from
claude.ai chat and Claude Code both count against it), and **Credits**
(extra usage credits that kick in once you hit a plan limit).

Two pieces, both driven by `launchd` (macOS's background-service manager):
a poller (`claude-usage-poll.sh`) that fetches your usage every 2 minutes,
and the panel itself (`claude-usage-float.swift`, compiled to a native
binary) that reads what the poller wrote and displays it.

## Requirements

- macOS.
- `jq` — install with `brew install jq` if you don't already have it.
- Xcode Command Line Tools (for `swiftc`) — install with
  `xcode-select --install` if `swiftc -version` doesn't work.

## 1. Install the poller

```bash
mkdir -p ~/.claude/scripts
cp claude-usage-poll.sh ~/.claude/scripts/claude-usage-poll.sh
chmod +x ~/.claude/scripts/claude-usage-poll.sh
```

Create `~/Library/LaunchAgents/com.claudeusage.poll.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.claudeusage.poll</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>-c</string>
        <string>~/.claude/scripts/claude-usage-poll.sh</string>
    </array>
    <key>StartInterval</key>
    <integer>120</integer>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/claude-usage-poll.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/claude-usage-poll.err</string>
</dict>
</plist>
```

Load it:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.claudeusage.poll.plist
```

Test it fetched something (may take up to 2 minutes for the first run, or
run `launchctl kickstart -k gui/$(id -u)/com.claudeusage.poll` to force it
immediately):

```bash
cat ~/.cache/claude-usage/accounts/*.json
```

If empty, make sure you've used Claude Code at least once recently (it
needs a valid login token in the macOS Keychain under
`"Claude Code-credentials"`, and `~/.claude.json` to exist).

## 2. Build and install the panel

```bash
swiftc -O claude-usage-float.swift -o claude-usage-float
codesign --force --sign - claude-usage-float
```

Create `~/Library/LaunchAgents/com.claudeusage.float.plist` (replace
`/absolute/path/to/claude-usage-float` with the real path to the binary
you just built):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.claudeusage.float</string>
    <key>ProgramArguments</key>
    <array>
        <string>/absolute/path/to/claude-usage-float</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
</dict>
</plist>
```

Load it:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.claudeusage.float.plist
```

A small frosted-glass panel should appear in the top-right of your screen
within a couple seconds, showing Session / Weekly / Credits once the
poller has written data.

## Using it

- **Drag anywhere** on the panel to move it.
- **Drag the bottom-right grip** to resize (scales the whole panel).
- **Right-click the panel**, or click the **menu-bar icon** (a small chart
  icon, added specifically so there's still a way to reach the menu even
  while the panel itself is hidden) for: **Hide/Show Panel**, **Refresh
  Now**, **Show** (toggle Session/Weekly/Credits individually — the panel
  resizes to match), **Transparency** presets, and **Quit**.
- Light/dark: this follows your Mac's system appearance automatically —
  no toggle needed, unlike the Windows version (which needed one since
  Electron doesn't do this itself).
- Position, scale, transparency, and which rows are shown persist across
  restarts in `~/.cache/claude-usage/panel-state.json`.

## Multi-account behaviour & limitation

The macOS Keychain holds exactly **one** Claude Code token at a time (you
can only be logged into one account at once). The currently-logged-in
account updates live; if you log Claude Code into a different account, the
poller notices the new token within ~2 minutes and starts tracking it too
— the panel then shows both, with the previous account's numbers frozen
at their last-known values (with an "Xm ago" badge) until you switch back.
There's no in-panel way to add/remove/switch accounts — that always
happens by logging in/out inside Claude Code itself, since that's the only
thing that actually controls which account's token exists on disk to poll.

## Troubleshooting

- **Panel says "Waiting for usage data…" forever** — check
  `~/.cache/claude-usage/accounts/` has at least one `.json` file. If not,
  check `/tmp/claude-usage-poll.err` for errors, and make sure you're
  logged into Claude Code.
- **"not enabled" under Credits** — normal if you haven't turned on usage
  credits (Settings → Usage on claude.ai); not an error.
- **Panel doesn't appear at all** — `launchctl list | grep claudeusage`
  should show both services; check `/tmp/claude-usage-poll.err` and
  Console.app for `claude-usage-float` crash logs.
- **Edited the Swift file and rebuilt, but the panel won't start** —
  recompiling over a running/mapped binary invalidates its ad-hoc
  signature, and launchd can hold a stale cached signature for that exact
  file inode. Use a clean rebuild cycle:
  ```bash
  launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.claudeusage.float.plist
  pkill -f claude-usage-float
  rm -f claude-usage-float   # new inode, drops the cached signature
  swiftc -O claude-usage-float.swift -o claude-usage-float
  codesign --force --sign - claude-usage-float
  launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.claudeusage.float.plist
  ```

## Uninstall

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.claudeusage.float.plist
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.claudeusage.poll.plist
rm ~/Library/LaunchAgents/com.claudeusage.{float,poll}.plist
rm -f ~/.claude/scripts/claude-usage-poll.sh
```

The usage cache is left untouched. Remove it if you want:

```bash
rm -rf ~/.cache/claude-usage
```
