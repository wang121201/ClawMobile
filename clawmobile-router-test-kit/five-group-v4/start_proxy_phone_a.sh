#!/data/data/com.termux/files/usr/bin/bash
set -eu
umask 077

service_dir="${1:?service directory is required}"
capture_root="${2:?capture root is required}"
case "$capture_root" in
  /data/data/com.termux/files/home/clawmobile-experiments/*/active/captures) ;;
  *) printf 'unsupported capture root: %s\n' "$capture_root" >&2; exit 9 ;;
esac
mkdir -p "$service_dir"
mkdir -p "$capture_root"

router_token=$("$HOME/.openclaw-android/bin/node" -e 'const fs=require("fs");const c=JSON.parse(fs.readFileSync(process.env.HOME+"/.openclaw/openclaw.json","utf8"));const t=c.models.providers["clawmobile-router"].apiKey;if(typeof t!=="string"||Buffer.byteLength(t,"utf8")<32)process.exit(7);process.stdout.write(t)')

setsid env \
  -u CLAW_ROUTER_SESSION_ID \
  CLAW_ROUTER_CLIENT_TOKEN="$router_token" \
  CLAW_ROUTER_V4_ENABLED=1 \
  CLAW_ROUTER_CAPTURE_ROOT="$capture_root" \
  CLAW_ROUTER_PORT=18081 \
  CLAW_ROUTER_STRATEGY_TIMEOUT_MS=600000 \
  CLAW_ROUTER_ANSWER_TIMEOUT_MS=600000 \
  OPENCLAW_CONFIG_PATH="$HOME/.openclaw/openclaw.json" \
  "$HOME/.openclaw-android/bin/node" \
  "$HOME/ClawMobile/clawmobile-router-proxy/src/cli.js" \
  < /dev/null \
  > "$service_dir/proxy.stdout.log" \
  2> "$service_dir/proxy.stderr.log" &

unset router_token
for _ in $(seq 1 60); do
  /data/data/com.termux/files/usr/bin/curl -fsS --max-time 2 http://127.0.0.1:18081/health >/dev/null 2>&1 && break
  sleep 1
done
/data/data/com.termux/files/usr/bin/curl -fsS --max-time 5 http://127.0.0.1:18081/health >/dev/null
printf 'started_at=%s\nstrategy_timeout_ms=600000\nanswer_timeout_ms=600000\ncapture_root=%s\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$capture_root" > "$service_dir/service-start.txt"
pgrep -af '/ClawMobile/clawmobile-router-proxy/src/cli.js' >> "$service_dir/service-start.txt"
