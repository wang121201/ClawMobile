#!/data/data/com.termux/files/usr/bin/bash
set -eu

service_dir="${1:?service directory required}"
mkdir -p "$service_dir"
termux-wake-lock >/dev/null 2>&1 || true

if pgrep -f 'glibc/lib openclaw *$' >/dev/null 2>&1; then
  exit 41
fi

setsid -f env \
  CLAW_MOBILE_NOTIFY_VIBRATE=0 \
  CLAW_MOBILE_NOTIFY_TOAST=0 \
  ANDROID_SERIAL='127.0.0.1:5555' \
  DROIDRUN_SERIAL='127.0.0.1:5555' \
  TMPDIR="$PREFIX/tmp" \
  openclaw gateway --bind loopback --port 18789 --verbose \
  < /dev/null \
  > "$service_dir/gateway.stdout.log" 2>&1

for _ in $(seq 1 180); do
  if curl -fsS --max-time 2 http://127.0.0.1:18789/healthz >/dev/null 2>&1 && \
     curl -fsS --max-time 2 http://127.0.0.1:8765/health >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

curl -fsS --max-time 5 http://127.0.0.1:18789/healthz >/dev/null
curl -fsS --max-time 5 http://127.0.0.1:8765/health >/dev/null
{
  printf 'started_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  pgrep -af 'glibc/lib openclaw *$'
} > "$service_dir/service-start.txt"
