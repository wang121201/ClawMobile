#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
umask 077

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repo_root"

if [ "${PREFIX:-}" != "/data/data/com.termux/files/usr" ]; then
  printf 'This installer must run inside native Termux.\n' >&2
  exit 2
fi

for command in bash curl git python adb pgrep setsid termux-wake-lock; do
  command -v "$command" >/dev/null 2>&1 || {
    printf 'Missing required Termux command: %s\n' "$command" >&2
    exit 3
  }
done

node_path="$HOME/.openclaw-android/bin/node"
[ -x "$node_path" ] || {
  printf 'Missing OpenClaw Android Node runtime: %s\n' "$node_path" >&2
  exit 4
}
command -v openclaw >/dev/null 2>&1 || {
  printf 'OpenClaw command is not installed.\n' >&2
  exit 5
}

if [ ! -f phone/phone-site.json ]; then
  cp -p phone/phone-site.example.json phone/phone-site.json
  printf 'Created private phone/phone-site.json; set site_id and current self-ADB serial.\n'
fi
if [ ! -f phone/phone.env ]; then
  cp -p phone/phone.env.example phone/phone.env
  printf 'Created private phone/phone.env; set freeinference_api before configure.\n'
fi

python -m unittest discover -s tests -p 'test_phone_*.py' -q
printf 'Offline phone-native tests passed.\n'
printf 'Next: edit phone/phone-site.json and phone/phone.env, then run:\n'
printf '  ./phone/run.sh configure\n'
printf '  ./phone/run.sh services start\n'
printf '  ./phone/run.sh doctor\n'
