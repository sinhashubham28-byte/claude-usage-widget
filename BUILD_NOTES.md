# Claude Usage Widget — Build Notes & Issue Log

A desktop widget that shows your Claude subscription usage (5-hour session +
7-day weekly limits) as a small panel that **floats above every app**, works in
**any editor** (Cursor, PyCharm, terminal), tracks **multiple accounts**, and
**auto-starts at login**.

This document records how it was built, the architecture we ended up with, and
every problem we ran into along the way (several of which forced a full redesign).

> **Platform note:** sections 1-8 below describe the original **macOS**
> build (Swift/AppKit + launchd + Keychain). Section 9 covers the
> **Windows** port, which reuses the same design but swaps every
> macOS-specific piece (Keychain → plain credential file, launchd → Task
> Scheduler, Swift/AppKit → Electron) and adds Cowork usage tracking. The
> macOS files stay in this top-level folder; the Windows port lives entirely
> under `windows/`.

---

## 1. What it does (final state)

- A always-on-top, draggable panel in the top-right of the screen.
- Shows, per Claude account, two color-coded bars: **5-hour session** and
  **7-day weekly**, each with a "resets in Xh Ym" countdown.
- Data refreshes automatically every ~2 minutes, independent of whether you're
  actively using Claude Code.
- Survives reboots (launchd auto-start).

Current live reading example: `alex · Acme Inc — 5h: 67% 7d: 42%`.

---

## 2. Final architecture

```
                    ┌─────────────────────────────────────────┐
                    │  macOS Keychain: "Claude Code-credentials"│
                    │  → .claudeAiOauth.accessToken             │
                    └───────────────────┬───────────────────────┘
                                        │ read token
                                        ▼
  ~/.claude.json  ──identity──►  claude-usage-poll.sh  ──HTTPS GET──►  api.anthropic.com
 (.oauthAccount:                 (LaunchAgent, every 120s)            /api/oauth/usage
  name/org/email)                       │                             (five_hour, seven_day…)
                                        │ normalize + write
                                        ▼
                    ~/.cache/claude-usage/accounts/<email>.json
                    { rate_limits:{five_hour,seven_day:{used_percentage,resets_at}},
                      account:{name,org,email}, updated }
                                        │ read every 15s
                                        ▼
                    claude-usage-float  (native Swift/AppKit panel)
                    (LaunchAgent, always-on-top, draggable, multi-account)
```

### Data source — the key decision
Usage comes from the **same endpoint Claude Code itself uses**:

```
GET https://api.anthropic.com/api/oauth/usage
Headers:
  Authorization: Bearer <oauth access token>
  anthropic-beta: oauth-2025-04-20
  User-Agent: claude-cli/<version>
```

Response (relevant fields):
```json
{
  "five_hour": { "utilization": 67.0, "resets_at": "2026-07-22T15:59:59.543+00:00" },
  "seven_day": { "utilization": 42.0, "resets_at": "2026-07-26T17:59:59.543+00:00" },
  "seven_day_opus": null,
  "limits": [ { "kind":"session","percent":65,"resets_at":"…" }, … ],
  "spend": …
}
```

The poller **normalizes** this to the widget's internal shape:
`utilization → used_percentage`, and the ISO-8601 `resets_at → unix seconds`.

---

## 3. File inventory

Source files (this folder):
| File | Purpose |
|------|---------|
| `claude-usage-poll.sh` | **Primary** data source. Reads Keychain token + `~/.claude.json`, calls `/api/oauth/usage`, writes per-account cache. |
| `claude-usage-float.swift` | The native always-on-top panel. Compiled with `swiftc -O`. |
| `claude-usage-statusline.sh` | Legacy/bonus: Claude Code statusline that also writes the cache. **Only fires in the terminal** (see Issue 3). Redundant now but harmless. |
| `claude-usage-widget.jsx` | **Deprecated** Übersicht widget (see Issues 1–2). No longer installed. |
| `SETUP.md` | Original setup guide for the (now superseded) Übersicht approach. |

Installed / runtime locations:
| Path | What |
|------|------|
| `~/.claude/scripts/claude-usage-poll.sh` | Installed poller |
| `~/Library/LaunchAgents/com.claudeusage.claude-usage-poll.plist` | Poller timer (StartInterval 120s, RunAtLoad) |
| `<this folder>/claude-usage-float` | Compiled panel binary |
| `~/Library/LaunchAgents/com.claudeusage.claude-usage-float.plist` | Panel auto-start (RunAtLoad, KeepAlive) |
| `~/.cache/claude-usage/accounts/*.json` | Per-account usage snapshots (what the panel renders) |
| `~/.claude/scripts/statusline.sh` + `statusLine` in `~/.claude/settings.json` | Legacy statusline (bonus terminal-only refresh) |

---

## 4. Issue log (the interesting part)

### Issue 1 — Übersicht wouldn't install without sudo
`brew install --cask ubersicht` downloaded fine but failed moving the app into
`/Applications` because that needs a `sudo` password (unavailable in a
non-interactive context).
**Fix:** extracted the already-downloaded app from Homebrew's cache
(`~/Library/Caches/Homebrew/downloads/…Uebersicht….zip`) straight into
`~/Applications` with `ditto -x -k`. No sudo needed.

### Issue 2 — Übersicht widgets can't float above apps and can't be moved  ⚠️ redesign
Übersicht renders widgets on the **desktop layer** (like wallpaper), *behind*
all windows, with fixed CSS positioning. There is no setting to make one float
above other apps or to drag it.
**Fix:** abandoned Übersicht entirely and built a **native Swift/AppKit panel**:
- `NSWindow` with `level = .screenSaver` → sits above all apps, including
  fullscreen.
- `collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary,
  .ignoresCycle]` → visible on every Space.
- `isMovableByWindowBackground = true` → drag anywhere to reposition.
- `setActivationPolicy(.accessory)` → no Dock icon.
This directly fixed both "float above everything" and "make it movable".

### Issue 3 — statusLine is CLI-only; it never fires in the IDE extension  ⚠️ redesign
The original design fed the widget from Claude Code's **statusLine** command.
It worked when tested by hand, but the cache never updated in real use.
**Diagnosis:** the user runs Claude Code as the **Cursor/PyCharm extension**,
not the terminal. We proved empirically that after restarting Claude Code and
running several turns, the cache timestamp did **not** advance — the statusLine
command was never executed. Official docs confirmed it: *statusLine is a
terminal/CLI feature and is not run by the IDE extension.*
**Fix:** stop depending on statusLine. Fetch usage directly from the API with a
background poller (see Issue 5) so it works in **any** editor.

### Issue 4 — "logged out and back in" but the account didn't change
The user logged out/in on the **Claude desktop chat app**, expecting the widget
to switch accounts. It didn't, because:
- The widget's account identity comes from **Claude Code's** login
  (`~/.claude.json` → `.oauthAccount`), which is a *separate* login from the
  desktop chat app and from claude.ai in a browser.
- Also, the statusLine JSON payload contains **no account fields at all** — so
  account name/org/email must be read from `~/.claude.json` independently.
**Fix:** documented that the account tracked is whatever **Claude Code** is
logged into, and read identity from `~/.claude.json`.

### Issue 5 — finding a data source that works everywhere
Needed usage data without the statusline. Investigated:
- Session transcript JSONL files → only contained the keywords inside message
  text, **no structured usage data**. Dead end.
- `claude` CLI subcommands (`--help`) → no `usage`/`status` command. Dead end.
- **Searched the Claude Code binary's strings** → found the endpoint list,
  including `/api/oauth/usage` and `/api/oauth/profile`.
**Fix:** confirmed `GET https://api.anthropic.com/api/oauth/usage` returns HTTP
200 with real `five_hour`/`seven_day` data using the OAuth token from Keychain.
(`https://claude.ai/api/oauth/usage` returned 403 — wrong host.)

### Issue 6 — API field names didn't match the widget
The endpoint returns `utilization` (0–100) and an ISO-8601 `resets_at`, but the
panel expects `used_percentage` and a **unix-seconds** `resets_at`.
**Fix:** normalized in the poller with `jq`:
`utilization → used_percentage`; strip fractional seconds, convert `+00:00`→`Z`,
`fromdateiso8601` → unix seconds.

### Issue 7 — would Keychain reads work under launchd?
Reading `Claude Code-credentials` by hand inherited the session's Keychain
access; a launchd agent runs in a different context and could be **denied** or
trigger a permission **prompt**.
**Fix:** verified explicitly — a `launchctl kickstart` run of the poller read
the token and wrote fresh data with no prompt and `exit code 0`. Confirmed
working under launchd.

### Issue 8 — Team plan usage visibility (resolved, not a blocker)
Docs say the statusLine `rate_limits` is a Pro/Max feature, which cast doubt on
whether the user's **Team** seat would expose usage at all.
**Outcome:** the `/api/oauth/usage` endpoint returns real 5h/7d numbers for the
Team account, so this was a non-issue in the final design.

### Issue 9 — panel killed by launchd: `OS_REASON_CODESIGNING`
After recompiling the Swift binary, the panel ran fine when launched by hand but
launchd refused to start it, reporting `last exit reason = OS_REASON_CODESIGNING`
and `job state = spawn failed`. Recompiling **over a running/mapped binary**
invalidates its ad-hoc signature, and launchd holds a stale cached signature for
that file inode — so even re-signing in place didn't clear it.
**Fix:** use a clean rebuild cycle that produces a *new inode* and an explicit
signature, with the service fully unloaded first:
```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.claudeusage.claude-usage-float.plist
pkill -f claude-usage-float
rm -f claude-usage-float                       # new inode, drops cached signature
swiftc -O claude-usage-float.swift -o claude-usage-float
codesign --force --sign - claude-usage-float   # explicit ad-hoc signature
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.claudeusage.claude-usage-float.plist
```
**Always use this sequence when rebuilding the panel** — a plain `swiftc` +
`kickstart` will silently fail to start.

### Issue 10 — account switch wrote `null` over good data
Right after switching Claude accounts, the Acme Inc panel entry went to
`null%`. The endpoint can return `{"five_hour": null, "seven_day": null}` during
an account switch (token and `~/.claude.json` briefly disagree), and the poller's
guard used `jq 'has("five_hour")'` — which is **true even when the value is
null** — so it happily overwrote good data.
**Fix:** validate non-null *values*, not key presence:
```bash
jq -e '(.five_hour.utilization != null) or (.seven_day.utilization != null)'
```
An account's last-known numbers now survive until real data replaces them.
(A file already clobbered with nulls repopulates the next time you log into that
account, since only the logged-in account's token can be polled.)

### Minor — `timeout` not on macOS
Used `timeout` in a test; macOS ships `gtimeout` (coreutils) instead. Reworked
the test without it.

---

## 5. Multi-account behaviour & limitation

The Keychain holds exactly **one** Claude Code token at a time (you can only be
logged into one account at once). So:
- The **currently logged-in** account updates **live** every 2 min.
- When you switch accounts in Claude Code (any IDE), the token changes and the
  poller starts tracking the new account within ~2 min; a new per-account file
  appears and the panel grows to show both.
- The **other** account shows its **last-known** numbers with an "updated Xm
  ago" badge until you switch back.

To show **both accounts live simultaneously** we'd need to persist each
account's token as you switch and refresh both each cycle (more complex + stores
tokens in a file). Not implemented yet.

A second account must be a **paid** Claude Code plan (Pro/Max/Team); free
accounts can't authenticate to Claude Code, so there's no token to read.

---

## 6. Operating / troubleshooting

**Reload the poller after editing it:**
```bash
cp claude-usage-poll.sh ~/.claude/scripts/claude-usage-poll.sh
launchctl kickstart -k gui/$(id -u)/com.claudeusage.claude-usage-poll
```

**Rebuild & restart the panel after editing the Swift** (see Issue 9 — the
`rm` and `codesign` steps are required, not optional):
```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.claudeusage.claude-usage-float.plist
pkill -f claude-usage-float
rm -f claude-usage-float
swiftc -O claude-usage-float.swift -o claude-usage-float
codesign --force --sign - claude-usage-float
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.claudeusage.claude-usage-float.plist
```

**Panel appearance & controls:** frosted glass via `NSVisualEffectView`
(`.hudWindow`, `blendingMode = .behindWindow`) so it blurs what's behind it. The
glass sits in a transparent container *underneath* the text layer, so its opacity
can be lowered without fading the text. Drag anywhere to move · drag the
bottom-right grip to resize (scales the whole panel) · right-click →
**Transparency** for 5 presets. Position, scale and transparency persist in
`~/.cache/claude-usage/panel-state.json`.

**See what the panel is reading:**
```bash
for f in ~/.cache/claude-usage/accounts/*.json; do jq . "$f"; done
```

**Poller logs:** `/tmp/claude-usage-poll.log`, `/tmp/claude-usage-poll.err`

**Manually test the endpoint:**
```bash
TOKEN=$(security find-generic-password -s "Claude Code-credentials" -w | jq -r '.claudeAiOauth.accessToken')
curl -s -H "Authorization: Bearer $TOKEN" -H "anthropic-beta: oauth-2025-04-20" \
     -H "User-Agent: claude-cli/2.x" https://api.anthropic.com/api/oauth/usage | jq '{five_hour, seven_day}'
```

**Panel controls:** drag anywhere to move · right-click → Quit.

---

## 7. Uninstall

```bash
# stop & remove background agents
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.claudeusage.claude-usage-float.plist
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.claudeusage.claude-usage-poll.plist
rm ~/Library/LaunchAgents/com.claudeusage.claude-usage-{float,poll}.plist

# remove scripts, cache, binary
rm -f ~/.claude/scripts/claude-usage-poll.sh ~/.claude/scripts/statusline.sh
rm -rf ~/.cache/claude-usage

# (optional) remove the statusLine key from ~/.claude/settings.json by hand
```

---

## 8. Notes / caveats

- `/api/oauth/usage` is an **internal, undocumented** endpoint used by Claude
  Code. It's used here only to read **your own** usage with **your own** token.
  It could change without notice; if the poller stops working, re-check the
  endpoint/fields against a fresh `--debug` capture or the binary strings.
- The OAuth access token expires and is refreshed by Claude Code when you use
  it. If the poller runs while the token is expired (e.g. you haven't used
  Claude Code in a long time) the API call fails and the poller **keeps the
  last-known data** rather than clobbering it.

---

## 9. Windows port (2026-08-11)

All files under `windows/` — see [`windows/SETUP.md`](windows/SETUP.md) for
install steps. Same overall pipeline (credential file → poller → cache →
panel), three things changed and one thing was added.

### 9.1 Credential storage differs from macOS — and is simpler
Investigated where Claude Code keeps its OAuth token on Windows. Unlike
macOS (Keychain item `"Claude Code-credentials"`), Windows Claude Code
writes a **plain JSON file**: `%USERPROFILE%\.claude\.credentials.json`,
with the same `.claudeAiOauth.accessToken` shape the macOS Keychain blob
had. No Windows Credential Manager involved, no `cmdkey`/`vaultcmd` entry —
confirmed by checking `cmdkey /list` (nothing) vs. the file existing
directly. This actually simplifies the poller (no OS-keychain API calls,
just a file read) at the cost of the token sitting in a plaintext file
(that's Claude Code's own choice on this platform, not something this
project controls).
Identity (`%USERPROFILE%\.claude.json` → `.oauthAccount`) is in the same
place and shape as macOS.

### 9.2 launchd → Task Scheduler
`windows/register-tasks.ps1` registers two per-user Scheduled Tasks
(`ClaudeUsagePoll`, `ClaudeUsagePanel`), both triggered `AtLogOn` with
`LogonType Interactive` — deliberately **not** "run whether user is logged
on or not", since that mode requires storing a password and Administrator
rights. The poller re-arms via a repetition pattern (every 2 min, for a
~10-year duration) since Windows has no direct equivalent of launchd's bare
`StartInterval`. `-Uninstall` removes both. Registration is a step the user
runs themselves (documented in SETUP.md), matching how the macOS SETUP.md
also has the user run the install commands rather than having them applied
automatically.

### 9.3 Swift/AppKit → Electron
No Swift/AppKit equivalent exists on Windows. Chose the GUI stack by
checking what actually works on the target machine first: `dotnet` was on
PATH but reported "No .NET SDKs were found" (would need a ~200-400MB SDK
install to compile a WPF app), Python was only a Microsoft Store execution
alias stub (not actually installed), AutoHotkey wasn't present at all.
Node.js was the only already-working GUI-capable runtime, so built the
panel as an Electron app (`windows/panel/`) — `main.js` (BrowserWindow +
Tray + Scheduled-Task-friendly lifecycle), `preload.js` (contextBridge,
`contextIsolation: true`, no `nodeIntegration`), `index.html` /
`styles.css` / `renderer.js` (the actual bars UI, polling the cache dir
every 15s like the original Übersicht widget did).

**Known gap vs. macOS:** the original used `NSVisualEffectView` with
`blendingMode = .behindWindow` for a true blur-through-to-desktop glass
effect. Chromium's `backdrop-filter` can't see real desktop pixels behind a
transparent frameless window (no compositor access for privacy/perf
reasons), so the Electron panel uses a solid semi-transparent background
with adjustable alpha (the same 5 transparency presets, via the tray menu)
instead of true blur. Real Acrylic/Mica would need a native addon (e.g.
`electron-acrylic-window`) — not implemented, left as a possible follow-up.

**Gotcha hit while testing:** running the panel from inside a VS Code/Cursor
integrated terminal fails with
`TypeError: Cannot read properties of undefined (reading 'handle')`. Cause:
those editors are themselves Electron apps and set `ELECTRON_RUN_AS_NODE=1`
for their own child processes, which makes any nested `electron.exe` run as
plain Node instead of booting the Electron main-process APIs (`ipcMain` etc.
come back `undefined`). Fix: run from a plain `cmd.exe`/PowerShell window,
or `Remove-Item Env:ELECTRON_RUN_AS_NODE` first. Documented in
`windows/SETUP.md` since it's a very confusing error to hit blind. This
only affects manual `npm start` testing — Scheduled-Task-launched processes
get a clean environment and aren't affected.

**Verification approach:** rather than screenshotting the whole desktop to
confirm the panel rendered (which risks capturing *other*, unrelated
windows/sessions running on the same machine), used
`webContents.capturePage()` to capture only the panel's own window content.
Confirmed real cache data rendered correctly (color-coded bars, correct
"resets in Xh Ym" countdown, correct empty state for an unused window).

### 9.4 New: Cowork usage tracking
The user asked for chat and Cowork usage to be counted, not just Claude
Code. Checked the actual `/api/oauth/usage` response shape (using the local
machine's real token, printing only the response — never the token) before
building anything:
- **Chat was already counted.** `five_hour`/`seven_day` are a **shared
  pool** across claude.ai chat and Claude Code under the same login — chat
  usage already moved these numbers before this change. Nothing to fix
  here; relabeled the weekly row "Weekly · Chat + Code" so that's explicit
  in the UI instead of implicit.
- **Cowork was the real gap.** The response has a distinct
  `seven_day_cowork` field — Claude Cowork has its **own separate** weekly
  allowance, not folded into `seven_day`. (Response also has several other
  null/codenamed fields — `seven_day_opus`, `seven_day_oauth_apps`,
  `tangelo`, `nimbus_quill`, etc. — that appear to be other experiments or
  per-model breakdowns; out of scope, not surfaced.)
- There is **no way to separate "chat-only" from "Code-only"** usage via
  this API — it's genuinely one blended number. A 3-way Chat/Code/Cowork
  breakdown isn't possible; what's implemented is 2-way: **Chat+Code
  (combined, as it always was)** and **Cowork (new, separate)**.

Both `windows/claude-usage-poll.js` and `windows/panel/renderer.js` thread
`seven_day_cowork` through end-to-end. Since most accounts won't have used
Cowork yet, the panel treats `null` there as a distinct, non-alarming
**"not used this week"** state — different from the "no data yet" state
used for `five_hour`/`seven_day`, which normally does have data and a null
there means something's actually wrong (not logged in, cache stale, etc.).

### 9.5 Real installer (electron-builder + NSIS)

The original setup (npm install + `register-tasks.ps1`) mirrored the
macOS project's own style — manual, script-driven, never a signed
installer. Asked directly why there wasn't a real installable app: no hard
blocker, just hadn't been built. Added one.

**Packaging: electron-builder → NSIS.** `windows/panel/package.json` gained
a `build` config (`appId`, `win.target: nsis`, icon) and an
`electron-builder` devDependency. `npm run dist` produces
`windows/panel/dist/Claude Usage Setup <version>.exe` (~95MB, bundles
Electron itself — end users need no Node.js). Chose
`nsis.perMachine: false` deliberately: a per-user install to
`%LOCALAPPDATA%\Programs\Claude Usage` needs **no Administrator rights**,
consistent with every other design choice in this project (Task Scheduler
registration, credential reads) already avoiding elevation.

**It's unsigned — confirmed, not hypothetical.** Checked with
`Get-AuthenticodeSignature` on the built exe: `NotSigned`. Windows
SmartScreen will show "Windows protected your PC" on first run; documented
the "More info → Run anyway" click-through in SETUP.md. Real code signing
needs a paid certificate, out of scope here.

**electron-builder's own dependency tree had a critical `node-tar`
advisory** (`npm audit` after first install: 12 vulnerabilities, 1
critical). This is *build-time* tooling only — not shipped inside the
packaged app — but the fix was free (bump `electron-builder` to `^26.15.3`)
so took it; `npm audit` came back clean after.

**Self-poll refactor — the more important change.** Previously the poller
was a wholly separate process (`claude-usage-poll.js`, driven by its own
Scheduled Task) from the panel. For an installed app, running two separate
auto-started processes to do what's really one job is unnecessary
complexity. Extracted the poll logic into `windows/panel/poller.js`
(exports `pollOnce()`); `main.js` now calls it immediately on startup and
every 2 minutes via `setInterval` — the installed app is fully
self-contained, no second Scheduled Task required.
`windows/claude-usage-poll.js` still exists as a thin shim
(`require('./panel/poller').pollOnce()`) purely for Option B (manual/dev,
no-installer) users who want a standalone one-off poll invocable from their
own scheduler — **one source of truth**, not two copies of the same logic.
`register-tasks.ps1` was simplified to match: it now only registers
`ClaudeUsagePanel` (the redundant `ClaudeUsagePoll` task was removed
entirely, both from the script and the docs).

**Auto-start: registry Run key, not Task Scheduler, for the installed app.**
Electron has a built-in cross-platform API for this —
`app.setLoginItemSettings({ openAtLogin, name })` — which on Windows writes
`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`. Used it instead of
having the NSIS installer register a Scheduled Task, since it's the
idiomatic Electron approach and gives a natural place for a user-facing
toggle: added a **"Start with Windows"** checkbox to the tray menu. On
first launch of a *packaged* build only (`app.isPackaged`, gated so `npm
start` in dev doesn't silently add a startup entry on a developer's
machine), it defaults the toggle on and remembers that it already did so
(`panel-state.json` → `autoLaunchInitialized`) so it won't re-force it back
on if the user turns it off later.

**Uninstall has to clean up that registry key manually.** The Windows
uninstaller doesn't run the app's own JS, so `setLoginItemSettings` never
gets a chance to unset itself. Added `windows/panel/installer.nsh` with a
`customUnInstall` NSIS macro (electron-builder's supported hook point) that
directly deletes the `"Claude Usage"` value from the Run key. The literal
string has to stay in sync by hand with `AUTOLAUNCH_NAME` in `main.js` —
no dynamic way to share it between JS and the NSIS script.

**Icon.** Neither electron-builder nor Windows will take a `.png` for the
app/installer icon — needs `.ico`. Extended the existing hand-rolled PNG
encoder (`assets/make-icon.js`, originally just for the tray dot, built
because no external asset/library was available) to also wrap a 256x256 PNG
in a minimal ICO container (modern ICO format allows embedding PNG data
directly — no need to hand-encode legacy BMP/DIB pixel data). Verified the
result was a real, non-corrupt icon via `nativeImage.createFromPath` before
trusting it to the NSIS build (`isEmpty: false, size: 256x256`) — cheap
insurance against a bad icon silently breaking the packaging step.

**Verification stopped short of installing.** Confirmed the installer
builds successfully and is a well-formed, correctly-sized PE executable,
but deliberately did **not** run/install it onto the live machine (that
would add real Start Menu entries, a registry Run key, and a persistent
background process) without being asked first — consistent with the same
judgment call already made for `register-tasks.ps1`.

### 9.6 "Real-time sync" fix

After installing, the user compared the panel against claude.ai's own
Settings → Usage page side by side (screenshot: panel showed Session 91% /
resets in 0h40m, claude.ai showed 92% / 39 min — both taken within the same
minute) and reported the panel wasn't syncing in real time.

**Not actually broken — just slow.** The gap was exactly what a 2-minute
poll interval would produce: up to ~2 minutes of staleness, visible as a
1% drift on an actively-climbing session. There was no dead timer, no
frozen cache, no silent failure — the poll loop was firing on schedule the
whole time. Confirmed this before changing anything, since "looks stale"
and "is stale" have different fixes.

**What actually changed:**
- `POLL_INTERVAL_MS` dropped from 2 minutes to **30 seconds** — the API
  call is a single lightweight authenticated GET against the user's own
  account, so a tighter interval doesn't meaningfully add load.
- Added a **manual refresh path**: `poll-now` IPC handler in `main.js` →
  `pollOnce()` immediately → pushes a `force-refresh` event to the
  renderer, so the UI updates the instant the fetch completes instead of
  waiting for its own polling loop to notice. Wired to a new ↻ button in
  the panel header (`index.html`/`styles.css`/`renderer.js`) and a
  "Refresh now" tray menu item — deliberately mirroring the manual refresh
  icon already present on claude.ai's own Usage page (visible in the same
  screenshot), since that's evidently the interaction model the user
  already expects.
- Every poll — scheduled or manual — now goes through one wrapper,
  `pollAndNotify()`, which pushes `force-refresh` after every call. The
  renderer's own polling loop (previously 15s) is now just a 5s safety net
  in case a push is ever missed, not the primary update path.

**Verified with a real click-through test**, not just code review: a
throwaway script loaded the actual `index.html`/`renderer.js`, simulated a
real click on `#refreshBtn` via `executeJavaScript`, and confirmed the
cache file's `updated` timestamp advanced *between* the click and the next
scheduled interval tick (i.e. the click alone triggered a fresh API call,
not a coincidental scheduled one) — then captured the panel's own window
content before/after to confirm the UI re-rendered. Rebuilt
`Claude Usage Setup 1.0.0.exe` afterward — the previously-built installer
predates this fix and should not be used.

### 9.7 Theme, close button, single-instance fix, drag-anywhere, 5s polling

Five follow-up requests in one batch, applied together and rebuilt once at
the end.

**Dark/Light theme.** Refactored `styles.css` to route every color through
CSS custom properties (`--panel-bg-rgb`, `--text-color`, `--track-bg`,
`--hover-bg`, `--close-hover-bg`) instead of hardcoded dark-only values
(`#fff`, `rgba(255,255,255,...)`), gated by a `data-theme` attribute on
`<html>`. Added a **Theme** submenu to the tray (Dark/Light radio items,
same pattern as the existing Transparency submenu), persisted in
`panel-state.json`, pushed to the renderer via a `theme` IPC event —
mirrors how transparency already worked, so no new plumbing pattern.
Defaults to Dark (unchanged behavior for anyone already using it).

**X close button.** Added a `×` button to the panel header next to the
existing ↻ refresh button (renamed the shared style to `.icon-btn` so both
buttons share hover/sizing rules, with `.close-btn` adding a red-tinted
hover). Wired to a new `hide-panel` IPC message → `win.hide()` — same
"hide to tray, don't quit" behavior the window already had for its native
close event (Alt+F4 etc.), just now reachable without right-clicking the
tray icon. Quit is still tray-menu-only, so accidentally clicking × can't
kill the background poller.

**Duplicate windows on relaunch — real bug, now fixed.** The app never
called `app.requestSingleInstanceLock()`, so double-clicking the Start Menu
shortcut (or the installer's shortcut, or just launching it twice) spawned
a second, fully independent process: second tray icon, second window,
second poll loop hitting the API on its own schedule. Fixed with the
standard Electron pattern — `requestSingleInstanceLock()` at the very top
of `main.js`, before any other `app`/window/tray setup; if the lock isn't
obtained, `app.quit()` and a top-level `return` stop the rest of the file
from executing in that (second) process. The *first* process listens for
`'second-instance'` and shows+focuses its existing window instead.
**Verified concretely**, not just by reading the code: launched the real
built app twice in a row and watched `Get-Process electron` — process count
stayed at 4 (one app's main + renderer + GPU + utility processes) after the
second launch attempt, instead of doubling to 8.

**Drag from anywhere.** Previously only the "Claude Usage" header text had
`-webkit-app-region: drag`; the rest of the panel (bars, rows) wasn't
draggable, which is a small but real usability paper cut for a floating
overlay you reposition often. Moved the drag region to `.panel` itself
(the whole window), and rely on `.icon-btn`'s existing
`-webkit-app-region: no-drag` so the two header buttons stay clickable —
Chromium lets children override an ancestor's app-region, so this needed
no other changes.

**Poll interval: 30s → 5s.** Straightforward constant change
(`POLL_INTERVAL_MS`). Worth noting for anyone tuning this later: at 5s this
is roughly 17,000 requests/day against `/api/oauth/usage` for as long as
the app runs — harmless for a single personal-use token hitting an
authenticated endpoint (worst case on a hiccup is a swallowed error and
stale-but-not-wrong cached numbers, per the existing error handling in
`poller.js`), but a poor default to ship broadly without a user explicitly
asking for it, which is why this stayed at 30s until asked.

**Build hiccup, not a code bug:** the first rebuild attempt after these
changes failed twice with `EPERM: operation not permitted, rename
...win-unpacked.tmp -> ...win-unpacked` — a known flaky
electron-builder-on-Windows failure mode (something, most likely Defender's
real-time scan, briefly holds a lock on the freshly-extracted Electron
files at the exact moment electron-builder tries to rename the temp
extraction folder into place). Deleting `dist/` and retrying succeeded
immediately with no code changes, confirming it wasn't caused by anything
in this changeset. Recurred more stubbornly in section 9.8's rebuild (5
failures in a row) — a manual `Rename-Item` on the leftover `.tmp` folder
right after a failure succeeded instantly every time, confirming the lock
really is that short-lived; a plain retry loop (`rm -rf dist && npm run
dist`, repeat) eventually got through. No permanent fix applied — Defender
exclusions would need admin rights and weren't pursued for a
single-developer machine.

### 9.8 Right-click showing Windows' system menu instead of the app menu

The drag-anywhere change (9.7) had a side effect on Windows: right-clicking
*anywhere* on the panel popped the native `Restore / Move / Size /
Minimize / Maximize / Close` system menu instead of nothing (or the app's
own menu) — screenshotted by the user mid-report.

**Root cause:** Chromium implements `-webkit-app-region: drag` on Windows
by answering `WM_NCHITTEST` with `HTCAPTION` for that screen area — i.e.
the OS genuinely believes that region *is* a title bar. Windows' window
manager handles right-clicks on `HTCAPTION` by showing the system menu,
same as right-clicking any app's title bar. This was already true for the
small header-only drag region before 9.7; it just went unnoticed until the
whole panel became draggable and right-clicks anywhere started triggering
it.

**Fix:** Electron ships an event specifically for this —
`win.on('system-context-menu', (event) => {...})`, confirmed by checking
`node_modules/electron/electron.d.ts` directly rather than trusting memory
(`@platform win32,linux`, fires right before the native menu would show).
Added a handler in `createWindow()` that calls `event.preventDefault()`
and pops the app's own menu (`buildMenu().popup({ window: win })`) at the
click location instead — so right-clicking the panel now gets you Theme /
Transparency / Start with Windows / Quit, not a native window-management
menu that mostly doesn't make sense for a borderless overlay anyway.
Required a small refactor: `rebuildTrayMenu()`'s inline
`Menu.buildFromTemplate(...)` became a standalone `buildMenu()` returning
the `Menu`, callable both from the tray (`tray.setContextMenu`) and from
this new handler (`.popup()`) instead of being tray-only.

**Verified against the real running app, not just by reading the code** —
and it took two tries to verify correctly, which is itself worth recording.
Simulating a real OS-level right-click needs actual `SetCursorPos` +
`mouse_event` (a synthetic DOM `contextmenu` event doesn't reach the native
`WM_NCHITTEST` path this bug lives in). First attempt used
`panel-state.json`'s saved `x`/`y` directly as screen coordinates and found
nothing at that location — this machine runs at 125% Windows display
scaling, and Electron reports window bounds in DIP (logical/CSS) pixels
while `SetCursorPos` takes physical pixels, so the click landed off-panel.
Recomputed with the 1.25 scale factor and the click landed correctly: the
native system menu no longer appeared. Also re-confirmed (same lesson as the very first panel screenshot earlier
in this project) that a screenshot of the region around the panel isn't a
safe verification method here — the
panel's semi-transparent background let an unrelated window's content
(browser tab with business content) bleed through in the capture. Deleted
those screenshots immediately and finished verifying via the process log
(no errors) instead of further screen capture.

### 9.10 Feature & visual redesign — Cowork → Credits, "refined minimal"

Before publishing publicly, went through `superpowers:brainstorming`
properly (one question at a time, 2-3 options with trade-offs, design
presented for approval before any code changed) rather than jumping
straight to implementation. Full spec:
`docs/superpowers/specs/2026-08-13-widget-redesign-design.md`.

**Feature change:** dropped Cowork tracking (the user doesn't use it, and
the row always just read "not used this week" — not worth a permanent
slot in a 3-row minimal panel) and added **usage credits** instead, backed
by `resp.spend` from the same endpoint (`used`/`limit` minor-unit amounts
+ a ready-made `percent`) — more universally relevant since every paid
plan can hit it, and mirrors the "$X spent" block already on claude.ai's
own Usage settings page. Verified the live shape
(`spend.used.amount_minor: 1284, exponent: 2` → `$12.84`) against that
same page before wiring it up — matched exactly, including the 43%.

**Visual redesign — "refined minimal":** chosen over a denser
"compact stat strip" alternative; user picked the evolutionary option.
Replaced literal traffic-light red/yellow/green with a muted palette
(sage `#8AAE8D` low, amber `#DDA15E` mid, coral `#D97757` high — the coral
is the same hue as the tray icon, so "at your limit" ties back to the
app's own identity rather than a generic alarm color). Row labels became
small uppercase letter-spaced secondary text; percentage values became
the visual focus (larger, semibold, `tabular-nums` so digits don't shift
width live). Bars: 10px pill-shaped with an inset-shadow track and a
subtle gradient sheen on the fill (via a `::after` overlay, so `renderer.js`
still only sets a plain color and doesn't need to compute per-tier
gradients). Container: hairline border (keeps it legible over arbitrary
desktop backgrounds), larger corner radius, more generous padding.

Loaded `frontend-design:frontend-design` for this pass, but adapted it
substantially — that skill is calibrated for marketing/landing pages (hero
sections, display/body font pairing, scroll narratives), none of which
apply to a 260px status HUD. Kept the transferable principles (avoid the
"default AI-generated" clustering, spend the one deliberate risk in a
single place — here, the brand-tied coral — and keep everything else
quiet) and discarded the rest.

**Verification:** confirmed the new `credits` field against a fresh direct
API call before wiring it into `poller.js`, then rendered the actual
`index.html`/`renderer.js`/`styles.css` (both themes, plus synthetic data
for the coral ≥80% state and both empty-state messages) via
`capturePage()` on the app's own offscreen window — never the desktop.
Rebuilt the installer and refreshed the shareable package + its README
(which still described the old Cowork row) afterward.

### 9.11 Two more real bugs, found from screenshots, plus a 4th-line dust-up

**Native square shadow showing through rounded corners.** At high
transparency, a faint squared-off edge was visible around the panel's
rounded card. Cause: Windows draws its own rectangular drop-shadow behind
frameless transparent windows unless told not to — `BrowserWindow`'s
`hasShadow` option (confirmed real via `electron.d.ts`, default `true`)
was never set. Fixed with `hasShadow: false`, relying purely on the CSS
`box-shadow` on `.panel` instead. Not something `capturePage()` could have
caught — it only captures the web content, not OS-compositor-drawn
window chrome around it, so this genuinely needed a real screenshot to
surface.

**Dead blank space when a row collapses to its empty state.** The
window's height was whatever got saved from a previous size (dragged, or
sized for a taller layout), and `.panel` had `min-height: 100vh`, so it
always stretched to fill that fixed window regardless of how much content
was actually in it. When Credits had no data, the row shrank but the
window didn't, leaving a visible gap. Fixed by making the window follow
content instead of the other way around: removed `min-height: 100vh` so
`.panel`'s height is purely intrinsic, added a `ResizeObserver` in
`renderer.js` that reports the measured height to `main.js` via a new
`content-height` IPC message on every change, and `main.js` calls
`win.setSize()` to match (anchored at the window's current top-left, so it
grows/shrinks from the bottom rather than jumping). Verified with a
deliberately-oversized 500px starting window: it settled to 340px with
real data, and correctly shrank further when a row was made to collapse.

**The 4th-line back-and-forth.** User wanted a 4th line for "overall
credit left." First guess (dollars remaining) was rejected as redundant —
it's just inverse math of the Credits row. Second ask, after a screenshot
of claude.ai's Billing page, turned out to mean the account's actual
**current credit balance** (`$60.69`, distinct from the `$30` monthly
spend limit already tracked). Checked the live API response directly:
`spend.balance` is `null` for this account — that number isn't exposed by
`/api/oauth/usage` at all. Had the user search their own authenticated
Network tab for it (safe, since it's their own session, versus this app
guessing at undocumented endpoints) — filtered Fetch/XHR, searched
`60.69`, `60.68` (and the minor-unit integer forms `6069`/`6068`, since
every other dollar amount this API returns is cents-as-integer, not a
decimal — established all the way back in section 9.4), and `balance`.
None matched anything captured across a full page reload. Conclusion:
that figure is very likely embedded directly in the page's initial
HTML/document payload (e.g. Next.js-style embedded state) rather than
fetched via a separate call the DevTools Network tab would show — chasing
it further would mean reverse-engineering page-embedded state, real
diminishing returns for one line in a minimal panel. Dropped, per the
user's own call once presented with the dead end.

**What shipped instead:** a computed "closest limit" headline —
`Closest limit: Session · 58%` — taking the max of whichever of the 3
rows have data. Real, reliable information ("what's actually going to
stop me first") built entirely from data this app already has, instead of
chasing a number it may never be able to reach.

### 9.12 Same-looking bug, different cause: startup flash at a stale size

User reported "the same issue" from two screenshots of the identical poll
(same %, same reset times) — one clipped (missing the Credits row, no
rounded bottom corner), one complete. Same symptom family as 9.11's dead
space, but a different root cause: 9.11 fixed the window *following*
content size; this was about *when* the window is allowed to become
visible in the first place.

`createWindow()` called `win.once('ready-to-show', () => win.show())` —
that event fires as soon as the page can paint *something*, which can
easily be before the async `getAccounts()` IPC round trip resolves and
the real 3-row content (and therefore its real height) exists in the DOM.
The window could flash briefly at whatever size it happened to start with
(a stale saved height from `panel-state.json`, possibly from a much
earlier, shorter layout) before the first `content-height` report resized
it — exactly a "screenshot caught it mid-flash" bug, consistent with the
user's two screenshots being the same data at two different rendering
moments.

**Fix:** removed the `ready-to-show` handler entirely. The window now
stays `show: false` until the *first* `content-height` IPC report comes
in from the renderer's `ResizeObserver` — at that point it's already been
resized to match real content, then shown. Used an explicit `hasShownOnce`
one-shot flag rather than checking `win.isVisible()` for this — the X
button also makes the window not-visible, and a later poll's
`content-height` report must NOT un-hide something the user deliberately
closed.

**Verified concretely**, not just by reasoning about event ordering:
started a test window at a deliberately-stale 80px height (simulating an
old saved size for a 1-row layout), sampled `isVisible()` + current size
every 5ms throughout the whole load sequence, and confirmed the window
was visible zero times at the stale size — it only became visible already
at the correct ~310px. Rebuilt the installer and shareable package
afterward.

### 9.13 Three more from one round of screenshots: resize clipping, shadow clipping, headline redundancy

**Manual resize fighting content-driven auto-sizing.** User tried
dragging the window shorter (apparently to avoid seeing the Credits row)
and got flat, clipped-looking corners instead. Cause: once window height
is driven by content (9.11), nothing stopped the user from *also*
dragging it — drag shorter than content needs, and the card doesn't
shrink, it just gets clipped by the window's hard edge, with the real
rounded bottom corner sitting off-screen below the visible bounds. Fixed
by locking height instead of just correcting it after the fact:
`content-height`'s handler now also calls
`win.setMinimumSize(200, target)` / `win.setMaximumSize(4000, target)` —
min height == max height == target locks height exactly, while width
stays freely resizable. Verified by programmatically forcing a resize to
60px and confirming the OS-level constraint snapped it back to the
content-driven height (332px) rather than accepting the smaller size.

**Shadow clipped into a hard line at the top edge.** Once the window was
sized to exactly match `.panel`'s own box (9.11), the `box-shadow: 0 12px
40px rgba(0,0,0,0.4)` — which renders *beyond* that box — had nowhere to
fade into; the window's hard edge cut it off mid-falloff, which reads as
a stray dark line hugging the top corners rather than a soft shadow.
Fixed by giving it room: added `padding: 28px 0` to `<body>` specifically
so the shadow has space to render, and changed the `ResizeObserver` in
`renderer.js` to measure `document.body` instead of `.panel` directly, so
the window's height includes that padding rather than just the card's own
box. Verified visually via `capturePage()` — the shadow now fades cleanly
around the whole card instead of terminating in a hard edge.

**Headline redundant with the row directly below it.** User pointed out
"Closest limit: Session" duplicates the Session row immediately under it
— fair, since Session's short 5h window makes it the tightest constraint
most of the time anyway, so the headline was usually just restating the
obvious. Changed `closestLimit()` in `renderer.js` to return `null` (hide
the headline) when Session is the answer, only surfacing it when Weekly
or Credits turns out to be the actual bottleneck — the case where it's
telling you something the 3 rows alone wouldn't make obvious at a glance.
Verified with synthetic data for both cases: no headline when Session is
highest, `"Closest limit: Credits · 91%"` shown when Credits is highest.

Rebuilt the installer and shareable package after all three.

### 9.14 Shadow overcorrected, real "hide a row" feature, account-switching myth

**Shadow went from clipped to a heavy blob.** 9.13's fix (giving the
shadow room via body padding) worked, but nothing shrank the shadow
itself to match — a `0 12px 40px` shadow with 28px of room to render into
just showed its full size, reading as a dark smudge rather than a subtle
lift. Dialed both down together: shadow to `0 3px 10px rgba(0,0,0,0.22)`,
body padding to `10px 0` — small shadow, small room, proportionate.

**Row visibility was a real missing feature, not a bug.** Earlier
(9.13), a user attempt to hide the Credits row via window-resizing was
diagnosed and fixed as a *bug* (clipping). This time the ask was explicit:
a real way to hide rows, so nothing needs to be worked around. Added a
**Show** submenu to the tray menu (`main.js`) — three independent
checkboxes (Session / Weekly / Credits), same state-backed +
IPC-pushed pattern as Theme/Transparency (`visibleRows` in
`panel-state.json`, `visible-rows` IPC event, `get-visible-rows` handler).
`renderer.js` conditionally emits each row based on this state, and the
closest-limit headline (9.13) now also filters candidates by visibility —
referencing a metric in the headline that's been turned off elsewhere
would be confusing, not informative. Verified with a real toggle: window
correctly shrank from 3 rows to Session-only, no leftover space (the
9.11/9.13 auto-resize machinery just works for this automatically, since
it reacts to `<body>`'s actual measured height regardless of *why* it
changed).

**"Add/switch account" was never a button, on either platform.** User
asked for account add/switch UI, believing the macOS version had it.
Re-checked section 5 of these notes (written when the macOS files were
first read, before any Windows work started) to confirm rather than
answer from memory: it never existed there either — Keychain (and,
on Windows, the credentials file) can only hold one logged-in account's
token at a time, so "switching accounts" always meant logging out/in
inside Claude Code itself, with the poller passively noticing the new
token and starting a second cache file. The Windows port already carries
this same passive multi-account rendering (`main.js`'s `get-accounts`
reads every file in the accounts cache dir; `renderer.js` already shows
an account-name header once there's more than one) — there was nothing
to add. Flagged clearly to the user rather than either (a) silently
building a fictional "Add Account" button that never existed on the
platform being replicated, or (b) assuming the passive behavior is what
they actually want without checking — genuinely tracking two accounts
*simultaneously* without switching Claude Code's login would need storing
multiple tokens, which the original macOS notes explicitly scoped out as
future work, not a regression.

### 9.15 Account management, properly brainstormed — and scoped down on purpose

User pushed back on 9.14's answer and asked for real Add/Remove/Log-out
account management, explicitly invoking `superpowers:brainstorming` rather
than having it built ad hoc. Full spec:
`docs/superpowers/specs/2026-08-13-account-visibility-design.md`.

Walked through it properly: first question forced the real fork — does
"Add account" mean guiding the user through Claude Code's own login
(cheap, no new auth code) or the app performing its own independent
sign-in (lets multiple accounts be tracked without ever switching Claude
Code's login, but is a real build)? User picked independent sign-in.

**Raised a concern before designing further, rather than proceeding on the
stated preference alone:** everything built in this project so far is
read-only — it reads a token Claude Code *already* obtained through its
own legitimate login, purely to check usage. An independent sign-in flow
is categorically different: the app would be *initiating* fresh
authentication against Anthropic's OAuth infrastructure on its own, for
potentially several accounts — closer to behaving like an unofficial
client authenticating on the user's behalf than a helper reading data an
official client already fetched. Proposed a middle ground instead
("snapshot + self-refresh": capture a token the user obtained via Claude
Code's real login, refresh it ourselves afterward using its refresh
token — still never performs a login itself).

User then asked how the original macOS version actually handled this,
which was answered by quoting section 5 of these notes verbatim rather
than re-explaining from memory — confirmed there was never any sign-in UI
on macOS either, and true simultaneous multi-account tracking was
explicitly noted there as *not implemented*, for the same reason (would
need persisting tokens). With that context, the user chose to keep the
existing passive mechanism entirely as-is and scoped the actual ask down
to: **always show which account (and plan) is being tracked**, not just
once a second account exists.

**Implementation:** `renderer.js`'s `.account-name` line now always
renders (was gated behind `accounts.length > 1`), and now includes the
plan — sourced from `%USERPROFILE%\.claude.json`'s
`oauthAccount.organizationType`, confirmed present locally
(`"claude_pro"`) before use, formatted generically (`split('_')` +
title-case) rather than a hardcoded lookup table so unseen plan types
(`claude_max`, etc.) degrade reasonably instead of showing raw
`snake_case`. Verified the formatter against the confirmed real value plus
two hypothetical ones, and rendered the actual panel with synthetic
single-account data to confirm the identity line now shows unconditionally
(`"Shubham Sinha · Claude Pro"`).

The throughline worth remembering: when a user's stated preference (full
independent sign-in) carries a real, newly-surfaced risk the earlier
turns hadn't required considering, raising that concern *before* building
— and offering a concrete safer alternative — is what brainstorming is
for. It led here to a smaller, safer feature that fully satisfied the
underlying need once the actual mechanics and history were laid out
plainly instead of assumed.

### 9.9 "818m ago" staleness after an overnight sleep

User reported the panel stuck at old numbers with an "⚠ updated 818m ago"
badge. Checked the live cache file directly before touching any code: it
was 0 minutes old with correct current numbers — so the poller was
*already* working again by the time this was investigated. The 818-minute
figure (~13.6h) lines up with the process having been running since the
previous day and the machine most likely having been asleep overnight.

**Diagnosis, not just guesswork:** `POLL_INTERVAL_MS` drives a plain
`setInterval(pollAndNotify, ...)` (main.js) with no wake-from-sleep
handling. JS timers do not fire while Windows is fully suspended — that's
expected OS behavior for any app, not specific to this one. `setInterval`
does resume on its own once the system wakes (confirmed: cache was fresh
by the time this was checked), but that leaves a window right after wake
where the panel still shows an hours-stale reading until the next natural
tick.

**Fix:** added `powerMonitor.on('resume', () => pollAndNotify())` and
`powerMonitor.on('unlock-screen', () => pollAndNotify())` in main.js —
confirmed both are real Electron events (checked `electron.d.ts` directly)
before using them. Forces an immediate poll the moment the system wakes or
unlocks, instead of waiting out however much of `POLL_INTERVAL_MS` is left.
Rebuilt the installer and refreshed the shareable package.

Same requirement as every previous fix: the four already-running `Claude
Usage.exe` processes (main + renderer + GPU + utility, running since
before this fix) won't pick this up until quit and relaunched from the new
build — single-instance lock means simply running the new installer while
the old process is still up won't replace what's actually executing in
memory.
