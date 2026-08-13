// Canonical poll logic — reads the local Claude Code credentials, calls the
// usage API, and writes the per-account cache file the panel reads.
//
// Used two ways:
//   1. Called on an interval by the installed app's main process (main.js) —
//      the packaged app is self-contained and needs no separate scheduler.
//   2. Called once by ../claude-usage-poll.js — the standalone CLI entry
//      kept for the manual/dev setup (SETUP.md "Option B"), typically
//      driven by a Scheduled Task for people who don't want to run the app
//      itself in the background.
//
// Auth: %USERPROFILE%\.claude\.credentials.json (plain file — Claude Code
//       does not use Windows Credential Manager here).
// Identity: %USERPROFILE%\.claude.json (.oauthAccount).
// Tracks three things: five_hour (session), seven_day (weekly — a SHARED
// pool across claude.ai chat and Claude Code under the same login), and
// credits (extra usage credits — resp.spend — that cover you once you hit
// a plan limit; not the same as Cowork, which was tracked here previously
// and got dropped as not universally relevant enough for a 3-row minimal
// panel — see docs/superpowers/specs/2026-08-13-widget-redesign-design.md).

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');

const CACHE_DIR = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'claude-usage');
const ACCT_DIR = path.join(CACHE_DIR, 'accounts');

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function toUnixSeconds(iso) {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

function safeFileName(email) {
  return email.replace(/[@/ .]/g, '_');
}

// "claude_pro" -> "Claude Pro". Generic on purpose — covers whatever
// organizationType values Anthropic uses (claude_max, claude_team, etc.)
// without needing a maintained lookup table.
function formatPlanName(organizationType) {
  if (!organizationType) return '';
  return organizationType
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function fetchUsage(token) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.anthropic.com',
        path: '/api/oauth/usage',
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          'anthropic-beta': 'oauth-2025-04-20',
          'User-Agent': 'claude-cli/2.1.217',
        },
        timeout: 15000,
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          if (res.statusCode === 429) {
            resolve({ rateLimited: true });
            return;
          }
          try {
            resolve({ data: JSON.parse(body) });
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

function windowOrNull(w) {
  if (!w || w.utilization == null) return null;
  return { used_percentage: w.utilization, resets_at: toUnixSeconds(w.resets_at) };
}

function creditsOrNull(spend) {
  if (!spend || !spend.enabled || !spend.used || !spend.limit) return null;
  const scale = (m) => m.amount_minor / 10 ** m.exponent;
  return {
    used_percentage: spend.percent,
    used_dollars: scale(spend.used),
    limit_dollars: scale(spend.limit),
    currency: spend.used.currency,
  };
}

// Returns a status string so callers (main.js's poll scheduler) can react
// differently to "rate limited" than to a normal successful/no-op cycle —
// specifically, back off instead of retrying at the same cadence and
// digging the hole deeper.
//   'ok'           — wrote a fresh cache file
//   'rate-limited' — HTTP 429 from the usage endpoint
//   'no-signal'    — parsed fine but had no usable data (e.g. mid
//                    account-switch); not the API's fault, don't back off
//   'error'        — not logged in, no token/email, network/parse failure
async function pollOnce() {
  fs.mkdirSync(ACCT_DIR, { recursive: true });

  const credPath = path.join(os.homedir(), '.claude', '.credentials.json');
  const cred = readJson(credPath);
  const token = cred && cred.claudeAiOauth && cred.claudeAiOauth.accessToken;
  if (!token) return 'error'; // not logged in / mid account-switch — nothing to do

  const claudeJson = readJson(path.join(os.homedir(), '.claude.json'));
  const account = (claudeJson && claudeJson.oauthAccount) || {};
  const email = account.emailAddress;
  if (!email) return 'error';
  const name = account.displayName || email;
  const org = account.organizationName || '';
  const plan = formatPlanName(account.organizationType);

  let result;
  try {
    result = await fetchUsage(token);
  } catch {
    return 'error'; // offline / expired token — keep last-known file, don't clobber
  }

  if (result.rateLimited) return 'rate-limited';
  const resp = result.data;

  // Guard against {"five_hour": null, "seven_day": null} mid-account-switch
  // responses: check non-null VALUES, not just key presence.
  const hasSignal =
    (resp.five_hour && resp.five_hour.utilization != null) ||
    (resp.seven_day && resp.seven_day.utilization != null);
  if (!hasSignal) return 'no-signal';

  const out = {
    rate_limits: {
      five_hour: windowOrNull(resp.five_hour),
      seven_day: windowOrNull(resp.seven_day),
      credits: creditsOrNull(resp.spend),
    },
    account: { name, org, email, plan },
    updated: Math.floor(Date.now() / 1000),
  };

  const file = path.join(ACCT_DIR, `${safeFileName(email)}.json`);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(out));
  fs.renameSync(tmp, file);
  return 'ok';
}

module.exports = { pollOnce, CACHE_DIR, ACCT_DIR };
