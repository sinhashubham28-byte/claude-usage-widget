#!/bin/bash
# Claude Usage poller — statusline-independent.
#
# Fetches the currently-logged-in Claude account's subscription usage directly
# from the same endpoint Claude Code uses, so the widget works in ANY IDE
# (Cursor, PyCharm, terminal) and even while Claude Code is idle.
#
# Auth: reads the OAuth access token from the macOS Keychain item
#       "Claude Code-credentials" (the token Claude Code itself stores/refreshes).
# Identity: reads display name / org / email from ~/.claude.json.
# Output: writes ~/.cache/claude-usage/accounts/<email>.json in the shape the
#         floating panel already reads (used_percentage + unix resets_at).
#
# Only the currently-logged-in account can be polled (one token in the Keychain
# at a time). When you switch accounts in Claude Code the token changes, so this
# then tracks the other account; each account's last-known numbers are retained.

CACHE_DIR="$HOME/.cache/claude-usage"
ACCT_DIR="$CACHE_DIR/accounts"
mkdir -p "$ACCT_DIR"

# --- token from Keychain ---
CRED=$(security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null)
TOKEN=$(echo "$CRED" | jq -r '.claudeAiOauth.accessToken // empty' 2>/dev/null)
[ -z "$TOKEN" ] && exit 0

# --- account identity ---
CLAUDE_JSON="$HOME/.claude.json"
EMAIL=$(jq -r '.oauthAccount.emailAddress // empty' "$CLAUDE_JSON" 2>/dev/null)
NAME=$(jq -r '.oauthAccount.displayName // .oauthAccount.emailAddress // empty' "$CLAUDE_JSON" 2>/dev/null)
ORG=$(jq -r '.oauthAccount.organizationName // empty' "$CLAUDE_JSON" 2>/dev/null)
[ -z "$EMAIL" ] && exit 0

# --- fetch usage ---
RESP=$(curl -s -m 15 \
  -H "Authorization: Bearer $TOKEN" \
  -H "anthropic-beta: oauth-2025-04-20" \
  -H "User-Agent: claude-cli/2.1.217" \
  "https://api.anthropic.com/api/oauth/usage" 2>/dev/null)

# If the response isn't valid usage data (expired token, offline, mid-account-
# switch, etc.), keep the last-known file rather than clobbering it.
# NOTE: check for non-null VALUES, not just key presence — during an account
# switch the endpoint can return {"five_hour": null, "seven_day": null}, which
# `has()` would happily accept and overwrite good data with nulls.
echo "$RESP" | jq -e '(.five_hour.utilization != null) or (.seven_day.utilization != null)' \
  >/dev/null 2>&1 || exit 0

NOW=$(date +%s)
SAFE=$(echo "$EMAIL" | tr '@/ .' '____')

echo "$RESP" | jq \
  --arg name "$NAME" --arg org "$ORG" --arg email "$EMAIL" --argjson ts "$NOW" '
  def toepoch: if . == null then null
               else (sub("\\.[0-9]+";"") | sub("\\+00:00";"Z") | fromdateiso8601) end;
  {
    rate_limits: {
      five_hour: (if .five_hour then {used_percentage: .five_hour.utilization,
                                      resets_at: (.five_hour.resets_at|toepoch)} else null end),
      seven_day: (if .seven_day then {used_percentage: .seven_day.utilization,
                                      resets_at: (.seven_day.resets_at|toepoch)} else null end)
    },
    account: {name: $name, org: $org, email: $email},
    updated: $ts
  }' > "$ACCT_DIR/$SAFE.json.tmp" 2>/dev/null \
  && mv "$ACCT_DIR/$SAFE.json.tmp" "$ACCT_DIR/$SAFE.json"
