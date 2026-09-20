Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Invoke-V4Ssh {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [pscustomobject] $Device,
        [Parameter(Mandatory)] [string] $Command
    )
    $ssh = (Get-Command ssh -ErrorAction Stop).Source
    $sshUser = if (
        $Device.PSObject.Properties.Name -contains 'ssh_user' -and
        -not [string]::IsNullOrWhiteSpace([string]$Device.ssh_user)
    ) { [string]$Device.ssh_user } else { 'u0_a299' }
    $target = "$sshUser@$($Device.ssh_host)"
    $arguments = @('-F','NUL')
    if (
        $Device.PSObject.Properties.Name -contains 'ssh_identity_file' -and
        -not [string]::IsNullOrWhiteSpace([string]$Device.ssh_identity_file)
    ) {
        $identity = [string]$Device.ssh_identity_file
        if (-not (Test-Path -LiteralPath $identity -PathType Leaf)) {
            throw "Device SSH identity does not exist: $identity"
        }
        $arguments += @('-i',$identity,'-o','IdentitiesOnly=yes')
    }
    $arguments += @('-p',([string]$Device.ssh_port),'-o','BatchMode=yes','-o','ConnectTimeout=10',$target,$Command)
    $output = & $ssh @arguments 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "Device $($Device.device_id) SSH command failed (exit $LASTEXITCODE): $($output -join [Environment]::NewLine)"
    }
    return @($output)
}

function Get-V4RouterClientToken {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [pscustomobject] $Device)

    $lines = Invoke-V4Ssh -Device $Device -Command 'base64 < "$HOME/.openclaw/openclaw.json" | tr -d ''\n'''
    try {
        $configText = [Text.Encoding]::UTF8.GetString(
            [Convert]::FromBase64String(($lines -join ''))
        )
        $config = $configText | ConvertFrom-Json
        $token = [string]$config.models.providers.'clawmobile-router'.apiKey
    } catch {
        throw "Cannot read the device Router client token from OpenClaw config: $($_.Exception.Message)"
    }
    if ([Text.Encoding]::UTF8.GetByteCount($token) -lt 32) {
        throw 'Device Router client token is absent or shorter than 32 UTF-8 bytes.'
    }
    return $token
}

function Invoke-V4HttpJson {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string] $Uri,
        [int] $TimeoutSec = 10
    )
    try {
        return Invoke-RestMethod -Method Get -Uri $Uri -TimeoutSec $TimeoutSec
    } catch {
        throw "HTTP health check failed for $Uri`: $($_.Exception.Message)"
    }
}

function Clear-V4StaleTermuxApiWorkers {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [pscustomobject] $Device)

    # Termux:API helper processes can remain as Android phantom children after a
    # completed cell.  Reclaim only that exact helper name at the cell boundary;
    # never target the Termux app, sshd, ADB, Gateway, or Router Proxy.
    $script = @'
set -eu
pids=$(pgrep -x termux-api 2>/dev/null || true)
before=0
for pid in $pids; do
  before=$((before + 1))
  kill -TERM "$pid" 2>/dev/null || true
done
if [ "$before" -gt 0 ]; then
  for i in $(seq 1 20); do
    [ -z "$(pgrep -x termux-api 2>/dev/null || true)" ] && break
    sleep 0.1
  done
fi
remaining=$(pgrep -x termux-api 2>/dev/null || true)
[ -z "$remaining" ] || { printf 'stale termux-api workers remain: %s\n' "$remaining" >&2; exit 76; }
printf '%s\n' "$before"
'@
    $countText = ((Invoke-V4Ssh -Device $Device -Command $script) -join '').Trim()
    if ($countText -notmatch '^\d+$') {
        throw "Invalid stale Termux:API worker cleanup count: $countText"
    }
    return [pscustomobject][ordered]@{
        checked_at = [DateTimeOffset]::UtcNow.ToString('o')
        exact_process_name = 'termux-api'
        reclaimed_count = [int]$countText
        remaining_count = 0
    }
}

function Invoke-V4XmuHttpJson {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [pscustomobject] $Device,
        [Parameter(Mandatory)] [ValidateSet('GET','POST')] [string] $Method,
        [Parameter(Mandatory)] [string] $Path,
        [int] $TimeoutSeconds = 30
    )
    if ($Path -notmatch '^/[A-Za-z0-9_./?=&-]+$') { throw "Unsafe XMU endpoint path: $Path" }
    $script = @'
set -eu
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
status=$(curl -sS --max-time '__TIMEOUT__' -X '__METHOD__' -o "$tmp" -w '%{http_code}' 'http://127.0.0.1:18080__PATH__')
printf '%s|' "$status"
base64 < "$tmp" | tr -d '\n'
'@.Replace('__TIMEOUT__',[string]$TimeoutSeconds).Replace('__METHOD__',$Method).Replace('__PATH__',$Path)
    $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($script))
    $wire = ((Invoke-V4Ssh -Device $Device -Command "printf '%s' '$encoded' | base64 -d | bash") -join '')
    $parts = @($wire -split '\|', 2)
    if ($parts.Count -ne 2 -or $parts[0] -notmatch '^\d{3}$') { throw "Invalid XMU transport envelope for $Method $Path" }
    $text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($parts[1]))
    if ([int]$parts[0] -lt 200 -or [int]$parts[0] -ge 300) { throw "XMU $Method $Path returned HTTP $($parts[0]): $text" }
    try { $json = $text | ConvertFrom-Json }
    catch { throw "XMU $Method $Path returned invalid JSON." }
    return [pscustomobject][ordered]@{ method=$Method;path=$Path;response_status=[int]$parts[0];json=$json }
}

function Assert-V4XmuModel {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [pscustomobject] $Device,
        [Parameter(Mandatory)] [string] $ExpectedModelId,
        [Parameter(Mandatory)] [int] $ExpectedContextWindow,
        [switch] $RequireCleanSlot
    )
    $health = Invoke-V4XmuHttpJson -Device $Device -Method GET -Path '/health'
    $props = Invoke-V4XmuHttpJson -Device $Device -Method GET -Path '/props'
    $models = Invoke-V4XmuHttpJson -Device $Device -Method GET -Path '/v1/models'
    $slots = Invoke-V4XmuHttpJson -Device $Device -Method GET -Path '/slots'
    if ([string]$health.json.status -cne 'ok') { throw 'XMU health status is not ok.' }
    if ([string]$props.json.model_alias -cne $ExpectedModelId -or [int]$props.json.default_generation_settings.n_ctx -ne $ExpectedContextWindow) {
        throw "XMU service identity mismatch: expected $ExpectedModelId context $ExpectedContextWindow."
    }
    if (@($models.json.data | Where-Object { [string]$_.id -ceq $ExpectedModelId }).Count -ne 1) {
        throw "XMU /v1/models does not expose exactly one expected model $ExpectedModelId."
    }
    $slotRows = @($slots.json)
    if ($slotRows.Count -ne 1 -or $slotRows[0].is_processing -ne $false) { throw 'XMU must expose exactly one idle slot.' }
    # Current llama-server omits n_prompt_tokens_cache when an idle slot has
    # never cached a prompt or has just been erased. A present value remains
    # authoritative; an absent value on the already-proven idle slot is zero.
    $promptCache = if ($slotRows[0].PSObject.Properties.Name -contains 'n_prompt_tokens_cache') {
        [int64]$slotRows[0].n_prompt_tokens_cache
    } else {
        [int64]0
    }
    if ($RequireCleanSlot -and $promptCache -ne 0) { throw 'XMU prompt cache is not zero.' }
    return [pscustomobject][ordered]@{
        checked_at=[DateTimeOffset]::UtcNow.ToString('o');model_id=$ExpectedModelId;context_window=$ExpectedContextWindow
        slot_id=[int]$slotRows[0].id;slot_idle=$true;n_prompt_tokens_cache=$promptCache
        health=$health;props=$props;models=$models;slots=$slots
    }
}

function Reset-V4XmuSlot {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [pscustomobject] $Device,
        [Parameter(Mandatory)] [string] $ExpectedModelId,
        [Parameter(Mandatory)] [int] $ExpectedContextWindow
    )
    $before = Assert-V4XmuModel -Device $Device -ExpectedModelId $ExpectedModelId -ExpectedContextWindow $ExpectedContextWindow
    $erase = Invoke-V4XmuHttpJson -Device $Device -Method POST -Path ("/slots/{0}?action=erase" -f [int]$before.slot_id)
    if ([int]$erase.json.id_slot -ne [int]$before.slot_id -or [int64]$erase.json.n_erased -lt 0) { throw 'XMU slot erase response is invalid.' }
    $after = Assert-V4XmuModel -Device $Device -ExpectedModelId $ExpectedModelId -ExpectedContextWindow $ExpectedContextWindow -RequireCleanSlot
    return [pscustomobject][ordered]@{before=$before;erase=$erase;after=$after}
}

function Get-V4AdbState {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [pscustomobject] $Device)

    $adb = (Get-Command adb -ErrorAction Stop).Source
    $previous = $env:ADB_SERVER_SOCKET
    try {
        $env:ADB_SERVER_SOCKET = if (
            $Device.PSObject.Properties.Name -contains 'adb_server_socket' -and
            -not [string]::IsNullOrWhiteSpace([string]$Device.adb_server_socket)
        ) { [string]$Device.adb_server_socket } else { 'tcp:127.0.0.1:15038' }
        $state = (& $adb -s ([string]$Device.adb_serial) get-state 2>&1 | Out-String).Trim()
        if ($LASTEXITCODE -ne 0 -or $state -cne 'device') {
            throw "ADB serial $($Device.adb_serial) is not healthy: $state"
        }
        $bootId = (& $adb -s ([string]$Device.adb_serial) shell cat /proc/sys/kernel/random/boot_id 2>&1 | Out-String).Trim()
        if ($LASTEXITCODE -ne 0 -or $bootId -notmatch '^[0-9a-f-]{36}$') {
            throw "Could not read device boot ID: $bootId"
        }
        return [pscustomobject][ordered]@{
            state = $state
            serial = [string]$Device.adb_serial
            boot_id = $bootId
        }
    } finally {
        if ($null -eq $previous) { Remove-Item Env:ADB_SERVER_SOCKET -ErrorAction SilentlyContinue }
        else { $env:ADB_SERVER_SOCKET = $previous }
    }
}

function Assert-V4InvocationEnvironment {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [pscustomobject] $Config)

    $null = Invoke-V4Ssh -Device $Config.device -Command "printf 'v4-ssh-ok'"
    $termuxApiCleanup = Clear-V4StaleTermuxApiWorkers -Device $Config.device
    $adb = Get-V4AdbState -Device $Config.device
    $channelBase = if ($Config.device.PSObject.Properties.Name -contains 'clawbench_agent_base_url') { [string]$Config.device.clawbench_agent_base_url } else { 'http://127.0.0.1:18766' }
    $gatewayBase = if ($Config.device.PSObject.Properties.Name -contains 'gateway_base_url') { [string]$Config.device.gateway_base_url } else { 'http://127.0.0.1:18789' }
    $proxyBase = if ($Config.device.PSObject.Properties.Name -contains 'router_proxy_base_url') { [string]$Config.device.router_proxy_base_url } else { 'http://127.0.0.1:18081' }
    $channel = Invoke-V4HttpJson -Uri "$channelBase/health"
    if ($channel.ok -ne $true) { throw 'ClawBench Channel health did not return ok=true.' }
    $gateway = Invoke-V4HttpJson -Uri "$gatewayBase/healthz"
    $proxy = Invoke-V4HttpJson -Uri "$proxyBase/health"
    if ([string]$proxy.status -cne 'ok' -or $proxy.v4_enabled -ne $true) {
        throw 'Shared Proxy is not healthy in v4 mode.'
    }
    if ([int]$proxy.provider_concurrency.'freeinference-global'.configured -ne 1) {
        throw 'Shared Proxy FreeInference concurrency is not fixed at one.'
    }
    if ([string]$Config.design_id -ceq 'phone-a-g0-gpt55-expanded15-partial-v1' -and [int]$proxy.provider_concurrency.'openai-global'.configured -ne 1) {
        throw 'Shared Proxy OpenAI concurrency is not fixed at one.'
    }
    return [pscustomobject][ordered]@{
        checked_at = [DateTimeOffset]::UtcNow.ToString('o')
        adb = $adb
        channel = $channel
        gateway = $gateway
        proxy = $proxy
        termux_api_cleanup = $termuxApiCleanup
    }
}

function Assert-V4CellEnvironment {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [pscustomobject] $Config,
        [Parameter(Mandatory)] [string] $ExpectedBootId
    )
    $null = Invoke-V4Ssh -Device $Config.device -Command "printf 'v4-cell-ssh-ok'"
    $termuxApiCleanup = Clear-V4StaleTermuxApiWorkers -Device $Config.device
    $adb = Get-V4AdbState -Device $Config.device
    if ([string]$adb.boot_id -cne $ExpectedBootId) {
        throw "Device boot ID changed during the invocation: expected $ExpectedBootId, observed $($adb.boot_id)."
    }
    $channelBase = if ($Config.device.PSObject.Properties.Name -contains 'clawbench_agent_base_url') { [string]$Config.device.clawbench_agent_base_url } else { 'http://127.0.0.1:18766' }
    $gatewayBase = if ($Config.device.PSObject.Properties.Name -contains 'gateway_base_url') { [string]$Config.device.gateway_base_url } else { 'http://127.0.0.1:18789' }
    $proxyBase = if ($Config.device.PSObject.Properties.Name -contains 'router_proxy_base_url') { [string]$Config.device.router_proxy_base_url } else { 'http://127.0.0.1:18081' }
    $channel = Invoke-V4HttpJson -Uri "$channelBase/health"
    if ($channel.ok -ne $true) { throw 'ClawBench Channel health did not return ok=true.' }
    $gateway = Invoke-V4HttpJson -Uri "$gatewayBase/healthz"
    $proxy = Invoke-V4HttpJson -Uri "$proxyBase/health"
    if ([string]$proxy.status -cne 'ok' -or $proxy.v4_enabled -ne $true) {
        throw 'Shared Proxy is not healthy in v4 mode.'
    }
    if ([int]$proxy.provider_concurrency.'freeinference-global'.configured -ne 1) {
        throw 'Shared Proxy FreeInference concurrency is not fixed at one.'
    }
    if ([string]$Config.design_id -ceq 'phone-a-g0-gpt55-expanded15-partial-v1' -and [int]$proxy.provider_concurrency.'openai-global'.configured -ne 1) {
        throw 'Shared Proxy OpenAI concurrency is not fixed at one.'
    }
    return [pscustomobject][ordered]@{
        checked_at = [DateTimeOffset]::UtcNow.ToString('o')
        adb = $adb
        channel = $channel
        gateway = $gateway
        proxy = $proxy
        termux_api_cleanup = $termuxApiCleanup
    }
}

Export-ModuleMember -Function Invoke-V4Ssh,Get-V4RouterClientToken,Invoke-V4HttpJson,Clear-V4StaleTermuxApiWorkers,Invoke-V4XmuHttpJson,Assert-V4XmuModel,Reset-V4XmuSlot,Get-V4AdbState,Assert-V4InvocationEnvironment,Assert-V4CellEnvironment
