# Account visibility — design decision

Status: decided, implemented.

## Context

User asked for a full account management section: Add / Remove / Log out,
believing the original macOS version had this. It didn't — confirmed
against section 5 of `BUILD_NOTES.md` (written when the macOS files were
first read, before any Windows work started), not from memory. Neither
platform has ever had independent authentication; the app has only ever
read whatever single OAuth token Claude Code itself already stored
locally after its own official login.

## Options considered

1. **Independent sign-in flow** — the app performs its own OAuth login
   (PKCE, browser redirect, its own token storage/refresh) so multiple
   accounts can be added without touching Claude Code's login at all.
   Initially requested. **Rejected.** This is a different risk category
   than anything built so far: everything to date is read-only, using a
   token the user already obtained through Claude Code's own legitimate
   login. An independent sign-in flow means the app itself *initiates*
   fresh authentication against Anthropic's OAuth infrastructure — closer
   to building an unofficial client than a helper that reads data an
   official client already fetched. Flagged this directly rather than
   building it.
2. **Snapshot + self-refresh** — "Add current account" captures whatever
   token Claude Code currently has (obtained via its real login) into our
   own storage, and we refresh it ourselves afterward using its refresh
   token, so it keeps updating even after Claude Code switches to a
   different account. Proposed as a safer middle ground. Not pursued
   further — once the actual mechanics of the original passive behavior
   were explained, the user chose to just improve visibility on what
   already exists instead.
3. **Keep the existing passive mechanism, improve visibility (chosen).**
   No new authentication code. Multi-account display already worked
   exactly as macOS did: log Claude Code into a different account, the
   poller notices the new token and starts a second cache file, the panel
   shows both (the active one live, the other frozen with a staleness
   badge). The actual gap the user hit was narrower than "no account
   management" — it was that with only *one* account, there was no
   indication anywhere of which account was even being tracked, since the
   identity line only rendered when 2+ accounts existed
   (`showHeader = accounts.length > 1` in the old `renderer.js`).

## Decision

Keep the passive multi-account mechanism as-is — no Add/Remove/Log-out UI,
no independent authentication. Fix the actual visibility gap instead:

- The account identity line (`renderAccount`'s `.account-name`) now always
  renders, regardless of account count.
- Extended it to include the plan (e.g. "Shubham Sinha · Claude Pro"),
  sourced from `%USERPROFILE%\.claude.json`'s
  `oauthAccount.organizationType` — confirmed present locally
  (`organizationType: "claude_pro"`) before wiring it up, formatted
  generically (`claude_pro` → `Claude Pro`) rather than a hardcoded lookup
  table, so it degrades reasonably for plan types not seen yet
  (`claude_max` → `Claude Max`, etc.) instead of needing a maintained map.

## Why this is enough

The underlying need — "show me which account and plan I'm looking at" —
is fully met without adding authentication surface area the project has
deliberately avoided everywhere else. If genuine simultaneous multi-account
tracking (without switching Claude Code's login back and forth) becomes a
real need later, option 2 (snapshot + self-refresh) is the safer starting
point — it still never performs a fresh login itself, only reuses tokens
the user already legitimately obtained.
