#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
umask 077

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repo_root"

site_file=${CLAWMOBILE_PHONE_SITE:-"$repo_root/phone/phone-site.json"}
env_file=${CLAWMOBILE_PHONE_ENV:-"$repo_root/phone/phone.env"}
if [ -f "$HOME/.bashrc" ]; then
  # Existing Phone 62 stores the credential as a shell variable in .bashrc.
  # Source it explicitly because non-interactive launchers do not do so.
  set +u
  # shellcheck disable=SC1090
  . "$HOME/.bashrc"
  set -u
  if [ -n "${freeinference_api:-}" ]; then
    export freeinference_api
  fi
fi
if [ -f "$env_file" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$env_file"
  set +a
fi

case "${1:-}" in
  configure)
    shift
    exec python -m phone_controller.configure_phone --site "$site_file" "$@"
    ;;
  doctor|services|run)
    exec python -m phone_controller.campaign --site "$site_file" "$@"
    ;;
  *)
    printf 'Usage:\n' >&2
    printf '  ./phone/run.sh configure\n' >&2
    printf '  ./phone/run.sh services start|stop-proxy|stop-gateway\n' >&2
    printf '  ./phone/run.sh doctor\n' >&2
    printf '  ./phone/run.sh run --stage Smoke|Formal --config <router-*.json> ...\n' >&2
    exit 2
    ;;
esac
