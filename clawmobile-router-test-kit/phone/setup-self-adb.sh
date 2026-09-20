#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
umask 077

if [ "$#" -ne 3 ]; then
  printf 'Usage: %s <pairing-port> <six-digit-code> <debug-port>\n' "$0" >&2
  exit 2
fi
pair_port=$1
pair_code=$2
debug_port=$3
case "$pair_port:$debug_port" in
  *[!0-9:]*|:*|*:) printf 'Ports must be decimal integers.\n' >&2; exit 3 ;;
esac
case "$pair_code" in
  ??????) ;;
  *) printf 'Pair code must contain exactly six characters.\n' >&2; exit 4 ;;
esac

adb pair "127.0.0.1:$pair_port" "$pair_code"
adb connect "127.0.0.1:$debug_port"
adb -s "127.0.0.1:$debug_port" get-state | grep -qx device

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
site_file=${CLAWMOBILE_PHONE_SITE:-"$repo_root/phone/phone-site.json"}
SITE_FILE="$site_file" NEW_SERIAL="127.0.0.1:$debug_port" python - <<'PY'
import json
import os
from pathlib import Path

path = Path(os.environ["SITE_FILE"])
value = json.loads(path.read_text(encoding="utf-8"))
value["adb"]["serial"] = os.environ["NEW_SERIAL"]
temporary = path.with_name(path.name + ".adb-update.tmp")
descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
try:
    payload = (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    os.write(descriptor, payload)
    os.fsync(descriptor)
finally:
    os.close(descriptor)
json.loads(temporary.read_text(encoding="utf-8"))
os.replace(temporary, path)
PY

printf 'Self-ADB is healthy; phone-site serial updated to 127.0.0.1:%s\n' "$debug_port"
