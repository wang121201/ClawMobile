#!/usr/bin/env bash

set -u
set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

SERIAL="${SERIAL:-}"
HOST_PORT="${CLAWBENCH_HOST_PORT:-18765}"
PHONE_PORT="${CLAWBENCH_PHONE_PORT:-8765}"
TERMUX_ADB_SERVER_PORT="${CLAWBENCH_TERMUX_ADB_SERVER_PORT:-5037}"
CONDA_ENV="${CLAWBENCH_CONDA_ENV:-clawbench}"
RESULTS_DIR="${CLAWBENCH_RESULTS_DIR:-}"

PASS_COUNT=0
FAIL_COUNT=0
WARN_COUNT=0

usage() {
  cat <<'EOF'
Usage: scripts/check_environment.sh [options]

Validate the host and phone environment required for real-device ClawBench
runs. The script does not execute a benchmark task.

Options:
  --serial SERIAL     Android device serial. Defaults to $SERIAL or the only
                      online adb device.
  --host-port PORT    Host tunnel port. Default: 18765.
  --phone-port PORT   Phone ClawBench channel port. Default: 8765.
  --conda-env TARGET  Conda environment name or absolute prefix containing
                      Python and pytest. Default: clawbench.
  -h, --help          Show this help.

Environment overrides:
  SERIAL
  CLAWBENCH_HOST_PORT
  CLAWBENCH_PHONE_PORT
  CLAWBENCH_TERMUX_ADB_SERVER_PORT
  CLAWBENCH_CONDA_ENV
  CLAWBENCH_AGENT_BASE_URL
  CLAWBENCH_AGENT_TOKEN
  CLAWBENCH_RESULTS_DIR
EOF
}

pass() {
  PASS_COUNT=$((PASS_COUNT + 1))
  printf '[PASS] %s\n' "$1"
}

fail() {
  FAIL_COUNT=$((FAIL_COUNT + 1))
  printf '[FAIL] %s\n' "$1" >&2
}

warn() {
  WARN_COUNT=$((WARN_COUNT + 1))
  printf '[WARN] %s\n' "$1"
}

die_usage() {
  printf 'Error: %s\n\n' "$1" >&2
  usage >&2
  exit 2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --serial)
      [[ $# -ge 2 ]] || die_usage "--serial requires a value"
      SERIAL="$2"
      shift 2
      ;;
    --host-port)
      [[ $# -ge 2 ]] || die_usage "--host-port requires a value"
      HOST_PORT="$2"
      shift 2
      ;;
    --phone-port)
      [[ $# -ge 2 ]] || die_usage "--phone-port requires a value"
      PHONE_PORT="$2"
      shift 2
      ;;
    --conda-env)
      [[ $# -ge 2 ]] || die_usage "--conda-env requires a value"
      CONDA_ENV="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die_usage "unknown option: $1"
      ;;
  esac
done

for port_value in "$HOST_PORT" "$PHONE_PORT" "$TERMUX_ADB_SERVER_PORT"; do
  if ! [[ "$port_value" =~ ^[0-9]+$ ]] || ((port_value < 1 || port_value > 65535)); then
    die_usage "ports must be integers between 1 and 65535"
  fi
done

DEFAULT_AGENT_BASE_URL="http://127.0.0.1:$HOST_PORT"
AGENT_BASE_URL="${CLAWBENCH_AGENT_BASE_URL:-$DEFAULT_AGENT_BASE_URL}"
AGENT_BASE_URL="${AGENT_BASE_URL%/}"

CONDA_TARGET_ARGS=(-n "$CONDA_ENV")
if [[ "$CONDA_ENV" == /* || "${CONDA_ENV:1:1}" == ":" ]]; then
  CONDA_ENV="${CONDA_ENV//\\//}"
  CONDA_TARGET_ARGS=(--prefix "$CONDA_ENV")
fi

HEALTH_RESPONSE=""
HEALTH_STATUS=1
HEALTH_VALID=0

probe_health() {
  local health_url="$AGENT_BASE_URL/health"
  if [[ -n "${CLAWBENCH_AGENT_TOKEN:-}" ]]; then
    HEALTH_RESPONSE="$(curl --silent --show-error --max-time 10 \
      -H "Authorization: Bearer $CLAWBENCH_AGENT_TOKEN" "$health_url" 2>&1)"
  else
    HEALTH_RESPONSE="$(curl --silent --show-error --max-time 10 \
      "$health_url" 2>&1)"
  fi
  HEALTH_STATUS=$?
  local normalized_health
  normalized_health="$(printf '%s' "$HEALTH_RESPONSE" | tr -d '[:space:]')"
  HEALTH_VALID=0
  if [[ $HEALTH_STATUS -eq 0 && "$normalized_health" == *'"ok":true'* \
    && "$normalized_health" == *'"channel":"clawbench"'* ]]; then
    HEALTH_VALID=1
  fi
}

printf 'ClawBench environment check\n'
printf 'Project: %s\n\n' "$PROJECT_ROOT"

if command -v adb >/dev/null 2>&1; then
  pass "adb is available: $(command -v adb)"
else
  fail "adb is not available on PATH"
fi

if command -v curl >/dev/null 2>&1; then
  pass "curl is available: $(command -v curl)"
else
  fail "curl is not available on PATH"
fi

if command -v conda >/dev/null 2>&1; then
  pass "conda is available: $(command -v conda)"
else
  fail "conda is not available on PATH"
fi

if command -v adb >/dev/null 2>&1; then
  if [[ -z "$SERIAL" ]]; then
    ONLINE_DEVICES="$(adb devices 2>/dev/null | awk 'NR > 1 && $2 == "device" {print $1}')"
    ONLINE_COUNT="$(printf '%s\n' "$ONLINE_DEVICES" | awk 'NF {count++} END {print count + 0}')"
    if [[ "$ONLINE_COUNT" == "1" ]]; then
      SERIAL="$ONLINE_DEVICES"
      pass "selected the only online adb device: $SERIAL"
    elif [[ "$ONLINE_COUNT" == "0" ]]; then
      fail "no online adb device found; pass --serial after authorizing the phone"
    else
      fail "multiple online adb devices found; select one with --serial"
      printf '%s\n' "$ONLINE_DEVICES" | sed 's/^/       /'
    fi
  else
    pass "selected adb device: $SERIAL"
  fi
fi

if command -v curl >/dev/null 2>&1; then
  probe_health
  if [[ $HEALTH_VALID -eq 1 ]]; then
    pass "ClawBench health endpoint is ready at $AGENT_BASE_URL: $HEALTH_RESPONSE"
  elif [[ $HEALTH_STATUS -eq 0 ]]; then
    fail "endpoint at $AGENT_BASE_URL is reachable but is not the ClawBench channel: $HEALTH_RESPONSE"
  else
    warn "ClawBench endpoint is not yet reachable at $AGENT_BASE_URL; an existing local adb forward will be checked before creating one"
  fi
fi

if [[ -n "$SERIAL" ]] && command -v adb >/dev/null 2>&1; then
  DEVICE_STATE="$(adb -s "$SERIAL" get-state 2>&1)"
  if [[ "$DEVICE_STATE" == "device" ]]; then
    pass "adb device state is device"
  else
    fail "adb device is not ready: $DEVICE_STATE"
  fi

  BRIGHTNESS="$(adb -s "$SERIAL" shell settings get system screen_brightness 2>&1)"
  if [[ -n "$BRIGHTNESS" && "$BRIGHTNESS" != "null" && "$BRIGHTNESS" != *"error"* ]]; then
    pass "Android settings are readable: screen_brightness=$BRIGHTNESS"
  else
    fail "cannot read Android screen_brightness: $BRIGHTNESS"
  fi

  TERMUX_PATH="$(adb -s "$SERIAL" shell pm path com.termux 2>/dev/null)"
  if [[ "$TERMUX_PATH" == package:* ]]; then
    pass "Termux is installed"

    TERMUX_PERMISSIONS="$(adb -s "$SERIAL" shell dumpsys package com.termux 2>/dev/null)"
    TERMUX_STORAGE_APPOP="$(adb -s "$SERIAL" shell \
      appops get com.termux MANAGE_EXTERNAL_STORAGE 2>/dev/null)"
    if [[ "$TERMUX_PERMISSIONS" == *'android.permission.READ_EXTERNAL_STORAGE: granted=true'* \
      && "$TERMUX_PERMISSIONS" == *'android.permission.WRITE_EXTERNAL_STORAGE: granted=true'* ]]; then
      pass "Termux shared-storage permissions are granted"
    elif [[ "$TERMUX_STORAGE_APPOP" == *'MANAGE_EXTERNAL_STORAGE: allow'* ]]; then
      pass "Termux all-files storage access is allowed"
    else
      fail "Termux cannot access shared storage; run termux-setup-storage and approve the permission"
    fi
  else
    fail "Termux is not installed"
  fi

  if [[ -n "${ADB_SERVER_SOCKET:-}" ]]; then
    pass "selected device is reachable through configured ADB server: $ADB_SERVER_SOCKET"
  else
    TARGET_HARDWARE_SERIAL="$(adb -s "$SERIAL" shell getprop ro.serialno 2>/dev/null | tr -d '\r')"
    TERMUX_ADB_FORWARD="$(adb -s "$SERIAL" forward --no-rebind tcp:0 \
      "tcp:$TERMUX_ADB_SERVER_PORT" 2>&1 | tr -d '\r')"
    TERMUX_ADB_FORWARD_STATUS=$?
    if [[ $TERMUX_ADB_FORWARD_STATUS -eq 0 && "$TERMUX_ADB_FORWARD" =~ ^[0-9]+$ ]]; then
      TERMUX_ADB_HOST_PORT="$TERMUX_ADB_FORWARD"
      TERMUX_ADB_DEVICES="$(ADB_SERVER_SOCKET="tcp:127.0.0.1:$TERMUX_ADB_HOST_PORT" \
        adb devices 2>&1)"
      TERMUX_ADB_QUERY_STATUS=$?
      TERMUX_ADB_READY_SERIALS="$(printf '%s\n' "$TERMUX_ADB_DEVICES" | \
        awk 'NR > 1 && $2 == "device" {print $1}')"
      MATCHED_TERMUX_ADB_SERIAL=""

      if [[ $TERMUX_ADB_QUERY_STATUS -eq 0 && -n "$TERMUX_ADB_READY_SERIALS" ]]; then
        while IFS= read -r phone_adb_serial; do
          [[ -n "$phone_adb_serial" ]] || continue
          PHONE_ADB_HARDWARE_SERIAL="$(
            ADB_SERVER_SOCKET="tcp:127.0.0.1:$TERMUX_ADB_HOST_PORT" \
              adb -s "$phone_adb_serial" shell getprop ro.serialno 2>/dev/null | tr -d '\r'
          )"
          if [[ -n "$TARGET_HARDWARE_SERIAL" \
            && "$PHONE_ADB_HARDWARE_SERIAL" == "$TARGET_HARDWARE_SERIAL" ]]; then
            MATCHED_TERMUX_ADB_SERIAL="$phone_adb_serial"
            break
          fi
        done <<< "$TERMUX_ADB_READY_SERIALS"
      fi

      adb -s "$SERIAL" forward --remove "tcp:$TERMUX_ADB_HOST_PORT" >/dev/null 2>&1 || true

      if [[ -n "$MATCHED_TERMUX_ADB_SERIAL" ]]; then
        pass "phone-side Termux adb is connected to this device: $MATCHED_TERMUX_ADB_SERIAL"
      elif [[ $TERMUX_ADB_QUERY_STATUS -ne 0 ]]; then
        fail "cannot query the phone-side Termux adb server on phone port $TERMUX_ADB_SERVER_PORT: $TERMUX_ADB_DEVICES"
      elif [[ -z "$TERMUX_ADB_READY_SERIALS" ]]; then
        fail "phone-side Termux adb has no connected device; pair/connect this phone in Termux and run 'adb devices'"
      else
        fail "phone-side Termux adb is connected, but not to selected device $SERIAL"
        printf '%s\n' "$TERMUX_ADB_DEVICES" | sed 's/^/       /'
      fi
    else
      fail "cannot create a temporary no-rebind tunnel to the phone-side Termux adb server on port $TERMUX_ADB_SERVER_PORT: $TERMUX_ADB_FORWARD"
    fi
  fi

  if [[ $HEALTH_VALID -eq 1 ]]; then
    pass "healthy CLAWBENCH_AGENT_BASE_URL is already routed; no adb HTTP forward was created"
  elif [[ $HEALTH_STATUS -ne 0 && "$AGENT_BASE_URL" != "$DEFAULT_AGENT_BASE_URL" ]]; then
    fail "CLAWBENCH_AGENT_BASE_URL=$AGENT_BASE_URL is unreachable and does not match the adb-forward endpoint $DEFAULT_AGENT_BASE_URL"
  elif [[ $HEALTH_STATUS -ne 0 && -n "${ADB_SERVER_SOCKET:-}" ]]; then
    fail "CLAWBENCH_AGENT_BASE_URL is unreachable while ADB_SERVER_SOCKET is remote; establish the separate SSH -L $HOST_PORT:127.0.0.1:$PHONE_PORT tunnel instead of creating a remote adb forward"
  elif [[ $HEALTH_STATUS -ne 0 ]] && command -v curl >/dev/null 2>&1; then
    EXPECTED_LOCAL="tcp:$HOST_PORT"
    EXPECTED_REMOTE="tcp:$PHONE_PORT"
    FORWARD_LIST="$(adb -s "$SERIAL" forward --list 2>&1 | tr -d '\r')"
    FORWARD_LIST_STATUS=$?
    EXISTING_MAPPING="$(printf '%s\n' "$FORWARD_LIST" | \
      awk -v local="$EXPECTED_LOCAL" '$2 == local {print $1 " " $3}')"

    if [[ $FORWARD_LIST_STATUS -ne 0 ]]; then
      fail "cannot inspect existing adb forwards: $FORWARD_LIST"
    elif [[ -z "$EXISTING_MAPPING" ]]; then
      FORWARD_OUTPUT="$(adb -s "$SERIAL" forward --no-rebind \
        "$EXPECTED_LOCAL" "$EXPECTED_REMOTE" 2>&1 | tr -d '\r')"
      FORWARD_STATUS=$?
      if [[ $FORWARD_STATUS -eq 0 ]]; then
        pass "created no-rebind adb tunnel: 127.0.0.1:$HOST_PORT -> phone:$PHONE_PORT"
      else
        fail "cannot create no-rebind adb tunnel: $FORWARD_OUTPUT"
      fi
    elif [[ "$EXISTING_MAPPING" == "$SERIAL $EXPECTED_REMOTE" ]]; then
      pass "verified existing adb tunnel: 127.0.0.1:$HOST_PORT -> phone:$PHONE_PORT"
    else
      fail "adb forward $EXPECTED_LOCAL conflicts with selected device/remote: $EXISTING_MAPPING"
    fi

    probe_health
    if [[ $HEALTH_VALID -eq 1 ]]; then
      pass "ClawBench health endpoint became ready at $AGENT_BASE_URL: $HEALTH_RESPONSE"
    else
      fail "ClawBench health check failed at $AGENT_BASE_URL/health after forward validation: $HEALTH_RESPONSE"
    fi
  fi
fi

if command -v curl >/dev/null 2>&1 && [[ $HEALTH_VALID -eq 1 ]]; then
  PROTOCOL_URL="$AGENT_BASE_URL/runs/__clawbench_environment_probe_missing_run__"
  if [[ -n "${CLAWBENCH_AGENT_TOKEN:-}" ]]; then
    PROTOCOL_RESPONSE="$(curl --silent --show-error --max-time 10 \
      -H "Authorization: Bearer $CLAWBENCH_AGENT_TOKEN" \
      -w $'\n%{http_code}' "$PROTOCOL_URL" 2>&1)"
  else
    PROTOCOL_RESPONSE="$(curl --silent --show-error --max-time 10 \
      -w $'\n%{http_code}' "$PROTOCOL_URL" 2>&1)"
  fi
  PROTOCOL_STATUS=$?
  PROTOCOL_HTTP_CODE="$(printf '%s' "${PROTOCOL_RESPONSE##*$'\n'}" | tr -d '\r')"
  PROTOCOL_BODY="${PROTOCOL_RESPONSE%$'\n'*}"
  PROTOCOL_BODY_LOWER="$(printf '%s' "$PROTOCOL_BODY" | tr '[:upper:]' '[:lower:]')"
  if [[ $PROTOCOL_STATUS -eq 0 && "$PROTOCOL_HTTP_CODE" == "404" \
    && "$PROTOCOL_BODY_LOWER" == *"run not found"* ]]; then
    pass "ClawBench native run protocol is available (unknown GET -> 404 run not found)"
  else
    fail "ClawBench native run protocol check failed at $PROTOCOL_URL: http=$PROTOCOL_HTTP_CODE body=$PROTOCOL_BODY"
  fi
fi

if command -v conda >/dev/null 2>&1; then
  PYTHON_VERSION="$(conda run --no-capture-output "${CONDA_TARGET_ARGS[@]}" python --version 2>&1)"
  PYTHON_STATUS=$?
  if [[ $PYTHON_STATUS -eq 0 ]]; then
    pass "Python environment '$CONDA_ENV' is available: $PYTHON_VERSION"
  else
    fail "cannot run Python in conda environment '$CONDA_ENV': $PYTHON_VERSION"
  fi

  PYTEST_VERSION="$(cd "$PROJECT_ROOT" && conda run --no-capture-output \
    "${CONDA_TARGET_ARGS[@]}" python -m pytest --version 2>&1)"
  PYTEST_STATUS=$?
  if [[ $PYTEST_STATUS -eq 0 ]]; then
    pass "pytest is available: $PYTEST_VERSION"
  else
    fail "pytest is not available in conda environment '$CONDA_ENV': $PYTEST_VERSION"
  fi
fi

if [[ -z "$RESULTS_DIR" ]]; then
  fail "CLAWBENCH_RESULTS_DIR is not set"
else
  RESULTS_DIR_NORMALIZED="${RESULTS_DIR//\\//}"
  RESULTS_DIR_LOWER="${RESULTS_DIR_NORMALIZED,,}"
  if [[ "$RESULTS_DIR_LOWER" != "d:/codexdataspace" \
    && "$RESULTS_DIR_LOWER" != d:/codexdataspace/* ]]; then
    fail "CLAWBENCH_RESULTS_DIR must be under D:/codexdataspace: $RESULTS_DIR"
  elif [[ ! -d "$RESULTS_DIR_NORMALIZED" ]]; then
    fail "CLAWBENCH_RESULTS_DIR must already exist as a directory: $RESULTS_DIR"
  elif [[ ! -w "$RESULTS_DIR_NORMALIZED" ]]; then
    fail "CLAWBENCH_RESULTS_DIR is not writable: $RESULTS_DIR"
  else
    pass "CLAWBENCH_RESULTS_DIR is an existing writable D-drive directory: $RESULTS_DIR_NORMALIZED"
  fi
fi

printf '\nManual validation still required\n'
warn "confirm the phone-side model provider and auth profile can complete a run"

printf '\nSummary: %d passed, %d failed, %d warnings\n' \
  "$PASS_COUNT" "$FAIL_COUNT" "$WARN_COUNT"

if [[ $FAIL_COUNT -gt 0 ]]; then
  printf 'Environment is NOT READY.\n' >&2
  exit 1
fi

printf 'Environment is READY for a real-device smoke task.\n'
