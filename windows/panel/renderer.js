// Muted status palette — replaces literal traffic-light red/yellow/green.
// High tier reuses the Anthropic coral already used for the tray icon, so
// "at your limit" reads as this app's own alert color, not a generic one.
const colorFor = (pct) => (pct >= 80 ? '#D97757' : pct >= 50 ? '#DDA15E' : '#8AAE8D');

function timeUntil(unixSeconds) {
  if (!unixSeconds) return '';
  const diffMs = unixSeconds * 1000 - Date.now();
  if (diffMs <= 0) return 'resetting…';
  const h = Math.floor(diffMs / 3600000);
  const m = Math.floor((diffMs % 3600000) / 60000);
  return `resets in ${h}h ${m}m`;
}

function formatDollars(n) {
  return Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`;
}

function row(label, pct, sub, emptyText, labelTitle) {
  const titleAttr = labelTitle ? ` title="${labelTitle}"` : '';
  if (pct == null) {
    return `
      <div class="row">
        <div class="row-top"><span class="row-label"${titleAttr}>${label}</span></div>
        <div class="row-empty">${emptyText}</div>
      </div>`;
  }
  const rounded = Math.round(pct);
  return `
    <div class="row">
      <div class="row-top"><span class="row-label"${titleAttr}>${label}</span><span class="row-value">${rounded}%</span></div>
      <div class="bar-track"><div class="bar-fill" style="width:${Math.min(rounded, 100)}%; background:${colorFor(rounded)}"></div></div>
      <div class="row-sub">${sub}</div>
    </div>`;
}

// "What's actually going to stop me first?" — a single headline computed
// from whichever of the 3 rows is highest, instead of a 4th row repeating
// numbers the other rows already show. (An earlier idea — a literal "$
// remaining" line, or the account's actual credit balance — got dropped:
// the balance figure isn't exposed by /api/oauth/usage at all, confirmed
// live, and isn't reachable through any XHR/fetch on claude.ai's own Usage
// page either, so it's likely embedded page state, not a real API value
// this app could read.)
//
// Only shown when the answer ISN'T Session: Session has by far the
// shortest window (5h vs. Weekly's 7d), so it's very often the tightest
// constraint just by nature of resetting so often — meaning the headline
// would usually just repeat the row directly below it. It's actually
// informative when Weekly or Credits turns out to be the real bottleneck
// instead, which is the case worth calling out. Only considers rows the
// user hasn't hidden — referencing a metric in the headline that's been
// turned off elsewhere would be confusing, not informative.
function closestLimit(rl, visibleRows) {
  const candidates = [
    { key: 'session', label: 'Session', pct: rl.five_hour?.used_percentage },
    { key: 'weekly', label: 'Weekly', pct: rl.seven_day?.used_percentage },
    { key: 'credits', label: 'Credits', pct: rl.credits?.used_percentage },
  ].filter((c) => c.pct != null && visibleRows[c.key] !== false);
  if (candidates.length === 0) return null;
  const max = candidates.reduce((m, c) => (c.pct > m.pct ? c : m));
  return max.label === 'Session' ? null : max;
}

function renderAccount(acc, visibleRows) {
  const rl = acc.rate_limits || {};
  const account = acc.account || {};
  const nameLabel = account.name || account.email;
  // Always shown — even with a single account, there was previously no
  // indication anywhere of which account was being tracked (it only
  // appeared once a second account existed). Plan is included since it's
  // already sitting in the locally-cached account data (.claude.json's
  // oauthAccount.organizationType) and answers "which plan's limits am I
  // even looking at" at a glance.
  const identityLine = [nameLabel, account.plan].filter(Boolean).join(' · ');
  const staleMins = acc.updated ? Math.floor(Date.now() / 1000 - acc.updated) / 60 : null;
  const staleLine =
    staleMins !== null && staleMins > 10
      ? `<div class="stale">⚠ updated ${Math.floor(staleMins)}m ago</div>`
      : '';

  const fiveHour = rl.five_hour;
  const sevenDay = rl.seven_day;
  const credits = rl.credits;
  const closest = closestLimit(rl, visibleRows);

  return `
    <div class="account-block">
      ${identityLine ? `<div class="account-name">${identityLine}</div>` : ''}
      ${closest ? `<div class="headline">Closest limit: <strong>${closest.label}</strong> · ${Math.round(closest.pct)}%</div>` : ''}
      ${visibleRows.session !== false ? row('Session', fiveHour?.used_percentage, timeUntil(fiveHour?.resets_at), 'no data yet — send a message in Claude Code') : ''}
      ${visibleRows.weekly !== false ? row('Weekly', sevenDay?.used_percentage, timeUntil(sevenDay?.resets_at), 'no data yet — send a message in Claude Code', 'Shared with claude.ai chat, not Claude Code alone') : ''}
      ${visibleRows.credits !== false ? row('Credits', credits?.used_percentage, credits ? `${formatDollars(credits.used_dollars)} of ${formatDollars(credits.limit_dollars)}` : '', 'usage credits not enabled') : ''}
      ${staleLine}
    </div>`;
}

let visibleRows = {};

async function refresh() {
  const accounts = await window.claudeUsage.getAccounts();
  const el = document.getElementById('accounts');
  if (!accounts || accounts.length === 0) {
    el.innerHTML = '<div class="empty-state">Waiting for Claude Code data&hellip;</div>';
    return;
  }
  el.innerHTML = accounts.map((acc) => renderAccount(acc, visibleRows)).join('');
}

window.claudeUsage.onTransparency((alpha) => {
  document.documentElement.style.setProperty('--bg-alpha', alpha);
});

window.claudeUsage.getTransparency().then((alpha) => {
  document.documentElement.style.setProperty('--bg-alpha', alpha);
});

window.claudeUsage.onTheme((theme) => {
  document.documentElement.setAttribute('data-theme', theme);
});

window.claudeUsage.getTheme().then((theme) => {
  document.documentElement.setAttribute('data-theme', theme);
});

window.claudeUsage.onVisibleRows((rows) => {
  visibleRows = rows;
  refresh();
});

window.claudeUsage.getVisibleRows().then((rows) => {
  visibleRows = rows;
  refresh();
});

// Pushed by main.js right after every poll (scheduled or manual) completes,
// so the UI updates immediately instead of waiting out its own interval.
window.claudeUsage.onForceRefresh(refresh);

const refreshBtn = document.getElementById('refreshBtn');
refreshBtn.addEventListener('click', async () => {
  refreshBtn.disabled = true;
  refreshBtn.classList.add('spinning');
  try {
    await window.claudeUsage.pollNow(); // triggers a force-refresh push on completion
  } finally {
    setTimeout(() => {
      refreshBtn.classList.remove('spinning');
      refreshBtn.disabled = false;
    }, 400);
  }
});

document.getElementById('closeBtn').addEventListener('click', () => {
  window.claudeUsage.hidePanel();
});

// Keeps the window sized to actual content instead of a stale fixed
// height — fires whenever body's natural height changes (rows collapsing
// to empty state, an account added/removed, font metrics loading, etc.).
// Measures <body>, not .panel directly — body's vertical padding (see
// styles.css) exists specifically to give .panel's box-shadow room to
// render, so the window needs to include that padding too, not just the
// card's own box.
let lastReportedHeight = 0;
new ResizeObserver(() => {
  const h = Math.ceil(document.body.getBoundingClientRect().height);
  if (h !== lastReportedHeight) {
    lastReportedHeight = h;
    window.claudeUsage.reportContentHeight(h);
  }
}).observe(document.body);

refresh();
setInterval(refresh, 5000); // safety net between poll pushes — just a local file read
