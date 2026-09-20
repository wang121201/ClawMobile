Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-V4JsonExclusive {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string] $Path,
        [Parameter(Mandatory)] $Value
    )
    $parent = Split-Path -Parent $Path
    if ($parent) { [IO.Directory]::CreateDirectory($parent) | Out-Null }
    $bytes = [Text.Encoding]::UTF8.GetBytes(($Value | ConvertTo-Json -Depth 40) + "`n")
    $stream = $null
    try {
        $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush($true)
    } finally {
        if ($null -ne $stream) { $stream.Dispose() }
    }
    return [pscustomobject]@{
        path = [IO.Path]::GetFullPath($Path)
        bytes = $bytes.Length
        sha256 = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
    }
}

function New-V4CellClaim {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string] $CellRoot,
        [Parameter(Mandatory)] [pscustomobject] $Cell,
        [Parameter(Mandatory)] [string] $GroupRunId
    )
    if (Test-Path -LiteralPath $CellRoot) {
        throw "Cell evidence path already exists; refusing before any model request: $CellRoot"
    }
    [IO.Directory]::CreateDirectory($CellRoot) | Out-Null
    $claim = [ordered]@{
        schema_version = 4
        record_type = 'cell_claim'
        claimed_at = [DateTimeOffset]::UtcNow.ToString('o')
        group_run_id = $GroupRunId
        stage = $Cell.stage
        schedule = [int]$Cell.schedule
        group_id = $Cell.group_id
        arm_id = $Cell.arm_id
        task_case = $Cell.task_case
        repetition = [int]$Cell.repetition
    }
    return Write-V4JsonExclusive -Path (Join-Path $CellRoot 'cell-claim.json') -Value $claim
}

function Read-V4Result {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [string] $CellRoot)
    $jsonRoot = Join-Path $CellRoot 'json'
    $files = @(Get-ChildItem -LiteralPath $jsonRoot -Filter '*.json' -File -ErrorAction SilentlyContinue)
    if ($files.Count -ne 1) {
        throw "Expected exactly one ClawBench result JSON under $jsonRoot; observed $($files.Count)."
    }
    return [pscustomobject]@{
        path = $files[0].FullName
        value = (Get-Content -LiteralPath $files[0].FullName -Raw -Encoding UTF8 | ConvertFrom-Json)
        sha256 = (Get-FileHash -LiteralPath $files[0].FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    }
}

function Get-V4CompletionToolNames {
    param([Parameter(Mandatory)] $ParsedResponse)
    $names = [Collections.Generic.List[string]]::new()
    $payloads = [Collections.Generic.List[object]]::new()
    $format = if ($ParsedResponse.PSObject.Properties.Name -contains 'format') { [string]$ParsedResponse.format } else { '' }
    if ($format -ceq 'json' -and $ParsedResponse.PSObject.Properties.Name -contains 'value' -and $null -ne $ParsedResponse.value) {
        $payloads.Add($ParsedResponse.value)
    } elseif ($format -ceq 'sse' -and $ParsedResponse.PSObject.Properties.Name -contains 'events') {
        foreach ($event in @($ParsedResponse.events)) {
            if ($event -isnot [string] -and $null -ne $event) { $payloads.Add($event) }
        }
    }
    foreach ($payload in $payloads) {
        if (-not ($payload.PSObject.Properties.Name -contains 'choices')) { continue }
        foreach ($choice in @($payload.choices)) {
            $containers = @()
            if ($choice.PSObject.Properties.Name -contains 'message') { $containers += $choice.message }
            if ($choice.PSObject.Properties.Name -contains 'delta') { $containers += $choice.delta }
            foreach ($container in $containers) {
                if ($null -eq $container) { continue }
                # An SSE stream may finish with an empty delta object.  Under
                # StrictMode, projecting `.Name` from an empty property
                # collection throws instead of returning an empty array.
                if ($null -eq $container.PSObject.Properties['tool_calls']) { continue }
                foreach ($call in @($container.tool_calls)) {
                    if ($null -eq $call -or $null -eq $call.PSObject.Properties['function'] -or $null -eq $call.function -or $null -eq $call.function.PSObject.Properties['name']) { continue }
                    $name = [string]$call.function.name
                    if (-not [string]::IsNullOrWhiteSpace($name)) { $names.Add($name) }
                }
            }
        }
    }
    return @($names | Sort-Object -Unique)
}

function Get-V4CloudFollowupCategory {
    param([Parameter(Mandatory)] [string[]] $ToolNames)
    if ($ToolNames.Count -eq 0) { return 'NO_TOOL' }
    $ui = @('android_tap','adb_tap','android_type','adb_type','android_swipe','adb_swipe','android_keyevent','adb_keyevent')
    $shell = @('android_shell','adb_shell','exec')
    $categories = @($ToolNames | ForEach-Object {
        if ([string]$_ -in $ui) { 'UI' }
        elseif ([string]$_ -in $shell) { 'SHELL' }
        else { 'PROVIDER' }
    } | Sort-Object -Unique)
    if ($categories.Count -eq 1) { return [string]$categories[0] }
    return 'MIXED'
}

function Wait-V4ProxyCapture {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string] $RunId,
        [string] $ProxyControlUrl = 'http://127.0.0.1:18081',
        [int] $TimeoutSeconds = 30
    )
    $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        $health = Invoke-RestMethod -Method Get -Uri "$($ProxyControlUrl.TrimEnd('/'))/health?run_id=$RunId" -TimeoutSec 10
        $capture = $health.capture
        if (
            [int]$capture.pending -eq 0 -and
            [int]$capture.errors -eq 0 -and
            [int]$capture.record_count -gt 0 -and
            [int]$capture.record_count -eq [int]$capture.durable_record_count -and
            [int]$capture.model_call_count -eq [int]$capture.durable_model_call_count
        ) {
            return $health
        }
        Start-Sleep -Milliseconds 250
    } while ([DateTimeOffset]::UtcNow -lt $deadline)
    throw "Proxy capture for run_id $RunId did not become durably flushed within $TimeoutSeconds seconds."
}

function Copy-V4RemoteFileVerified {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [pscustomobject] $Device,
        [Parameter(Mandatory)] [string] $RemotePath,
        [Parameter(Mandatory)] [string] $LocalPath
    )
    if ($RemotePath -notmatch '^/data/data/com\.termux/files/home/clawmobile-experiments/[A-Za-z0-9_.\/-]+$') {
        throw "Remote evidence path is outside the v4 experiment root: $RemotePath"
    }
    if (Test-Path -LiteralPath $LocalPath) {
        throw "Local evidence file already exists: $LocalPath"
    }
    $remoteProbe = (Invoke-V4Ssh -Device $Device -Command "test -f '$RemotePath' && test ! -L '$RemotePath' && printf '%s ' `$(wc -c < '$RemotePath') && sha256sum '$RemotePath' | cut -d' ' -f1") -join ''
    if ($remoteProbe -notmatch '^(\d+) ([0-9a-f]{64})$') {
        throw "Could not verify remote evidence file: $RemotePath ($remoteProbe)"
    }
    $remoteBytes = [int64]$Matches[1]
    $remoteHash = $Matches[2]
    $scp = (Get-Command scp -ErrorAction Stop).Source
    $sshUser = if (
        $Device.PSObject.Properties.Name -contains 'ssh_user' -and
        -not [string]::IsNullOrWhiteSpace([string]$Device.ssh_user)
    ) { [string]$Device.ssh_user } else { 'u0_a299' }
    $target = "$sshUser@$($Device.ssh_host):$RemotePath"
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
    $arguments += @('-P',([string]$Device.ssh_port),'-o','BatchMode=yes',$target,$LocalPath)
    & $scp @arguments 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "SCP failed for $RemotePath" }
    $local = Get-Item -LiteralPath $LocalPath
    $localHash = (Get-FileHash -LiteralPath $LocalPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($local.Length -ne $remoteBytes -or $localHash -cne $remoteHash) {
        throw "Remote/local evidence mismatch for $RemotePath"
    }
    return [pscustomobject]@{ remote_path=$RemotePath; local_path=$local.FullName; bytes=$local.Length; sha256=$localHash }
}

function Copy-V4CaptureEvidence {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [pscustomobject] $Device,
        [Parameter(Mandatory)] [string] $RemoteCaptureRoot,
        [Parameter(Mandatory)] [string] $RunId,
        [Parameter(Mandatory)] [string] $CellRoot
    )
    if ($RunId -notmatch '^[0-9a-f]{32}$') { throw "Invalid result.run_id: $RunId" }
    $remoteRunRoot = "$RemoteCaptureRoot/$RunId"
    $model = Copy-V4RemoteFileVerified -Device $Device -RemotePath "$remoteRunRoot/model-calls.jsonl" -LocalPath (Join-Path $CellRoot 'model-calls.jsonl')
    $events = Copy-V4RemoteFileVerified -Device $Device -RemotePath "$remoteRunRoot/proxy-events.jsonl" -LocalPath (Join-Path $CellRoot 'proxy-events.jsonl')
    return @($model, $events)
}

function Test-V4Capture {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string] $Path,
        [Parameter(Mandatory)] [string] $RunId,
        [Parameter(Mandatory)] [string] $ArmId,
        [string] $ProxyEventsPath = ''
    )
    $lines = @([IO.File]::ReadAllLines($Path, [Text.Encoding]::UTF8) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    if ($lines.Count -eq 0) { throw "Capture is empty: $Path" }
    $records = @($lines | ForEach-Object { $_ | ConvertFrom-Json })
    $sequences = @($records | ForEach-Object { [int]$_.capture_sequence })
    for ($i=0; $i -lt $sequences.Count; $i++) {
        if ($sequences[$i] -ne ($i + 1)) { throw "Capture sequence is not contiguous at position $($i+1)." }
    }
    foreach ($record in $records) {
        if ([string]$record.session_id -cne $RunId) { throw 'Capture session_id differs from result.run_id.' }
        if ([string]$record.arm_id -cne $ArmId) { throw 'Capture arm_id differs from the planned arm.' }
        if ($record.PSObject.Properties.Name -contains 'raw_response_base64') {
            $bytes = [Convert]::FromBase64String([string]$record.raw_response_base64)
            if ($bytes.Length -ne [int]$record.raw_response_bytes) { throw 'raw_response_bytes mismatch.' }
            $algorithm = [Security.Cryptography.SHA256]::Create()
            try { $hashBytes = $algorithm.ComputeHash($bytes) } finally { $algorithm.Dispose() }
            $hash = ([BitConverter]::ToString($hashBytes) -replace '-', '').ToLowerInvariant()
            if ($hash -cne [string]$record.raw_response_sha256) { throw 'raw_response_sha256 mismatch.' }
            if ([Text.Encoding]::UTF8.GetString($bytes) -cne [string]$record.raw_response_text) { throw 'raw_response_text mismatch.' }
        }
    }
    $inbound = @($records | Where-Object event -eq 'proxy_request')
    $calls = @($records | Where-Object event -eq 'model_call')
    if ($inbound.Count -lt 1 -or $calls.Count -lt 1) { throw 'Capture lacks an inbound request or physical model call.' }
    foreach ($call in $calls) {
        if ($call.PSObject.Properties.Name -contains 'transport_error') { throw 'Capture contains a provider transport failure.' }
        if ([int]$call.response_status -lt 200 -or [int]$call.response_status -ge 300) { throw 'Capture contains a non-2xx provider response.' }
        if ($call.capture_complete -ne $true) { throw 'Capture contains an incomplete raw response.' }
        if ([string]$call.raw_response_text -match 'The model is starting up') { throw 'Capture contains a provider model-starting placeholder response.' }
    }
    $expectedRoles = switch -Regex ($ArmId) {
        '^full-xmu-' { @('local_agent'); break }
        '^full-' { @('cloud_agent'); break }
        '^filter-' { @('filter_helper','cloud_agent'); break }
        '^router-explicit-binary-tool-' { @(); break }
        '^router-' { @('router_helper'); break }
        default { throw "Unknown v4 arm: $ArmId" }
    }
    foreach ($role in $expectedRoles) {
        if (@($calls | Where-Object call_role -eq $role).Count -lt 1) { throw "Capture lacks required role $role." }
    }
    if ($ArmId -like 'router-*' -and @($calls | Where-Object { $_.call_role -in @('cloud_agent','local_agent') }).Count -lt 1) {
        throw 'Router capture lacks its selected Agent backend.'
    }
    if ($ArmId -like 'router-explicit-binary-tool-*' -and @($calls | Where-Object call_role -eq 'router_helper').Count -ne 0) {
        throw 'Explicit binary Tool policy unexpectedly invoked a model Router.'
    }
    $roleSessions = @($calls | Group-Object service_role | ForEach-Object { [string]$_.Group[0].upstream_session_id })
    if (@($roleSessions | Sort-Object -Unique).Count -ne $roleSessions.Count) { throw 'Provider role sessions are not distinct.' }
    $routeDecisionCount = 0
    $routeFailureCount = 0
    $routeClasses = @()
    $binaryRoutes = @()
    $binaryRouteCounts = @()
    $exactToolCounts = @()
    $routePolicyVersion = $null
    $localBackendSelectionCount = 0
    $acceptedLocalCallCount = 0
    $localValidationFailureCount = 0
    $localAgentCallCount = @($calls | Where-Object call_role -eq 'local_agent').Count
    $cloudAgentCallCount = @($calls | Where-Object call_role -eq 'cloud_agent').Count
    $routeReclassificationAppliedCount = 0
    $routeReclassificationRejectedCount = 0
    $c1ReclassificationExecutionCount = 0
    $c2AddedExecutionCount = 0
    $localValidationFailureReasonCounts = @()
    $routeClassCounts = @()
    $fsmAdmissibilityRestrictionCount = 0
    $fsmTransitionPendingCount = 0
    $fsmTransitionResolvedCount = 0
    $fsmTransitionMatchCount = 0
    $fsmForcedCloudHandoffCount = 0
    $repairAttemptCount = 0
    $repairAppliedCount = 0
    $repairRejectedCount = 0
    $rawValidLocalCallCount = 0
    $repairAssistedValidLocalCallCount = 0
    $repairInterceptedAfterRevalidationCount = 0
    $cloudFirstGateTriggerCount = 0
    $cloudFirstFollowupUiCount = 0
    $cloudFirstFollowupProviderCount = 0
    $cloudFirstFollowupShellCount = 0
    $cloudFirstFollowupNoToolCount = 0
    $cloudFirstFollowupMixedCount = 0
    $cloudFirstFollowupDetails = @()
    $effectAwareTransitionCount = 0
    $strongPathCheckExposureCount = 0
    $strongPathCheckDetails = @()
    $routeGeneration = switch -Regex ($ArmId) {
        '^router-explicit-binary-tool-' { 'explicit-binary-tool'; break }
        '^router-binary-tool-' { 'binary-tool'; break }
        '^router-fsm-scoped-repair-' { 'fsm-scoped-repair'; break }
        '^router-fsm-scoped-' { 'fsm-scoped'; break }
        '^router-rm-scoped-' { 'rm-scoped'; break }
        '^router-r1-' { 'r1'; break }
        '^router-r2-' { 'r2'; break }
        '^router-rm-' { 'rm'; break }
        default { $null }
    }
    if ($null -ne $routeGeneration) {
        if ([string]::IsNullOrWhiteSpace($ProxyEventsPath) -or -not (Test-Path -LiteralPath $ProxyEventsPath -PathType Leaf)) {
            throw 'Finite Router capture requires proxy-events.jsonl.'
        }
        $eventLines = @([IO.File]::ReadAllLines($ProxyEventsPath, [Text.Encoding]::UTF8) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
        $events = @($eventLines | ForEach-Object { $_ | ConvertFrom-Json })
        foreach ($event in $events) {
            if ([string]$event.session_id -cne $RunId -or [string]$event.arm_id -cne $ArmId) { throw 'Finite Router proxy event identity differs from the Cell.' }
        }
        $routeRows = @($events | Where-Object { $_.event -in @('router_decision','router_failed') })
        $requestIds = @($inbound.proxy_request_id | Sort-Object -Unique)
        foreach ($requestId in $requestIds) {
            $matched = @($routeRows | Where-Object request_id -CEQ ([string]$requestId))
            if ($matched.Count -ne 1) { throw "Finite Router request $requestId does not have exactly one decision or fail-closed Router record." }
        }
        $expectedPolicy = switch ($routeGeneration) {
            'r1' { 'g4-r1-evidence-v1' }
            'r2' { 'g4-r2-grounded-query-v1' }
            'rm' { 'g4-rm-moderate-action-v1' }
            'rm-scoped' { 'g4-rm-scoped-context-v1' }
            'fsm-scoped' { 'g4-fsm-scoped-context-v1' }
            'fsm-scoped-repair' { 'g4-fsm-scoped-context-standard-moderate-repair-v1' }
            'binary-tool' { 'coarse-binary-ui-gate-v1' }
            'explicit-binary-tool' { 'explicit-fsm-exact-tool-capability-v1' }
            default { throw 'Unknown finite Router generation.' }
        }
        foreach ($row in $routeRows) {
            if ([string]$row.route_policy_version -cne $expectedPolicy) { throw 'Finite Router route policy version differs from its arm.' }
            if ($null -eq $row.route_state -or [string]$row.route_state.semantics -cne 'deterministic_projection_from_current_request_history_only') { throw 'Finite Router decision lacks the deterministic route-state projection.' }
            if ([int]$row.route_state.request_ordinal -lt 1 -or [string]$row.route_state.phase -notin @('PRECHECK','OBSERVE','GROUND','READY','VERIFY_PENDING')) { throw 'Finite Router route-state projection is invalid.' }
        }
        $decisionRows = @($routeRows | Where-Object event -eq 'router_decision')
        $routeDecisionCount = $decisionRows.Count
        $routeFailureCount = @($routeRows | Where-Object event -eq 'router_failed').Count
        if ($routeGeneration -in @('binary-tool','explicit-binary-tool')) {
            $binaryRoutes = @($decisionRows | ForEach-Object { [string]$_.predicted_binary_route } | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) } | Sort-Object -Unique)
            $binaryRouteCounts = @($decisionRows | Group-Object predicted_binary_route | Sort-Object Name | ForEach-Object {
                [pscustomobject][ordered]@{binary_route=[string]$_.Name;count=[int]$_.Count}
            })
            $expectedLocalRoute = if ($routeGeneration -ceq 'explicit-binary-tool') {
                'local-router-explicit-binary-tool'
            } elseif ($ArmId -like 'router-binary-tool-effect-aware-strong-path-check-*') {
                'local-router-binary-tool-effect-aware-strong-path-check'
            } elseif ($ArmId -like 'router-binary-tool-effect-aware-*') {
                'local-router-binary-tool-effect-aware'
            } else {
                'local-router-binary-tool'
            }
            $localExecutionRows = @($events | Where-Object { $_.event -eq 'request_routed' -and [string]$_.route -ceq $expectedLocalRoute })
            $routeClasses = @($localExecutionRows | ForEach-Object { [string]$_.effective_route_class } | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) } | Sort-Object -Unique)
            $exactToolCounts = @($localExecutionRows | Group-Object actual_tool_name | Sort-Object Name | ForEach-Object {
                [pscustomobject][ordered]@{tool_name=[string]$_.Name;count=[int]$_.Count}
            })
        } else {
            $routeClasses = @($decisionRows | ForEach-Object { [string]$_.predicted_route_class } | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) } | Sort-Object -Unique)
        }
        $routePolicyVersion = $expectedPolicy
        if ($ArmId -like 'router-binary-tool-effect-aware-*') {
            $effectRows = @($decisionRows | Where-Object {
                [string]$_.route_state.ui_effect_policy_version -ceq 'g4-binary-ui-effect-aware-v1' -and
                $null -ne $_.route_state.last_transition -and
                [string]$_.route_state.last_transition.ui_effect -in @('UI_NEUTRAL_READ','NON_UI_STEP') -and
                [string]$_.route_state.last_transition.tool_name -notin @('android_health','adb_health','android_screenshot','adb_screenshot','android_ui_dump','adb_ui_dump_xml','android_ui_query','web_search','read')
            })
            $effectAwareTransitionCount = @($effectRows | ForEach-Object { [string]$_.route_state.last_transition.tool_call_id } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Sort-Object -Unique).Count
        }
        $strongPathRows = @($events | Where-Object event -eq 'strong_path_check_applied')
        if ($ArmId -notlike 'router-binary-tool-effect-aware-strong-path-check-*' -and $strongPathRows.Count -ne 0) {
            throw 'A non-Strong-Path arm contains Strong-Path Check evidence.'
        }
        foreach ($row in $strongPathRows) {
            if ([string]$row.check.check_version -cne 'g4-binary-strong-path-check-v1' -or [int]$row.check.successful_ui_action_count_before -ne 0) {
                throw 'Strong-Path Check evidence has the wrong version or was applied after UI entry.'
            }
            $requestId = [string]$row.request_id
            $cloudCalls = @($calls | Where-Object { [string]$_.proxy_request_id -ceq $requestId -and [string]$_.call_role -ceq 'cloud_agent' -and $_.strong_path_check_applied -eq $true })
            if ($cloudCalls.Count -ne 1) { throw 'Strong-Path Check does not join exactly one tagged Cloud Agent call.' }
            $strongPathCheckDetails += [pscustomobject][ordered]@{
                request_id=$requestId
                trigger=[string]$row.check.trigger
                cloud_tool_names=@(Get-V4CompletionToolNames -ParsedResponse $cloudCalls[0].parsed_response)
            }
        }
        $strongPathCheckExposureCount = $strongPathRows.Count
        $localBackendSelectionCount = @($decisionRows | Where-Object final_backend -eq 'local').Count
        $acceptedLocalCallCount = @($events | Where-Object { $_.event -eq 'request_routed' -and [string]$_.route -like 'local-router-*' }).Count
        $rawValidLocalCallCount = $acceptedLocalCallCount
        $localValidationFailureCount = @($events | Where-Object event -eq 'local_validation_failed').Count
        $localFailureRows = @($events | Where-Object event -eq 'local_validation_failed')
        $localValidationFailureReasonCounts = @($localFailureRows | ForEach-Object {
            if ($_.PSObject.Properties.Name -contains 'validation_reason' -and -not [string]::IsNullOrWhiteSpace([string]$_.validation_reason)) { [string]$_.validation_reason }
            elseif ($_.PSObject.Properties.Name -contains 'error_code' -and -not [string]::IsNullOrWhiteSpace([string]$_.error_code)) { 'provider_error:' + [string]$_.error_code }
            elseif ($_.PSObject.Properties.Name -contains 'upstream_status') { 'provider_http:' + [string]$_.upstream_status }
            else { 'unknown' }
        } | Group-Object | Sort-Object Name | ForEach-Object { [pscustomobject][ordered]@{reason=[string]$_.Name;count=[int]$_.Count} })
        $routeClassSource = if ($routeGeneration -in @('binary-tool','explicit-binary-tool')) {
            $expectedLocalRoute = if ($routeGeneration -ceq 'explicit-binary-tool') {
                'local-router-explicit-binary-tool'
            } elseif ($ArmId -like 'router-binary-tool-effect-aware-strong-path-check-*') {
                'local-router-binary-tool-effect-aware-strong-path-check'
            } elseif ($ArmId -like 'router-binary-tool-effect-aware-*') {
                'local-router-binary-tool-effect-aware'
            } else {
                'local-router-binary-tool'
            }
            @($events | Where-Object { $_.event -eq 'request_routed' -and [string]$_.route -ceq $expectedLocalRoute })
        } else { $decisionRows }
        $routeClassProperty = if ($routeGeneration -in @('binary-tool','explicit-binary-tool')) { 'effective_route_class' } else { 'predicted_route_class' }
        $routeClassCounts = @($routeClassSource | Group-Object -Property $routeClassProperty | Sort-Object Name | ForEach-Object {
            [pscustomobject][ordered]@{route_class=[string]$_.Name;count=[int]$_.Count}
        })
        if ($routeGeneration -in @('rm-scoped','fsm-scoped','fsm-scoped-repair','binary-tool','explicit-binary-tool')) {
            $expectedScopedContext = if ($routeGeneration -in @('binary-tool','explicit-binary-tool')) { 'coarse-local-tool-union-v1' } else { 'scoped-local-static-affordance-v1' }
            foreach ($row in $decisionRows) {
                if ([string]$row.scoped_context_version -cne $expectedScopedContext) {
                    throw 'Scoped Router decision does not identify SC-v1.'
                }
            }
            $scopedLocalRows = @($events | Where-Object { $_.event -eq 'request_routed' -and [string]$_.route -like 'local-router-*' })
            foreach ($row in $scopedLocalRows) {
                if ([string]$row.scoped_context_version -cne $expectedScopedContext) {
                    throw 'Scoped Local execution does not identify SC-v1.'
                }
            }
        }
        if ($routeGeneration -in @('fsm-scoped','fsm-scoped-repair','binary-tool','explicit-binary-tool')) {
            $localClasses = @('OBSERVE_UI_RAW','QUERY_UI_GROUNDED','INTERACT_UI_GROUNDED')
            foreach ($row in $decisionRows) {
                if (-not ($row.PSObject.Properties.Name -contains 'fsm_admissible_route_classes') -or $null -eq $row.fsm_admissible_route_classes) {
                    throw 'FSM Router decision lacks its prediction-time admissible RouteClass set.'
                }
                $admissibleLocal = @($row.fsm_admissible_route_classes | Where-Object { [string]$_ -in $localClasses } | Sort-Object -Unique)
                if ($admissibleLocal.Count -lt $localClasses.Count) { $fsmAdmissibilityRestrictionCount++ }
            }
            $fsmTransitionPendingCount = @($events | Where-Object event -eq 'fsm_transition_pending').Count
            $resolvedRows = @($events | Where-Object event -eq 'fsm_transition_resolved')
            $fsmTransitionResolvedCount = $resolvedRows.Count
            $fsmTransitionMatchCount = @($resolvedRows | Where-Object { $_.transition_resolution.ok -eq $true -and [string]$_.transition_resolution.reason -ceq 'fsm_transition_matched' }).Count
            $fsmForcedCloudHandoffCount = @($resolvedRows | Where-Object { $_.transition_resolution.ok -eq $false }).Count
            if ($fsmTransitionResolvedCount -gt $fsmTransitionPendingCount) {
                throw 'FSM capture resolves more transitions than it created.'
            }
            if (($fsmTransitionMatchCount + $fsmForcedCloudHandoffCount) -ne $fsmTransitionResolvedCount) {
                throw 'FSM transition resolutions are not completely classified.'
            }
        }
        if ($routeGeneration -in @('fsm-scoped-repair','binary-tool','explicit-binary-tool')) {
            $attemptRows = @($events | Where-Object event -eq 'local_repair_attempted')
            $appliedRows = @($events | Where-Object event -eq 'local_repair_applied')
            $rejectedRows = @($events | Where-Object event -eq 'local_repair_rejected')
            $expectedRepairRoute = if ($routeGeneration -ceq 'explicit-binary-tool') {
                'local-router-explicit-binary-tool'
            } elseif ($ArmId -like 'router-binary-tool-effect-aware-strong-path-check-*') {
                'local-router-binary-tool-effect-aware-strong-path-check'
            } elseif ($ArmId -like 'router-binary-tool-effect-aware-*') {
                'local-router-binary-tool-effect-aware'
            } elseif ($routeGeneration -ceq 'binary-tool') {
                'local-router-binary-tool'
            } else {
                'local-router-fsm-scoped-repair'
            }
            $executedRepairRows = @($events | Where-Object { $_.event -eq 'request_routed' -and [string]$_.route -ceq $expectedRepairRoute -and ($_.PSObject.Properties.Name -contains 'repair') -and $null -ne $_.repair -and $_.repair.applied -eq $true })
            $repairAttemptCount = $attemptRows.Count
            $repairAppliedCount = $appliedRows.Count
            $repairRejectedCount = $rejectedRows.Count
            $repairAssistedValidLocalCallCount = $executedRepairRows.Count
            $rawValidLocalCallCount = $acceptedLocalCallCount - $repairAssistedValidLocalCallCount
            if ($rawValidLocalCallCount -lt 0) { throw 'Repair-assisted Local calls exceed all accepted Local calls.' }
            if (($appliedRows.Count + $rejectedRows.Count) -ne $repairAttemptCount) {
                throw 'Repair capture does not classify every attempted repair exactly once.'
            }
            foreach ($appliedRow in $appliedRows) {
                $repairRequestId = [string]$appliedRow.request_id
                $localDestinations = @($executedRepairRows | Where-Object { [string]$_.request_id -ceq $repairRequestId })
                $strongDestinations = @()
                if ($ArmId -like 'router-binary-tool-effect-aware-strong-path-check-*') {
                    $strongDestinations = @($events | Where-Object {
                        [string]$_.request_id -ceq $repairRequestId -and
                        $_.event -eq 'strong_path_check_applied' -and
                        $_.check.repair_applied -eq $true -and
                        $_.check.base_tool_schema_valid -eq $true -and
                        $_.check.finite_route_and_fsm_dependency_valid -eq $true
                    })
                    $strongCloudRoutes = @($events | Where-Object {
                        [string]$_.request_id -ceq $repairRequestId -and
                        $_.event -eq 'request_routed' -and
                        [string]$_.route -ceq 'cloud-router-binary-tool-effect-aware-strong-path-check-ui-entrance-check'
                    })
                    if ($strongDestinations.Count -ne $strongCloudRoutes.Count) {
                        throw 'A Strong-Path intercepted repair does not join exactly one Cloud route.'
                    }
                }
                if (($localDestinations.Count + $strongDestinations.Count) -ne 1) {
                    throw 'A repaired candidate was not routed exactly once after full revalidation.'
                }
                $repairInterceptedAfterRevalidationCount += $strongDestinations.Count
            }
            foreach ($row in $attemptRows) {
                $repairRouteClass = if ($routeGeneration -in @('binary-tool','explicit-binary-tool')) { [string]$row.effective_route_class } else { [string]$row.predicted_route_class }
                if ([string]$row.repair_policy_version -cne 'g4-fsm-scoped-context-standard-moderate-repair-v1' -or $repairRouteClass -cnotin @('OBSERVE_UI_RAW','QUERY_UI_GROUNDED','INTERACT_UI_GROUNDED')) {
                    throw 'Standard Moderate Repair attempt identity or RouteClass is invalid.'
                }
                $terminal = @($events | Where-Object { [string]$_.request_id -ceq [string]$row.request_id -and $_.event -in @('local_repair_applied','local_repair_rejected') })
                if ($terminal.Count -ne 1) { throw 'Standard Moderate Repair attempt lacks exactly one terminal record.' }
                if ($null -eq $row.original_candidate) { throw 'Repair attempt does not preserve the original candidate.' }
                if ([string]$terminal[0].event -ceq 'local_repair_applied') {
                    if ([string]$row.repair_reason -cne 'standard_moderate_repair_compiled' -or $null -eq $row.proposed_candidate -or @($row.deterministic_transformations).Count -lt 1) {
                        throw 'Applied Standard Moderate Repair lacks a compiled candidate or deterministic transformation facts.'
                    }
                } elseif ($null -ne $row.proposed_candidate -and @($row.deterministic_transformations).Count -lt 1) {
                    throw 'Rejected repair proposal lacks its deterministic transformation facts.'
                }
            }
            foreach ($row in $executedRepairRows) {
                $repair = $row.repair
                if ([string]$repair.policy_version -cne 'g4-fsm-scoped-context-standard-moderate-repair-v1' -or [string]$repair.reason -cne 'standard_moderate_repair_compiled') {
                    throw 'Executed Standard Moderate Repair evidence differs from the frozen policy.'
                }
                if ($null -eq $repair.original_candidate -or $null -eq $repair.repaired_candidate -or [string]$repair.original_candidate.id -cne [string]$repair.repaired_candidate.id -or [string]$repair.original_candidate.type -cne [string]$repair.repaired_candidate.type -or [string]$repair.original_candidate.function.name -cne [string]$repair.repaired_candidate.function.name) {
                    throw 'Standard Moderate Repair changed the Tool identity or lost a candidate.'
                }
                if (@($repair.deterministic_transformations).Count -lt 1 -or $repair.revalidation.base_tool_schema.ok -ne $true -or $repair.revalidation.finite_route_and_fsm_dependency.ok -ne $true) {
                    throw 'Executed Standard Moderate Repair lacks complete successful revalidation.'
                }
                $attempt = @($attemptRows | Where-Object request_id -CEQ ([string]$row.request_id))
                $applied = @($appliedRows | Where-Object request_id -CEQ ([string]$row.request_id))
                if ($attempt.Count -ne 1 -or $applied.Count -ne 1) { throw 'Executed Standard Moderate Repair is not joined one-to-one with its attempt and revalidation.' }
            }
            $reclassifiedRows = @($events | Where-Object event -eq 'local_route_reclassification_applied')
            $reclassificationRejectedRows = @($events | Where-Object event -eq 'local_route_reclassification_rejected')
            $routeReclassificationAppliedCount = $reclassifiedRows.Count
            $routeReclassificationRejectedCount = $reclassificationRejectedRows.Count
            $toolToClass = @{
                android_screenshot='OBSERVE_UI_RAW';adb_screenshot='OBSERVE_UI_RAW';android_ui_dump='OBSERVE_UI_RAW';adb_ui_dump_xml='OBSERVE_UI_RAW'
                android_ui_query='QUERY_UI_GROUNDED';android_tap='INTERACT_UI_GROUNDED';adb_tap='INTERACT_UI_GROUNDED'
            }
            foreach ($row in $reclassifiedRows) {
                if ([string]$row.route_flex_condition -notin @('C1','C2') -or $row.applied -ne $true -or [string]$row.predicted_route_class -ceq [string]$row.effective_route_class) {
                    throw 'Applied Local RouteClass reclassification has invalid condition or class identity.'
                }
                $toolName = [string]$row.actual_tool_name
                if (-not $toolToClass.ContainsKey($toolName) -or [string]$toolToClass[$toolName] -cne [string]$row.effective_route_class) {
                    throw 'Applied Local RouteClass reclassification does not match the exact returned Tool.'
                }
                if ($row.base_tool_schema.ok -ne $true -or $row.finite_route_and_fsm_dependency.ok -ne $true) {
                    throw 'Applied Local RouteClass reclassification lacks complete successful validation.'
                }
                $executed = @($events | Where-Object { $_.event -eq 'request_routed' -and [string]$_.request_id -ceq [string]$row.request_id -and $_.route_class_reclassified -eq $true -and [string]$_.effective_route_class -ceq [string]$row.effective_route_class })
                if ($executed.Count -ne 1) { throw 'Applied Local RouteClass reclassification did not execute exactly once.' }
            }
            $c1ReclassificationExecutionCount = @($reclassifiedRows | Where-Object route_flex_condition -CEQ 'C1').Count
            $c2AddedExecutionCount = @($reclassifiedRows | Where-Object route_flex_condition -CEQ 'C2').Count

            $isCloudFirstArm = [string]$ArmId -ceq 'router-fsm-scoped-repair-cloud-first-dsv4-agent-dsv4-qwen36-logical-local'
            $gateRows = @($events | Where-Object event -eq 'cloud_first_ui_mutation_gate_triggered')
            if (-not $isCloudFirstArm -and $gateRows.Count -ne 0) {
                throw 'Baseline Repair arm contains a Cloud-first suppression gate event.'
            }
            foreach ($gateRow in $gateRows) {
                if ([string]$gateRow.gate.gate_version -cne 'g4-fsm-scoped-repair-cloud-first-ui-mutation-v1' -or $gateRow.gate.base_tool_schema_valid -ne $true -or $gateRow.gate.finite_route_and_fsm_dependency_valid -ne $true -or [int]$gateRow.gate.successful_ui_mutation_count_before -ne 0) {
                    throw 'Cloud-first gate did not suppress a fully validated first UI mutation.'
                }
                $requestId = [string]$gateRow.request_id
                $cloudCalls = @($calls | Where-Object { [string]$_.proxy_request_id -ceq $requestId -and [string]$_.call_role -ceq 'cloud_agent' -and $_.cloud_first_gate_triggered -eq $true })
                if ($cloudCalls.Count -ne 1) { throw 'Cloud-first gate does not join exactly one tagged Cloud Agent call.' }
                $localRoutes = @($events | Where-Object { $_.event -eq 'request_routed' -and [string]$_.request_id -ceq $requestId -and [string]$_.route -like 'local-router-*' })
                if ($localRoutes.Count -ne 0) { throw 'Cloud-first suppressed Local candidate was also routed to Local.' }
                $toolNames = @(Get-V4CompletionToolNames -ParsedResponse $cloudCalls[0].parsed_response)
                $category = Get-V4CloudFollowupCategory -ToolNames $toolNames
                switch ($category) {
                    'UI' { $cloudFirstFollowupUiCount++ }
                    'PROVIDER' { $cloudFirstFollowupProviderCount++ }
                    'SHELL' { $cloudFirstFollowupShellCount++ }
                    'NO_TOOL' { $cloudFirstFollowupNoToolCount++ }
                    'MIXED' { $cloudFirstFollowupMixedCount++ }
                    default { throw "Unknown Cloud-first follow-up category: $category" }
                }
                $cloudFirstFollowupDetails += [pscustomobject][ordered]@{
                    request_id=$requestId
                    local_candidate_tool=[string]$gateRow.gate.candidate_tool_name
                    cloud_tool_names=$toolNames
                    cloud_followup_category=$category
                }
            }
            $cloudFirstGateTriggerCount = $gateRows.Count
        }
    }
    return [pscustomobject][ordered]@{
        structurally_healthy = $true
        record_count = $records.Count
        proxy_request_count = $inbound.Count
        model_call_count = $calls.Count
        response_record_count = @($records | Where-Object { $_.PSObject.Properties.Name -contains 'raw_response_base64' }).Count
        call_roles = @($calls.call_role | Sort-Object -Unique)
        service_roles = @($calls.service_role | Sort-Object -Unique)
        route_policy_version = $routePolicyVersion
        route_decision_count = $routeDecisionCount
        route_failure_count = $routeFailureCount
        predicted_binary_routes = $binaryRoutes
        binary_route_counts = $binaryRouteCounts
        exact_tool_counts = $exactToolCounts
        predicted_route_classes = $routeClasses
        route_class_counts = $routeClassCounts
        local_backend_selection_count = $localBackendSelectionCount
        local_agent_call_count = $localAgentCallCount
        cloud_agent_call_count = $cloudAgentCallCount
        accepted_local_call_count = $acceptedLocalCallCount
        local_validation_failure_count = $localValidationFailureCount
        invalid_local_candidate_count = $localValidationFailureCount
        local_validation_failure_reason_counts = $localValidationFailureReasonCounts
        route_reclassification_applied_count = $routeReclassificationAppliedCount
        route_reclassification_rejected_count = $routeReclassificationRejectedCount
        c1_reclassification_execution_count = $c1ReclassificationExecutionCount
        c2_added_execution_count = $c2AddedExecutionCount
        fsm_admissibility_restriction_count = $fsmAdmissibilityRestrictionCount
        fsm_transition_pending_count = $fsmTransitionPendingCount
        fsm_transition_resolved_count = $fsmTransitionResolvedCount
        fsm_transition_match_count = $fsmTransitionMatchCount
        fsm_forced_cloud_handoff_count = $fsmForcedCloudHandoffCount
        repair_attempt_count = $repairAttemptCount
        repair_applied_count = $repairAppliedCount
        repair_rejected_count = $repairRejectedCount
        raw_valid_local_call_count = $rawValidLocalCallCount
        repair_assisted_valid_local_call_count = $repairAssistedValidLocalCallCount
        repair_intercepted_after_revalidation_count = $repairInterceptedAfterRevalidationCount
        cloud_first_gate_trigger_count = $cloudFirstGateTriggerCount
        cloud_first_followup_ui_count = $cloudFirstFollowupUiCount
        cloud_first_followup_provider_count = $cloudFirstFollowupProviderCount
        cloud_first_followup_shell_count = $cloudFirstFollowupShellCount
        cloud_first_followup_no_tool_count = $cloudFirstFollowupNoToolCount
        cloud_first_followup_mixed_count = $cloudFirstFollowupMixedCount
        cloud_first_followup_details = $cloudFirstFollowupDetails
        effect_aware_transition_count = $effectAwareTransitionCount
        strong_path_check_exposure_count = $strongPathCheckExposureCount
        strong_path_check_details = $strongPathCheckDetails
    }
}

Export-ModuleMember -Function Write-V4JsonExclusive,New-V4CellClaim,Read-V4Result,Wait-V4ProxyCapture,Copy-V4RemoteFileVerified,Copy-V4CaptureEvidence,Test-V4Capture
