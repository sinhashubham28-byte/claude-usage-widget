# Claude Usage Desktop Widget — Windows Setup

Shows your Claude Pro/Max usage as a small floating panel on your Windows
desktop: **session (5h)**, **weekly · Chat + Code** (a shared quota — usage
from claude.ai chat and Claude Code both count against it), and **credits**
(extra usage credits that kick in once you hit a plan limit).

This is the Windows port of the original macOS widget — see
[`../macos/SETUP.md`](../macos/SETUP.md) for the macOS build, which lives
entirely under `../macos/` and is unrelated to this folder.

There are two ways to run this. Pick one.

---

## Option A — Installer (recommended)

Download **`Claude Usage Setup <version>.exe`** from
[Releases](../../releases) — a self-contained installer that bundles the
app, the poller, and Electron itself, so there's nothing else to install
first and no Node.js needed on the target machine. (It is *not* checked
into this repo — `windows/panel/dist/` is build output, gitignored; you
only get that path if you build it yourself, see below.)

1. Run the installer. It's a **per-user** install (`perMachine: false`), so
   it does **not** need Administrator rights and installs to
   `%LOCALAPPDATA%\Programs\Claude Usage`.
2. **Windows will likely show a SmartScreen warning** ("Windows protected
   your PC"). This is expected — the installer isn't code-signed (that
   needs a paid certificate we don't have). Click **More info → Run
   anyway** if you trust the build (or built it yourself from this repo).
3. That's it. The app starts itself after install, polls usage every 30
   seconds on its own (backing off automatically if the endpoint ever
   rate-limits it; no separate background task needed), and defaults to
   starting at login. Drag the panel from anywhere to move it. Click the ↻
   icon in the panel's header (or "Refresh now" in the tray menu) to force
   an immediate update instead of waiting; click the **×** to hide the
   panel (it keeps running in the tray — click the tray icon or "Show
   panel" to bring it back). Right-click the tray icon (bottom-right, near
   the clock) to toggle **Start with Windows**, switch **Theme**
   (Dark/Light), change transparency, choose which rows to **Show**
   (Session/Weekly/Credits individually — the panel resizes to match), or
   Quit.
   Launching the app again while it's already running (e.g.
   double-clicking the shortcut a second time) just brings the existing
   panel to front — it won't open a second copy.

To uninstall: **Settings → Apps → Claude Usage → Uninstall** (or via Control
Panel), same as any other Windows app. This also removes the "Start with
Windows" registry entry.

### Building the installer yourself

```powershell
cd windows\panel
npm install
npm run dist
```

Output lands in `windows\panel\dist\Claude Usage Setup <version>.exe`. This
step needs Node.js; running the resulting installer does not.

---

## Option B — Manual / dev setup (run from source, no installer)

Useful if you'd rather not run an unsigned installer, or you're actively
changing the code.

### Requirements
- **Node.js** (any recent LTS) — https://nodejs.org.
- Windows 10 or 11. No admin rights required.

### 1. Install the panel's dependencies

```powershell
cd windows\panel
npm install
```

### 2. Test the poller once by hand

```powershell
cd windows
node dev\claude-usage-poll.js
```

This should exit silently and write a file to
`%LOCALAPPDATA%\claude-usage\accounts\<youremail>.json`. Check it:

```powershell
Get-Content "$env:LOCALAPPDATA\claude-usage\accounts\*.json" | ConvertFrom-Json
```

If nothing was written, make sure you've used Claude Code at least once
recently (it needs `%USERPROFILE%\.claude\.credentials.json` and
`%USERPROFILE%\.claude.json` to both exist and contain a valid login).

### 3. Run the panel by hand

```powershell
cd windows\panel
npm start
```

A small panel (dark by default) should appear in the top-right of your
screen with three rows: Session, Weekly (hover it — it's a shared quota
with claude.ai chat, not Claude Code alone), and Credits.
Drag it from anywhere on the panel to move it. It polls itself every 30
seconds while running (backing off automatically if the endpoint ever
rate-limits it) — no separate poller process needed — and the ↻
button forces an immediate refresh; the **×** button hides it (it's still
running in the tray). Right-click the tray icon for transparency presets,
**Theme** (Dark/Light), which rows to **Show**, "Start with Windows",
"Refresh now", and Quit.
Running `npm start` again while an instance is already up just focuses the
existing window instead of opening a second one.

> **If you see `TypeError: Cannot read properties of undefined (reading
> 'handle')`:** your terminal has `ELECTRON_RUN_AS_NODE=1` set in its
> environment — common inside VS Code/Cursor's integrated terminal, since
> those editors are themselves Electron apps and set this for their own
> child processes. Run `npm start` from a plain `cmd.exe` or PowerShell
> window opened normally (not the IDE's built-in terminal), or clear the
> variable first: `Remove-Item Env:ELECTRON_RUN_AS_NODE` (PowerShell) before
> running.

### 4. Auto-start the panel at login (optional)

```powershell
cd windows
.\dev\register-tasks.ps1
```

Registers one per-user Scheduled Task (`ClaudeUsagePanel`, no admin needed)
that launches the panel at logon; the panel polls itself once running, so
there's no separate poll task. Starts automatically at your **next** login,
or immediately with:

```powershell
Start-ScheduledTask -TaskName ClaudeUsagePanel
```

To remove it: `.\dev\register-tasks.ps1 -Uninstall`.

---

## Multi-account behaviour & limitation

Same as macOS: only the currently-logged-in Claude Code account can be
polled (one token in `.credentials.json` at a time). Switching accounts in
Claude Code starts tracking the new account within ~2 minutes; the previous
account's panel entry keeps showing its last-known numbers with an "updated
Xm ago" badge.

## Troubleshooting

- **Panel says "Waiting for Claude Code data…" forever** — check
  `%LOCALAPPDATA%\claude-usage\accounts\` has at least one `.json` file. If
  not, make sure you're logged into Claude Code.
- **"usage credits not enabled" under Credits** — normal if you haven't
  turned on usage credits (Settings → Usage on claude.ai); not an error.
- **Panel doesn't appear at all** — check `Get-Process electron` (dev
  setup) or `Get-Process "Claude Usage"` (installed) in PowerShell. If
  nothing is running, try `npm start` from `windows\panel` (Option B, step
  3) to see the actual error directly.
- **(Option B only) Scheduled task didn't start** — open Task Scheduler
  (`taskschd.msc`), find `ClaudeUsagePanel` under the root Task Scheduler
  Library, check the "Last Run Result" column for an error code.

## Uninstall

**Installed via Option A:** Settings → Apps → Claude Usage → Uninstall.

**Option B (manual/dev):**

```powershell
cd windows
.\dev\register-tasks.ps1 -Uninstall
Remove-Item -Recurse -Force windows\panel\node_modules
```

**Either way**, the usage cache is untouched by uninstall (matches the
macOS behavior). Remove it if you want:

```powershell
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\claude-usage"
```
