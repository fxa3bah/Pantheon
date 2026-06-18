#!/usr/bin/env bash
#
# pantheon-setup.sh -- guided setup + live walkthrough for Pantheon.
#
# What it does, in order:
#   1. Checks Node.js and the three agent CLIs (claude, grok, codex).
#   2. For anything missing, shows the official install command + link (it does
#      NOT silently install software for you).
#   3. Confirms each CLI is logged in (OAuth), and points you to the login step
#      if not.
#   4. Wires up the Pantheon plugins (Claude marketplace + Grok reverse leg).
#   5. Runs a LIVE walkthrough so you watch each agent actually answer.
#
# Safe to re-run. It never reads an API key. It asks before changing anything.
#
# Usage:
#   ./pantheon-setup.sh            # interactive
#   ./pantheon-setup.sh --yes      # assume "yes" to wiring prompts
#   ./pantheon-setup.sh --no-live  # skip the live walkthrough (no agent calls)
#
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ASSUME_YES=0
RUN_LIVE=1
for arg in "$@"; do
  case "$arg" in
    --yes|-y) ASSUME_YES=1 ;;
    --no-live) RUN_LIVE=0 ;;
    -h|--help) grep '^#' "$0" | sed 's/^#//'; exit 0 ;;
  esac
done

# --- pretty output -----------------------------------------------------------
if [ -t 1 ]; then
  B=$'\033[1m'; DIM=$'\033[2m'; R=$'\033[0m'
  GRN=$'\033[32m'; YLW=$'\033[33m'; RED=$'\033[31m'; CYN=$'\033[36m'
else
  B=""; DIM=""; R=""; GRN=""; YLW=""; RED=""; CYN=""
fi
say()  { printf "%s\n" "$*"; }
step() { printf "\n%s== %s ==%s\n" "$B$CYN" "$*" "$R"; }
ok()   { printf "  %s[ ok ]%s %s\n" "$GRN" "$R" "$*"; }
warn() { printf "  %s[warn]%s %s\n" "$YLW" "$R" "$*"; }
bad()  { printf "  %s[miss]%s %s\n" "$RED" "$R" "$*"; }
ask()  {
  [ "$ASSUME_YES" = "1" ] && return 0
  printf "  %s? %s [y/N] %s" "$B" "$*" "$R"; read -r a </dev/tty
  [[ "$a" =~ ^[Yy] ]]
}

have() { command -v "$1" >/dev/null 2>&1; }
# Resolve a CLI from PATH or a known fallback location.
resolve() {
  local name="$1"; shift
  if have "$name"; then command -v "$name"; return 0; fi
  for p in "$@"; do [ -x "$p" ] && { echo "$p"; return 0; }; done
  return 1
}

printf "%s" "$B"
cat <<'BANNER'
  ____             _   _
 |  _ \ __ _ _ __ | |_| |__   ___  ___  _ __
 | |_) / _` | '_ \| __| '_ \ / _ \/ _ \| '_ \
 |  __/ (_| | | | | |_| | | |  __/ (_) | | | |
 |_|   \__,_|_| |_|\__|_| |_|\___|\___/|_| |_|
 local OAuth-only delegation mesh: Claude + Grok + Codex
BANNER
printf "%s" "$R"
say "${DIM}repo: $ROOT${R}"

MISSING=0

# --- 1. Node -----------------------------------------------------------------
step "1/5  Node.js"
if have node; then
  NODE_V="$(node -p 'process.versions.node')"
  NODE_MAJOR="${NODE_V%%.*}"; NODE_MINOR="$(echo "$NODE_V" | cut -d. -f2)"
  if [ "$NODE_MAJOR" -gt 18 ] || { [ "$NODE_MAJOR" -eq 18 ] && [ "$NODE_MINOR" -ge 18 ]; }; then
    ok "node $NODE_V"
  else
    warn "node $NODE_V is too old (need >= 18.18). Update via https://nodejs.org or nvm."
    MISSING=1
  fi
else
  bad "node not found. Install from https://nodejs.org (or use nvm)."
  MISSING=1
fi

# --- 2. Agent CLIs -----------------------------------------------------------
step "2/5  Agent CLIs"
CLAUDE_BIN="$(resolve claude "$HOME/.local/bin/claude" "$HOME/.claude/bin/claude" || true)"
GROK_BIN="$(resolve grok "$HOME/.grok/bin/grok" || true)"
CODEX_BIN="$(resolve codex "/Applications/Codex.app/Contents/Resources/codex" "$HOME/.local/bin/codex" || true)"

if [ -n "$CLAUDE_BIN" ]; then ok "claude  -> $CLAUDE_BIN"
else bad "claude not found. Install: ${B}npm install -g @anthropic-ai/claude-code${R}  (docs: https://docs.claude.com/claude-code)"; MISSING=1; fi

if [ -n "$GROK_BIN" ]; then ok "grok    -> $GROK_BIN"
else bad "grok not found. See the xAI Grok CLI docs: https://docs.x.ai  (this is the image/video engine)"; MISSING=1; fi

if [ -n "$CODEX_BIN" ]; then ok "codex   -> $CODEX_BIN"
else warn "codex not found (optional). Install: ${B}npm install -g @openai/codex${R}  (docs: https://developers.openai.com/codex)"; fi

say ""
say "  ${DIM}Pantheon never asks for an API key. Each CLI uses its own normal login.${R}"
say "  ${DIM}To log in, just run the CLI once and follow its prompt:${R}"
[ -n "$CLAUDE_BIN" ] && say "    claude        ${DIM}# then complete the in-terminal/browser login${R}"
[ -n "$GROK_BIN" ]   && say "    grok          ${DIM}# same: log in once${R}"
[ -n "$CODEX_BIN" ]  && say "    codex login   ${DIM}# if you want the Codex legs${R}"

if [ "$MISSING" = "1" ]; then
  say ""
  warn "Install/upgrade the required tools above, log in, then re-run this script."
  say "  ${DIM}(You can continue, but wiring and the live walkthrough need at least Claude + Grok.)${R}"
fi

# --- 3. Wire up the plugins --------------------------------------------------
step "3/5  Wire up Pantheon"
if [ -n "$CLAUDE_BIN" ]; then
  if ask "Register the Pantheon marketplace and install the Claude plugin?"; then
    "$CLAUDE_BIN" plugin marketplace add "$ROOT" 2>&1 | sed 's/^/    /'
    "$CLAUDE_BIN" plugin install grok@pantheon 2>&1 | sed 's/^/    /'
    ok "Claude side wired. Restart Claude Code so /grok-* commands load."
  else
    say "  ${DIM}Skipped. Manual: claude plugin marketplace add \"$ROOT\" && claude plugin install grok@pantheon${R}"
  fi
else
  warn "Skipping Claude wiring (claude not found)."
fi

if [ -n "$GROK_BIN" ]; then
  if ask "Install the Grok-side reverse leg (claude-delegate skills/agent)?"; then
    "$GROK_BIN" plugin install "$ROOT" --trust 2>&1 | sed 's/^/    /'
    ok "Grok side wired."
  else
    say "  ${DIM}Skipped. Manual: grok plugin install \"$ROOT\" --trust${R}"
  fi
else
  warn "Skipping Grok wiring (grok not found)."
fi

# --- 4. Live walkthrough -----------------------------------------------------
step "4/5  Live walkthrough"
if [ "$RUN_LIVE" = "0" ]; then
  warn "Skipped (--no-live)."
elif [ -z "$CLAUDE_BIN" ] && [ -z "$GROK_BIN" ]; then
  warn "Need at least one agent logged in to run a live check."
else
  say "  Asking each available agent to answer a live challenge (it must compute 6 x 7)."
  say "  ${DIM}This spawns each real CLI once, under your normal login. A pass means the agent truly replied.${R}"
  say ""
  HEALTH_JSON="$(node "$ROOT/plugins/grok/scripts/grok-companion.mjs" health --json --live 2>/dev/null)"
  printf "%s" "$HEALTH_JSON" | node -e '
    const T=process.stdout.isTTY;
    const c=(code,s)=>T?("\x1b["+code+"m"+s+"\x1b[0m"):s;
    let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
      let r; try { r=JSON.parse(s) } catch(e){ console.log("  could not parse health output"); process.exit(0) }
      const order=["claude-to-grok","grok-to-claude","grok-to-codex","codex-to-grok","codex-to-claude","claude-to-codex"];
      for(const k of order){
        const v=(r.live||{})[k]; if(!v) continue;
        const label=k.replace("-to-"," -> ").padEnd(20);
        if(v.skipped){ console.log("  "+c("2","[skip]")+" "+label+"(that CLI not installed)"); continue; }
        if(v.ok){ console.log("  "+c("32","[live]")+" "+label+"replied "+c("1",v.expected)+" ok"); }
        else { console.log("  "+c("31","[fail]")+" "+label+"no valid reply (logged in?)"); }
      }
      console.log("");
      console.log(r.ok ? "  "+c("32","All available directions are live.")
                       : "  "+c("33","Some directions did not pass -- see above."));
    });
  '
fi

# --- 5. Next steps -----------------------------------------------------------
step "5/5  Try it yourself"
cat <<EOF
  In Claude Code (after restarting it):

    ${B}/grok:setup${R}                              ${DIM}# confirm Grok is reachable${R}
    ${B}/grok:health --live${R}                      ${DIM}# the same live check, from inside Claude${R}
    ${B}/grok-imagine a folded linen napkin on marble, soft window light, 3:2${R}
    ${B}/grok:result${R}                             ${DIM}# get the file:// link + markdown${R}

  From a Grok session (reverse leg):

    ${B}claude-delegate summarize the README of this repo${R}   ${DIM}# read-only by default${R}

  Full guide: ${B}$ROOT/README.md${R}
EOF
say ""
ok "Pantheon setup complete."
