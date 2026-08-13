// Claude Usage floating panel — Windows/Electron port of the macOS
// Swift/AppKit panel. Always-on-top, draggable, frameless, tray-only (no
// taskbar entry). Self-polls via poller.js on an interval and reads back
// the per-account cache files it writes.
//
// Note: this does NOT implement true "blur what's behind the window"
// (macOS's NSVisualEffectView / Windows' DWM Acrylic) — Chromium's
// backdrop-filter can't see real desktop pixels behind a transparent
// frameless window. The panel instead uses a solid semi-transparent
// background with adjustable alpha (see the Transparency tray menu).
// True Acrylic would need a native addon (e.g. electron-acrylic-window);
// left as a possible follow-up, not implemented here.

const { app, BrowserWindow, Tray, Menu, ipcMain, screen, nativeImage, powerMonitor } = require('electron');
const fs = require('fs');
const path = require('path');
const { pollOnce, CACHE_DIR, ACCT_DIR } = require('./poller');

// Only one panel should ever run at once — launching the app again (e.g.
// double-clicking the Start Menu shortcut while it's already running)
// should focus the existing window, not spawn a second tray icon + window.
// Must happen before anything else touches app/tray/window state.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  return;
}

const STATE_FILE = path.join(CACHE_DIR, 'panel-state.json');
const AUTOLAUNCH_NAME = 'Claude Usage';
// A 5s interval was tried and empirically got the usage endpoint to start
// returning 429s (confirmed live: manual "Refresh now" clicks were also
// being rejected, which is why the panel looked frozen even after several
// clicks). 30s is the same cadence the mac poller has used from the start
// without issue. On a 429, scheduledPoll() below doubles this up to a cap
// instead of retrying at the same rate and prolonging the rate limit.
const POLL_INTERVAL_MS = 30 * 1000;
const MAX_BACKOFF_MS = 5 * 60 * 1000;

const TRANSPARENCY_PRESETS = [
  { label: 'Opaque', value: 0.92 },
  { label: 'High', value: 0.75 },
  { label: 'Medium', value: 0.55 },
  { label: 'Low', value: 0.35 },
  { label: 'Minimal', value: 0.15 },
];

const ROW_KEYS = [
  { key: 'session', label: 'Session' },
  { key: 'weekly', label: 'Weekly' },
  { key: 'credits', label: 'Credits' },
];

let win;
let tray;

app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveState(partial) {
  const state = { ...loadState(), ...partial };
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state));
}

function createWindow() {
  const state = loadState();
  const work = screen.getPrimaryDisplay().workArea;
  const width = state.width || 260;
  const height = state.height || 260;
  const x = state.x != null ? state.x : work.x + work.width - width - 20;
  const y = state.y != null ? state.y : work.y + 20;

  win = new BrowserWindow({
    width,
    height,
    x,
    y,
    frame: false,
    transparent: true,
    // Without this, Windows draws its own rectangular drop-shadow behind
    // frameless transparent windows regardless of CSS border-radius — at
    // high panel transparency that native square shadow shows through as
    // a visible squared-off edge around our rounded corners. The CSS
    // box-shadow on .panel replaces it.
    hasShadow: false,
    resizable: true,
    minWidth: 200,
    minHeight: 100,
    skipTaskbar: true,
    show: false,
    icon: path.join(__dirname, 'assets', 'app-icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  try {
    win.setVisibleOnAllWorkspaces(true, { visibleOnAllWorkspaces: true });
  } catch {
    // best-effort — not all Windows/Electron combinations support this
  }

  win.loadFile(path.join(__dirname, 'index.html'));
  // Deliberately NOT win.show() on 'ready-to-show' — that fires as soon as
  // the page can paint, which can be before the async getAccounts() IPC
  // round trip resolves and the real 3-row content (and its real height)
  // is in the DOM. Showing then risked a brief flash at whatever stale
  // size the window happened to have. Instead, first-show is triggered by
  // the 'content-height' handler below, once the renderer has reported an
  // actual measured height and the window has been sized to match.

  win.on('moved', () => {
    const b = win.getBounds();
    saveState({ x: b.x, y: b.y });
  });
  win.on('resized', () => {
    const b = win.getBounds();
    saveState({ width: b.width, height: b.height });
  });
  win.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });

  // Right-clicking anywhere in a `-webkit-app-region: drag` area (the whole
  // panel, now that it's draggable from anywhere) gets hit-tested by
  // Windows as if it were a title bar, which pops the native
  // Restore/Move/Size/Minimize/Maximize/Close system menu — not our app's
  // menu. Suppress that and show our actual menu (Theme, Transparency,
  // etc.) at the click point instead.
  win.on('system-context-menu', (event) => {
    event.preventDefault();
    buildMenu().popup({ window: win });
  });
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray-icon.png'));
  tray = new Tray(icon.resize({ width: 16, height: 16 }));
  tray.setToolTip('Claude Usage');
  rebuildTrayMenu();
  tray.on('click', () => {
    if (win.isVisible()) win.focus();
    else win.show();
  });
}

function buildMenu() {
  const state = loadState();
  const current = state.transparencyAlpha ?? 0.75;
  const currentTheme = state.theme ?? 'dark';
  const visibleRows = state.visibleRows || {};
  return Menu.buildFromTemplate([
    { label: win && win.isVisible() ? 'Hide panel' : 'Show panel', click: () => (win.isVisible() ? win.hide() : win.show()) },
    { label: 'Refresh now', click: () => pollAndNotify() },
    { type: 'separator' },
    {
      label: 'Show',
      submenu: ROW_KEYS.map((r) => ({
        label: r.label,
        type: 'checkbox',
        checked: visibleRows[r.key] !== false,
        click: (item) => {
          const updated = { ...visibleRows, [r.key]: item.checked };
          saveState({ visibleRows: updated });
          win.webContents.send('visible-rows', updated);
          rebuildTrayMenu();
        },
      })),
    },
    {
      label: 'Theme',
      submenu: [
        {
          label: 'Dark',
          type: 'radio',
          checked: currentTheme === 'dark',
          click: () => {
            saveState({ theme: 'dark' });
            win.webContents.send('theme', 'dark');
            rebuildTrayMenu();
          },
        },
        {
          label: 'Light',
          type: 'radio',
          checked: currentTheme === 'light',
          click: () => {
            saveState({ theme: 'light' });
            win.webContents.send('theme', 'light');
            rebuildTrayMenu();
          },
        },
      ],
    },
    {
      label: 'Transparency',
      submenu: TRANSPARENCY_PRESETS.map((p) => ({
        label: p.label,
        type: 'radio',
        checked: current === p.value,
        click: () => {
          saveState({ transparencyAlpha: p.value });
          win.webContents.send('transparency', p.value);
          rebuildTrayMenu();
        },
      })),
    },
    { type: 'separator' },
    {
      label: 'Start with Windows',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => {
        app.setLoginItemSettings({ openAtLogin: item.checked, name: AUTOLAUNCH_NAME });
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    },
  ]);
}

function rebuildTrayMenu() {
  tray.setContextMenu(buildMenu());
}

ipcMain.handle('get-accounts', () => {
  let files;
  try {
    files = fs.readdirSync(ACCT_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  return files
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(ACCT_DIR, f), 'utf8'));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
});

ipcMain.handle('get-transparency', () => loadState().transparencyAlpha ?? 0.75);
ipcMain.handle('get-theme', () => loadState().theme ?? 'dark');
ipcMain.handle('get-visible-rows', () => loadState().visibleRows || {});

// The panel's own X button — hides to tray, same as closing most tray
// apps' windows does. Does not quit (that's still Quit in the tray menu).
ipcMain.on('hide-panel', () => win && win.hide());

// The window's saved height was whatever it happened to be last (e.g.
// resized to fit 3 rows), not necessarily what the CURRENT content needs
// — a row collapsing to its empty state left dead space at the bottom of
// the card since .panel used to be forced to fill the whole fixed window
// height. The renderer measures its actual rendered height (ResizeObserver
// on .panel) and reports it here on every render; keep the window's
// height matched to it so there's never leftover blank space or clipped
// content. Anchored at the window's current top-left, so it grows/shrinks
// from the bottom — the top edge (where the user dragged it) doesn't move.
let hasShownOnce = false;
ipcMain.on('content-height', (_event, contentHeight) => {
  if (!win) return;
  const [width, currentHeight] = win.getSize();
  const target = Math.max(100, Math.ceil(contentHeight));
  if (Math.abs(currentHeight - target) > 1) {
    win.setSize(width, target);
  }
  // Lock height to exactly what content needs (min == max == target) but
  // leave width free — otherwise dragging the window shorter than its
  // content just clips the card against the window's hard edge instead of
  // the card actually shrinking, which is what produced the flat-looking
  // corners: the real rounded bottom was still there, just below the
  // visible window bounds.
  win.setMinimumSize(200, target);
  win.setMaximumSize(4000, target);
  // First real measurement after launch: this is when the window is
  // actually ready to be seen (see the comment on 'ready-to-show' above).
  // A one-shot flag, not win.isVisible() — the user hiding the panel via
  // the X button also makes it not visible, and the next poll's
  // content-height report should NOT un-hide something they deliberately
  // closed.
  if (!hasShownOnce) {
    hasShownOnce = true;
    win.show();
  }
});

// Wraps pollOnce() so every poll — scheduled or manually triggered — pushes
// the renderer an update immediately, instead of the renderer having to
// wait out its own polling interval to notice new data on disk. Returns
// pollOnce()'s status so the scheduler below can react to it.
async function pollAndNotify() {
  const status = await pollOnce();
  if (win && !win.isDestroyed()) win.webContents.send('force-refresh');
  return status;
}

ipcMain.handle('poll-now', () => pollAndNotify());

// Self-rescheduling poll loop (setTimeout, not setInterval) so the delay
// before the NEXT poll can depend on how the current one went. On a 429
// the delay doubles (capped at MAX_BACKOFF_MS) instead of hammering the
// endpoint again at the same cadence and prolonging the rate limit; any
// non-429 result resets it back to the normal cadence.
let backoffMs = POLL_INTERVAL_MS;
async function scheduledPoll() {
  const status = await pollAndNotify();
  backoffMs = status === 'rate-limited' ? Math.min(backoffMs * 2, MAX_BACKOFF_MS) : POLL_INTERVAL_MS;
  setTimeout(scheduledPoll, backoffMs);
}

app.whenReady().then(() => {
  createWindow();
  createTray();

  // Self-contained polling: the installed app needs no separate Scheduled
  // Task for this (unlike the manual/dev setup — see ../claude-usage-poll.js).
  scheduledPoll();

  // Timers don't fire while Windows is fully suspended (sleep / hibernate)
  // — nothing can poll during that window, same as any app. Once the
  // system wakes, the loop above resumes on its own, but that can still
  // leave the panel showing a stale reading for a few seconds right after
  // waking. Force an immediate poll on resume/unlock, and reset any
  // accumulated backoff — sleep is a natural cooldown for a rate limit
  // that may well have cleared by the time the system wakes back up.
  powerMonitor.on('resume', () => {
    backoffMs = POLL_INTERVAL_MS;
    pollAndNotify();
  });
  powerMonitor.on('unlock-screen', () => {
    backoffMs = POLL_INTERVAL_MS;
    pollAndNotify();
  });

  // First launch of a real install: default to starting at login, matching
  // "auto-starts at login" from the original design. Only do this once —
  // respect the user's choice afterwards even if they turn it back off.
  // Skipped in dev (unpacked) runs so `npm start` doesn't add a startup
  // entry on a developer's machine.
  if (app.isPackaged) {
    const state = loadState();
    if (!state.autoLaunchInitialized) {
      app.setLoginItemSettings({ openAtLogin: true, name: AUTOLAUNCH_NAME });
      saveState({ autoLaunchInitialized: true });
    }
  }
});

app.on('window-all-closed', (e) => e.preventDefault());
