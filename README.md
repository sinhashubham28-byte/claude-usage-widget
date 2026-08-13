# Claude Usage

A small floating panel that shows your Claude Pro/Max usage at a glance —
session, weekly, and usage credits — sitting on top of your other windows
so you never have to open a settings page to check.

```
┌─────────────────────────────┐
│  Claude Usage           ↻ × │
│  Name · Claude Pro           │
│                               │
│  SESSION                 71% │
│  ▬▬▬▬▬▬▬▬▬▬▬▬▬▬░░░░░░░░░░░░ │
│  resets in 3h 8m             │
│                               │
│  WEEKLY                  59% │
│  ▬▬▬▬▬▬▬▬▬▬░░░░░░░░░░░░░░░░ │
│  resets in 65h 28m           │
│                               │
│  CREDITS                 43% │
│  ▬▬▬▬▬▬▬░░░░░░░░░░░░░░░░░░░ │
│  $12.84 of $30                │
└─────────────────────────────┘
```

## How it works

Both platforms read the same local login Claude Code already has on your
machine — you never enter credentials into this app, and nothing is sent
anywhere except Anthropic's own usage-check endpoint (the same one Claude
Code itself calls).

- **macOS** — a native Swift/AppKit panel, polled by a background
  launchd agent. See [`macos/SETUP.md`](macos/SETUP.md).
- **Windows** — an Electron app that's fully self-contained (polls
  itself, no separate background task). See
  [`windows/SETUP.md`](windows/SETUP.md) to run from source, or grab the
  installer from [Releases](../../releases) for a one-click setup.

## Requirements

- A paid Claude plan (Pro/Max/Team) — free accounts can't authenticate to
  Claude Code, so there's no local login for this to read.
- Claude Code already installed and logged in on the machine you're
  running this on.

## Project layout

- [`macos/`](macos/) — the macOS build (Swift/AppKit panel + shell
  scripts + [`macos/SETUP.md`](macos/SETUP.md))
- [`windows/`](windows/) — the Windows build (Electron app in
  `windows/panel/`, dev-only scripts in `windows/dev/`, and
  [`windows/SETUP.md`](windows/SETUP.md))

## License

MIT — see [`LICENSE`](LICENSE).
