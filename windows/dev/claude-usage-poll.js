#!/usr/bin/env node
// Standalone CLI entry for the manual/dev setup (SETUP.md "Option B" —
// driven by a Scheduled Task). The installed app (from the Windows
// installer) does not need this: it self-polls on an interval in its own
// process. Both paths share the same logic in ../panel/poller.js so
// there's one source of truth.
require('../panel/poller')
  .pollOnce()
  .catch(() => {
    // Swallow errors so a bad cycle doesn't spam Task Scheduler with
    // failures; the last-known-good cache file is left untouched.
  });
