#!/bin/bash
# Claude Code statusline script.
# - Prints a normal statusline (model + 5h/7d usage %) to Claude Code's TUI.
# - Snapshots the raw rate_limits JSON to disk so a desktop widget can display
#   it outside the terminal.
# - Also writes a PER-ACCOUNT snapshot keyed by the logged-in account's email,
#   so a multi-account widget can show every account it has ever seen (the
#   active one live, the others as last-known). Account identity comes from
#   ~/.claude.json since the statusline payload itself carries no account info.

input=$(cat)

CACHE_DIR="$HOME/.cache/claude-usage"
ACCT_DIR="$CACHE_DIR/accounts"
mkdir -p "$ACCT_DIR"

# Full payload + timestamp (kept for backwards compatibility / debugging).
echo "$input" > "$CACHE_DIR/latest.json"
NOW=$(date +%s)
echo "$NOW" > "$CACHE_DIR/last_updated.txt"

# ---- per-account snapshot ----
CLAUDE_JSON="$HOME/.claude.json"
if [ -f "$CLAUDE_JSON" ]; then
  EMAIL=$(jq -r '.oauthAccount.emailAddress // empty' "$CLAUDE_JSON" 2>/dev/null)
  NAME=$(jq -r '.oauthAccount.displayName // .oauthAccount.emailAddress // empty' "$CLAUDE_JSON" 2>/dev/null)
  ORG=$(jq -r '.oauthAccount.organizationName // empty' "$CLAUDE_JSON" 2>/dev/null)

  if [ -n "$EMAIL" ]; then
    # Sanitize email into a safe filename.
    SAFE=$(echo "$EMAIL" | tr '@/ .' '____')
    echo "$input" | jq \
      --arg name "$NAME" --arg org "$ORG" --arg email "$EMAIL" \
      --argjson ts "$NOW" \
      '{rate_limits: (.rate_limits // {}), account: {name: $name, org: $org, email: $email}, updated: $ts}' \
      > "$ACCT_DIR/$SAFE.json" 2>/dev/null
  fi
fi

# ---- normal statusline output below ----
MODEL=$(echo "$input" | jq -r '.model.display_name')
FIVE_H=$(echo "$input" | jq -r '.rate_limits.five_hour.used_percentage // empty')
WEEK=$(echo "$input" | jq -r '.rate_limits.seven_day.used_percentage // empty')

LIMITS=""
[ -n "$FIVE_H" ] && LIMITS="5h: $(printf '%.0f' "$FIVE_H")%"
[ -n "$WEEK" ] && LIMITS="${LIMITS:+$LIMITS }7d: $(printf '%.0f' "$WEEK")%"

if [ -n "$LIMITS" ]; then
  echo "[$MODEL] | $LIMITS"
else
  echo "[$MODEL]"
fi
