# Claude Usage Desktop Widget — Setup

Shows your Claude Pro/Max 5-hour and 7-day usage as a floating widget on your Mac desktop.

**How it works:** Claude Code exposes real usage % via its statusline (shared quota with claude.ai chat). The script below saves that data locally every time Claude Code is active; the widget just displays whatever was last saved.

**Limitation:** data only updates while you're actively using Claude Code. If you haven't touched it in a while, the widget shows the last known numbers with a stale warning.

## 1. Make sure `jq` is installed
```bash
brew install jq
```

## 2. Install the statusline script
```bash
mkdir -p ~/.claude/scripts
cp claude-usage-statusline.sh ~/.claude/scripts/statusline.sh
chmod +x ~/.claude/scripts/statusline.sh
```

## 3. Wire it up in Claude Code's settings
Open `~/.claude/settings.json` (create it if it doesn't exist) and add:
```json
{
  "statusLine": {
    "type": "command",
    "command": "bash ~/.claude/scripts/statusline.sh"
  }
}
```
If the file already has other settings, just add the `statusLine` key alongside them. Restart Claude Code.

Send a message in Claude Code once — the `rate_limits` field only populates after the first response in a session.

## 4. Install Übersicht
Download the free app from http://tracesof.net/uebersicht/, open it, and let it launch (it sits quietly and renders widgets on your desktop).

## 5. Install the widget
```bash
mkdir -p ~/Library/Application\ Support/Übersicht/widgets/claude-usage
cp claude-usage-widget.jsx ~/Library/Application\ Support/Übersicht/widgets/claude-usage/index.jsx
```
Übersicht auto-detects new widgets within a few seconds. You should see a small dark panel in the top-right of your screen with two progress bars.

## Customizing position/style
Edit the `className` block at the top of `index.jsx` — e.g. change `right: 20px` to `left: 20px`, or move it to a corner that doesn't overlap your other widgets.

## Troubleshooting
- **Widget says "Waiting for Claude Code data…" forever** — check `~/.cache/claude-usage/latest.json` exists and has content. If not, double check step 3's settings.json syntax and restart Claude Code.
- **"no data yet" under a specific window** — that's normal right after a fresh session; it fills in after your first message.
- **Widget doesn't appear at all** — open Übersicht's menu bar icon → check the widget is enabled, or open its console for JS errors.
