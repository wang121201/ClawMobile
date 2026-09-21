[CmdletBinding()]
param(
    [Parameter(Mandatory)] [ValidateSet('Smoke','Formal')] [string] $Stage,
    [string] $ConfigPath,
    [string] $OutputRoot,
    [string] $GroupRunId,
    [string] $GroupId,
    [string] $SmokeGatePath,
    [string] $PythonPath = 'D:\APPPrograms\miniconda\python.exe',
    [string] $ClawBenchRoot,
    [string] $RemoteCaptureRoot,
    [ValidateRange(0,240)] [int] $StartSchedule = 0,
    [ValidateRange(0,240)] [int] $EndSchedule = 0,
    [switch] $ValidateOnly
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($ConfigPath)) { $ConfigPath = Join-Path $PSScriptRoot '..\configs\unified-five-group-experiment-v4.json' }
if ([string]::IsNullOrWhiteSpace($ClawBenchRoot)) { $ClawBenchRoot = Join-Path $PSScriptRoot '..\clawbench-runtime' }

Import-Module (Join-Path $PSScriptRoot 'PhoneEnvironment.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'Evidence.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'ExperimentCore.psm1') -Force

$expectedConfigs = @(
    [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\configs\unified-five-group-experiment-v4.json')),
    [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\configs\router-r1-r2-matched5-experiment-v1.json')),
    [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\configs\router-rm-matched5-experiment-v1.json')),
    [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\configs\router-rm-expanded15-experiment-v1.json')),
    [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\configs\router-r2-fsm-paired-experiment-v1.json')),
    [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\configs\router-r2-fsm-expanded15-paired-experiment-v1.json')),
    [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\configs\router-fsm-scoped-repair-expanded15-experiment-v1.json')),
    [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\configs\router-fsm-scoped-repair-qwen-router-expanded15-experiment-v1.json')),
    [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\configs\router-binary-tool-expanded15-experiment-v1.json')),
    [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\configs\router-explicit-binary-tool-expanded15-experiment-v1.json')),
    [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\configs\router-route-flex-tiny-preliminary-v1.json')),
    [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\configs\router-capability-suppression-experiment-v1.json')),
    [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\configs\router-capability-suppression-full-dsv4-comparator-v1.json')),
    [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\configs\router-binary-efficiency-tiny-experiment-v1.json')),
    [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\configs\g0-gpt55-expanded15-partial-experiment-v1.json'))
)
$resolvedConfig = [IO.Path]::GetFullPath($ConfigPath)
if (-not @($expectedConfigs | Where-Object { $_ -ceq $resolvedConfig })) {
    throw "v4 accepts only the authoritative configs: $($expectedConfigs -join '; ')"
}
$config = Get-Content -LiteralPath $resolvedConfig -Raw -Encoding UTF8 | ConvertFrom-Json
$null = Assert-V4Config -Config $config
$isPairedFsmDesign = [string]$config.design_id -in @('phone-a-router-r2-fsm-paired-v1','phone-a-router-r2-fsm-expanded15-paired-v1')
$isRepairDesign = [string]$config.design_id -in @('phone-a-router-fsm-scoped-repair-expanded15-v1','phone-a-router-fsm-scoped-repair-qwen-router-expanded15-v1','phone-a-router-binary-tool-expanded15-v1','phone-a-router-explicit-binary-tool-expanded15-v1')
$isRouteFlexTiny = [string]$config.design_id -ceq 'phone-a-router-route-flex-tiny-preliminary-v1'
$isCapabilitySuppression = [string]$config.design_id -ceq 'phone-a-router-capability-suppression-v1'
$isCapabilitySuppressionFullDsv4 = [string]$config.design_id -ceq 'phone-a-router-capability-suppression-full-dsv4-comparator-v1'
$isGpt55Partial = [string]$config.design_id -ceq 'phone-a-g0-gpt55-expanded15-partial-v1'
$isBinaryEfficiencyTiny = [string]$config.design_id -ceq 'phone-a-router-binary-efficiency-tiny-v1'
$isMultiConditionRouterDesign = $isPairedFsmDesign -or $isRouteFlexTiny -or $isCapabilitySuppression -or $isCapabilitySuppressionFullDsv4 -or $isBinaryEfficiencyTiny
$isRouterDesign = [string]$config.design_id -in @('phone-a-router-r1-r2-matched5-v1','phone-a-router-rm-matched5-v1','phone-a-router-rm-expanded15-v1','phone-a-router-r2-fsm-paired-v1','phone-a-router-r2-fsm-expanded15-paired-v1','phone-a-router-fsm-scoped-repair-expanded15-v1','phone-a-router-fsm-scoped-repair-qwen-router-expanded15-v1','phone-a-router-binary-tool-expanded15-v1','phone-a-router-explicit-binary-tool-expanded15-v1','phone-a-router-route-flex-tiny-preliminary-v1','phone-a-router-capability-suppression-v1','phone-a-router-capability-suppression-full-dsv4-comparator-v1','phone-a-router-binary-efficiency-tiny-v1')
if ($isRouterDesign -and -not $isMultiConditionRouterDesign) {
    $allowedRouterGroups = @($config.execution.group_order | ForEach-Object { [string]$_ })
    if ([string]::IsNullOrWhiteSpace($GroupId) -or [string]$GroupId -notin $allowedRouterGroups) {
        throw "Router execution requires -GroupId equal to one of: $($allowedRouterGroups -join ', ')."
    }
} elseif ($isMultiConditionRouterDesign -and -not [string]::IsNullOrWhiteSpace($GroupId)) {
    throw 'The multi-condition Router design executes its frozen order and does not accept -GroupId.'
} elseif (-not [string]::IsNullOrWhiteSpace($GroupId)) {
    throw '-GroupId is reserved for the Router R1/R2 design.'
}
$plan = @(Get-V4Plan -Config $config -Stage $Stage)
if ($isRouterDesign -and -not $isMultiConditionRouterDesign) {
    $plan = @($plan | Where-Object group_id -CEQ $GroupId)
    if ($plan.Count -eq 0) { throw "The Router plan contains no cells for $GroupId." }
}
if ($StartSchedule -gt 0) {
    if ($Stage -cne 'Formal') { throw '-StartSchedule is supported only for Formal schedules 1..240.' }
    $plan = @($plan | Where-Object { [int]$_.schedule -ge $StartSchedule })
    if ($plan.Count -eq 0) { throw "No formal cells remain at or after schedule $StartSchedule." }
}
if ($EndSchedule -gt 0) {
    if ($Stage -cne 'Formal') { throw '-EndSchedule is supported only for Formal schedules 1..240.' }
    if ($StartSchedule -gt 0 -and $EndSchedule -lt $StartSchedule) { throw '-EndSchedule must be greater than or equal to -StartSchedule.' }
    $plan = @($plan | Where-Object { [int]$_.schedule -le $EndSchedule })
    if ($plan.Count -eq 0) { throw "No formal cells remain at or before schedule $EndSchedule." }
}

if ($ValidateOnly) {
    [pscustomobject][ordered]@{
        validation='passed';schema_version=4;design_id=$config.design_id;stage=$Stage
        cell_count=$plan.Count;groups=@($plan.group_id | Select-Object -Unique)
        first_schedule=[int]$plan[0].schedule;last_schedule=[int]$plan[-1].schedule
        ordering=if($isMultiConditionRouterDesign){[string]$config.execution.within_study_order}else{'group-major_then_round-major'}
        infrastructure_failure_policy=[string]$config.execution.infrastructure_failure_policy
    } | ConvertTo-Json -Depth 10
    exit 0
}

if (-not (Test-Path -LiteralPath $PythonPath -PathType Leaf)) { throw "Python executable not found: $PythonPath" }
if (-not (Test-Path -LiteralPath $ClawBenchRoot -PathType Container)) { throw "ClawBench root not found: $ClawBenchRoot" }
if ([string]::IsNullOrWhiteSpace($OutputRoot) -or -not [IO.Path]::IsPathRooted($OutputRoot)) { throw 'Live v4 requires an absolute -OutputRoot.' }
$OutputRoot = [IO.Path]::GetFullPath($OutputRoot)
    $dataRoot = [IO.Path]::GetFullPath([string]$config.output_policy.data_root)
if (-not $OutputRoot.StartsWith($dataRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw "v4 output must be a new child under $dataRoot"
}
if (Test-Path -LiteralPath $OutputRoot) { throw "Output root already exists; v4 never overwrites: $OutputRoot" }
if ([string]::IsNullOrWhiteSpace($GroupRunId)) { $GroupRunId = ('v4-{0}-{1}' -f $Stage.ToLowerInvariant(),[DateTimeOffset]::UtcNow.ToString('yyyyMMddTHHmmssZ')) }
if ($GroupRunId -notmatch '^[A-Za-z0-9_.-]{8,128}$') { throw 'GroupRunId contains unsupported characters.' }
if ([string]::IsNullOrWhiteSpace($RemoteCaptureRoot)) {
    $RemoteCaptureRoot = if ($isRouterDesign -or $isGpt55Partial) { [string]$config.capture_contract.remote_capture_root } else { '/data/data/com.termux/files/home/clawmobile-experiments/expanded15-v4/active/captures' }
}
$expectedRemoteCaptureRoot = if ($isRouterDesign -or $isGpt55Partial) { [string]$config.capture_contract.remote_capture_root } else { '/data/data/com.termux/files/home/clawmobile-experiments/expanded15-v4/active/captures' }
if ($RemoteCaptureRoot -cne $expectedRemoteCaptureRoot) {
    throw "RemoteCaptureRoot must equal the active shared Proxy capture root: $expectedRemoteCaptureRoot"
}
if ($Stage -ceq 'Formal') {
    if ([string]::IsNullOrWhiteSpace($SmokeGatePath) -or -not (Test-Path -LiteralPath $SmokeGatePath -PathType Leaf)) {
        throw 'Formal execution requires the completed v4 Smoke gate path.'
    }
    $smokeGate = Get-Content -LiteralPath $SmokeGatePath -Raw -Encoding UTF8 | ConvertFrom-Json
    $expectedSmokeCells = if ($isPairedFsmDesign -or $isCapabilitySuppression -or $isCapabilitySuppressionFullDsv4 -or $isBinaryEfficiencyTiny -or $isGpt55Partial) { [int]$config.smoke.matrix_cell_count } elseif ($isRouterDesign) { [int]$config.smoke.cell_count_per_group } else { 4 }
    if ([int]$smokeGate.schema_version -ne 4 -or $smokeGate.passed -ne $true -or [int]$smokeGate.cell_count -ne $expectedSmokeCells -or [string]$smokeGate.design_id -cne [string]$config.design_id) {
        throw 'The supplied v4 Smoke gate is not healthy.'
    }
    if ($isRouterDesign -and -not $isPairedFsmDesign -and [string]$smokeGate.group_id -cne $GroupId) { throw 'The Smoke gate belongs to a different Router group.' }
    if ([string]$config.design_id -in @('phone-a-router-rm-matched5-v1','phone-a-router-rm-expanded15-v1','phone-a-router-r2-fsm-paired-v1','phone-a-router-r2-fsm-expanded15-paired-v1','phone-a-router-fsm-scoped-repair-expanded15-v1','phone-a-router-fsm-scoped-repair-qwen-router-expanded15-v1','phone-a-router-binary-tool-expanded15-v1','phone-a-router-explicit-binary-tool-expanded15-v1') -and ($smokeGate.mechanism_exposure_required -ne $true -or $smokeGate.mechanism_exposure_passed -ne $true)) {
        throw 'Router Formal requires a Smoke gate with real Local mechanism exposure.'
    }
    if ($isPairedFsmDesign -and ($smokeGate.fsm_admissibility_restriction_count -lt [int]$config.smoke.minimum_fsm_admissibility_restrictions -or $smokeGate.fsm_transition_match_count -lt [int]$config.smoke.minimum_fsm_transition_matches)) {
        throw 'R2-FSM Formal requires a paired Smoke gate with active admissibility and a matched result-bound transition.'
    }
    if ($isBinaryEfficiencyTiny -and ($smokeGate.effect_aware_transition_count -lt [int]$config.smoke.minimum_effect_aware_transitions -or $smokeGate.strong_path_check_exposure_count -lt [int]$config.smoke.minimum_strong_path_check_exposures)) {
        throw 'Binary Efficiency Tiny Formal requires real effect-aware and Strong-Path Check exposure in Smoke.'
    }
    if ($isRepairDesign -and ($smokeGate.repair_attempt_count -lt [int]$config.smoke.minimum_repair_attempts -or $smokeGate.repair_applied_count -lt [int]$config.smoke.minimum_repair_applied)) {
        throw 'Repair-only Formal requires a Smoke gate with a real bounded repair that passed complete revalidation.'
    }
    $currentConfigHash = (Get-FileHash -LiteralPath $resolvedConfig -Algorithm SHA256).Hash.ToLowerInvariant()
    if ([string]$smokeGate.config_sha256 -cne $currentConfigHash) { throw 'The Smoke gate was produced by different config bytes.' }
}

[IO.Directory]::CreateDirectory($OutputRoot) | Out-Null
$configHash = (Get-FileHash -LiteralPath $resolvedConfig -Algorithm SHA256).Hash.ToLowerInvariant()
$planRecord = [ordered]@{
    schema_version=4;record_type='campaign_plan';created_at=[DateTimeOffset]::UtcNow.ToString('o')
    design_id=$config.design_id;config_path=$resolvedConfig;config_sha256=$configHash
    group_run_id=$GroupRunId;stage=$Stage.ToLowerInvariant();ordering=if($isMultiConditionRouterDesign){[string]$config.execution.within_study_order}else{'group-major_then_round-major'}
    group_id=if($isRouterDesign -and -not $isMultiConditionRouterDesign){$GroupId}else{$null}
    full_formal_cell_count=if($Stage -ceq 'Formal'){[int]$config.formal.matrix_cell_count}else{if($isRouterDesign){[int]$config.smoke.matrix_cell_count}else{4}};selected_cell_count=$plan.Count
    start_schedule=if($StartSchedule -gt 0){$StartSchedule}else{[int]$plan[0].schedule}
    end_schedule=if($EndSchedule -gt 0){$EndSchedule}else{[int]$plan[-1].schedule}
    cell_count=$plan.Count;cells=$plan
}
$null = Write-V4JsonExclusive -Path (Join-Path $OutputRoot "campaign-plan.$($Stage.ToLowerInvariant()).json") -Value $planRecord

$environment = Assert-V4InvocationEnvironment -Config $config
$routerToken = Get-V4RouterClientToken -Device $config.device
$invocationStarted = [DateTimeOffset]::UtcNow
$statuses = [Collections.Generic.List[object]]::new()
$infrastructureFailureStatuses = [Collections.Generic.List[object]]::new()
foreach ($cell in $plan) {
    $status = Invoke-V4Cell -Config $config -Cell $cell -OutputRoot $OutputRoot -GroupRunId $GroupRunId -ExpectedBootId ([string]$environment.adb.boot_id) -RouterToken $routerToken -RemoteCaptureRoot $RemoteCaptureRoot -PythonPath $PythonPath -ClawBenchRoot $ClawBenchRoot
    $statuses.Add($status)
    [pscustomobject]@{schedule=$status.schedule;group=$status.group_id;task=$status.task_case;repetition=$status.repetition;classification=$status.classification;run_id=$status.result_run_id;elapsed_ms=$status.elapsed_ms} | ConvertTo-Json -Compress
    if ($status.experiment_infrastructure_failure -eq $true) {
        $infrastructureFailureStatuses.Add($status)
        break
    }
}

$invocation = [ordered]@{
    schema_version=4;record_type='invocation_status';group_run_id=$GroupRunId;stage=$Stage.ToLowerInvariant()
    started_at=$invocationStarted.ToString('o');completed_at=[DateTimeOffset]::UtcNow.ToString('o')
    planned_cell_count=$plan.Count;completed_status_count=$statuses.Count
    scored_success_count=@($statuses | Where-Object classification -eq 'primary_scored_success').Count
    scored_failure_count=@($statuses | Where-Object classification -eq 'primary_scored_failure').Count
    infrastructure_failure_count=@($statuses | Where-Object experiment_infrastructure_failure -eq $true).Count
    continued_after_infrastructure_failure=$false
    stopped_on_first_infrastructure_failure=($infrastructureFailureStatuses.Count -gt 0)
    stop_schedule=if($infrastructureFailureStatuses.Count -gt 0){[int]$infrastructureFailureStatuses[0].schedule}else{$null}
    stop_error=if($infrastructureFailureStatuses.Count -gt 0){$infrastructureFailureStatuses[0].error}else{$null}
    infrastructure_failure_policy='preserve_and_stop_current_group';environment=$environment
}
$null = Write-V4JsonExclusive -Path (Join-Path $OutputRoot "invocation.$($Stage.ToLowerInvariant()).json") -Value $invocation

if ($Stage -ceq 'Smoke' -and $statuses.Count -eq $plan.Count) {
    $metricStatuses = @($statuses | Where-Object {
        $null -ne $_.capture_validation -and
        $null -ne $_.capture_validation.PSObject.Properties['structurally_healthy']
    })
    $healthyCount = @($metricStatuses | Where-Object { $_.capture_validation.structurally_healthy -eq $true }).Count
    $infraCount = @($statuses | Where-Object experiment_infrastructure_failure -eq $true).Count
    $runIds = @($statuses.result_run_id)
    $routeFailureCount = 0
    $localBackendSelectionCount = 0
    $localAgentCallCount = 0
    $acceptedLocalCallCount = 0
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
    $cloudAgentCallCount = 0
    $totalLogicalRequestCount = 0
    $routeReclassificationAppliedCount = 0
    $routeReclassificationRejectedCount = 0
    $c1ReclassificationExecutionCount = 0
    $c2AddedExecutionCount = 0
    $cloudFirstGateTriggerCount = 0
    $cloudFirstFollowupUiCount = 0
    $cloudFirstFollowupProviderCount = 0
    $cloudFirstFollowupShellCount = 0
    $cloudFirstFollowupNoToolCount = 0
    $cloudFirstFollowupMixedCount = 0
    $effectAwareTransitionCount = 0
    $strongPathCheckExposureCount = 0
    foreach ($status in $metricStatuses) {
        $routeFailureCount += [int]$status.capture_validation.route_failure_count
        $localBackendSelectionCount += [int]$status.capture_validation.local_backend_selection_count
        $localAgentCallCount += [int]$status.capture_validation.local_agent_call_count
        $acceptedLocalCallCount += [int]$status.capture_validation.accepted_local_call_count
        $fsmAdmissibilityRestrictionCount += [int]$status.capture_validation.fsm_admissibility_restriction_count
        $fsmTransitionPendingCount += [int]$status.capture_validation.fsm_transition_pending_count
        $fsmTransitionResolvedCount += [int]$status.capture_validation.fsm_transition_resolved_count
        $fsmTransitionMatchCount += [int]$status.capture_validation.fsm_transition_match_count
        $fsmForcedCloudHandoffCount += [int]$status.capture_validation.fsm_forced_cloud_handoff_count
        $repairAttemptCount += [int]$status.capture_validation.repair_attempt_count
        $repairAppliedCount += [int]$status.capture_validation.repair_applied_count
        $repairRejectedCount += [int]$status.capture_validation.repair_rejected_count
        $rawValidLocalCallCount += [int]$status.capture_validation.raw_valid_local_call_count
        $repairAssistedValidLocalCallCount += [int]$status.capture_validation.repair_assisted_valid_local_call_count
        $repairInterceptedAfterRevalidationCount += [int]$status.capture_validation.repair_intercepted_after_revalidation_count
        $cloudAgentCallCount += [int]$status.capture_validation.cloud_agent_call_count
        $totalLogicalRequestCount += [int]$status.capture_validation.proxy_request_count
        $routeReclassificationAppliedCount += [int]$status.capture_validation.route_reclassification_applied_count
        $routeReclassificationRejectedCount += [int]$status.capture_validation.route_reclassification_rejected_count
        $c1ReclassificationExecutionCount += [int]$status.capture_validation.c1_reclassification_execution_count
        $c2AddedExecutionCount += [int]$status.capture_validation.c2_added_execution_count
        $cloudFirstGateTriggerCount += [int]$status.capture_validation.cloud_first_gate_trigger_count
        $cloudFirstFollowupUiCount += [int]$status.capture_validation.cloud_first_followup_ui_count
        $cloudFirstFollowupProviderCount += [int]$status.capture_validation.cloud_first_followup_provider_count
        $cloudFirstFollowupShellCount += [int]$status.capture_validation.cloud_first_followup_shell_count
        $cloudFirstFollowupNoToolCount += [int]$status.capture_validation.cloud_first_followup_no_tool_count
        $cloudFirstFollowupMixedCount += [int]$status.capture_validation.cloud_first_followup_mixed_count
        $effectAwareTransitionCount += [int]$status.capture_validation.effect_aware_transition_count
        $strongPathCheckExposureCount += [int]$status.capture_validation.strong_path_check_exposure_count
    }
    $armEvidence = @($metricStatuses | Group-Object group_id | Sort-Object Name | ForEach-Object {
        $armStatuses = @($_.Group)
        [pscustomobject][ordered]@{
            group_id=[string]$_.Name
            cell_count=$armStatuses.Count
            local_backend_selection_count=[int](($armStatuses | ForEach-Object { [int]$_.capture_validation.local_backend_selection_count } | Measure-Object -Sum).Sum)
            accepted_local_call_count=[int](($armStatuses | ForEach-Object { [int]$_.capture_validation.accepted_local_call_count } | Measure-Object -Sum).Sum)
            fsm_admissibility_restriction_count=[int](($armStatuses | ForEach-Object { [int]$_.capture_validation.fsm_admissibility_restriction_count } | Measure-Object -Sum).Sum)
            fsm_transition_match_count=[int](($armStatuses | ForEach-Object { [int]$_.capture_validation.fsm_transition_match_count } | Measure-Object -Sum).Sum)
            fsm_forced_cloud_handoff_count=[int](($armStatuses | ForEach-Object { [int]$_.capture_validation.fsm_forced_cloud_handoff_count } | Measure-Object -Sum).Sum)
            repair_attempt_count=[int](($armStatuses | ForEach-Object { [int]$_.capture_validation.repair_attempt_count } | Measure-Object -Sum).Sum)
            repair_applied_count=[int](($armStatuses | ForEach-Object { [int]$_.capture_validation.repair_applied_count } | Measure-Object -Sum).Sum)
            repair_rejected_count=[int](($armStatuses | ForEach-Object { [int]$_.capture_validation.repair_rejected_count } | Measure-Object -Sum).Sum)
            raw_valid_local_call_count=[int](($armStatuses | ForEach-Object { [int]$_.capture_validation.raw_valid_local_call_count } | Measure-Object -Sum).Sum)
            repair_assisted_valid_local_call_count=[int](($armStatuses | ForEach-Object { [int]$_.capture_validation.repair_assisted_valid_local_call_count } | Measure-Object -Sum).Sum)
            repair_intercepted_after_revalidation_count=[int](($armStatuses | ForEach-Object { [int]$_.capture_validation.repair_intercepted_after_revalidation_count } | Measure-Object -Sum).Sum)
            cloud_agent_call_count=[int](($armStatuses | ForEach-Object { [int]$_.capture_validation.cloud_agent_call_count } | Measure-Object -Sum).Sum)
            total_logical_request_count=[int](($armStatuses | ForEach-Object { [int]$_.capture_validation.proxy_request_count } | Measure-Object -Sum).Sum)
            invalid_local_candidate_count=[int](($armStatuses | ForEach-Object { [int]$_.capture_validation.invalid_local_candidate_count } | Measure-Object -Sum).Sum)
            route_reclassification_applied_count=[int](($armStatuses | ForEach-Object { [int]$_.capture_validation.route_reclassification_applied_count } | Measure-Object -Sum).Sum)
            route_reclassification_rejected_count=[int](($armStatuses | ForEach-Object { [int]$_.capture_validation.route_reclassification_rejected_count } | Measure-Object -Sum).Sum)
            c1_reclassification_execution_count=[int](($armStatuses | ForEach-Object { [int]$_.capture_validation.c1_reclassification_execution_count } | Measure-Object -Sum).Sum)
            c2_added_execution_count=[int](($armStatuses | ForEach-Object { [int]$_.capture_validation.c2_added_execution_count } | Measure-Object -Sum).Sum)
            cloud_first_gate_trigger_count=[int](($armStatuses | ForEach-Object { [int]$_.capture_validation.cloud_first_gate_trigger_count } | Measure-Object -Sum).Sum)
            cloud_first_followup_ui_count=[int](($armStatuses | ForEach-Object { [int]$_.capture_validation.cloud_first_followup_ui_count } | Measure-Object -Sum).Sum)
            cloud_first_followup_provider_count=[int](($armStatuses | ForEach-Object { [int]$_.capture_validation.cloud_first_followup_provider_count } | Measure-Object -Sum).Sum)
            cloud_first_followup_shell_count=[int](($armStatuses | ForEach-Object { [int]$_.capture_validation.cloud_first_followup_shell_count } | Measure-Object -Sum).Sum)
            effect_aware_transition_count=[int](($armStatuses | ForEach-Object { [int]$_.capture_validation.effect_aware_transition_count } | Measure-Object -Sum).Sum)
            strong_path_check_exposure_count=[int](($armStatuses | ForEach-Object { [int]$_.capture_validation.strong_path_check_exposure_count } | Measure-Object -Sum).Sum)
        }
    })
    $requiresMechanismExposure = [string]$config.design_id -in @('phone-a-router-rm-matched5-v1','phone-a-router-rm-expanded15-v1','phone-a-router-r2-fsm-paired-v1','phone-a-router-r2-fsm-expanded15-paired-v1','phone-a-router-fsm-scoped-repair-expanded15-v1','phone-a-router-fsm-scoped-repair-qwen-router-expanded15-v1','phone-a-router-binary-tool-expanded15-v1','phone-a-router-explicit-binary-tool-expanded15-v1','phone-a-router-route-flex-tiny-preliminary-v1','phone-a-router-binary-efficiency-tiny-v1')
    $c1InterventionTaskIds = @($metricStatuses | Where-Object { [string]$_.group_id -ceq 'C1' -and [int]$_.capture_validation.c1_reclassification_execution_count -gt 0 } | ForEach-Object { ([string]$_.task_case -split ':')[0] } | Sort-Object -Unique)
    $c2InterventionTaskIds = @($metricStatuses | Where-Object { [string]$_.group_id -ceq 'C2' -and [int]$_.capture_validation.c2_added_execution_count -gt 0 } | ForEach-Object { ([string]$_.task_case -split ':')[0] } | Sort-Object -Unique)
    $acceptedLocalTaskIds = @($metricStatuses | Where-Object { [int]$_.capture_validation.accepted_local_call_count -gt 0 } | ForEach-Object { ([string]$_.task_case -split ':')[0] } | Sort-Object -Unique)
    if ($isBinaryEfficiencyTiny) {
        $mechanismExposurePassed = (
            $routeFailureCount -eq 0 -and
            $effectAwareTransitionCount -ge [int]$config.smoke.minimum_effect_aware_transitions -and
            $strongPathCheckExposureCount -ge [int]$config.smoke.minimum_strong_path_check_exposures
        )
    } elseif ($isRouteFlexTiny) {
        $mechanismExposurePassed = (
            $routeFailureCount -eq 0 -and
            $c1InterventionTaskIds.Count -ge [int]$config.smoke.minimum_c1_intervention_tasks -and
            $c2InterventionTaskIds.Count -ge [int]$config.smoke.minimum_c2_intervention_tasks
        )
    } elseif ($isPairedFsmDesign) {
        $rmEvidence = @($armEvidence | Where-Object group_id -CEQ 'G4-RM-SC')
        $fsmEvidence = @($armEvidence | Where-Object group_id -CEQ 'G4-FSM-SC')
        $mechanismExposurePassed = (
            $routeFailureCount -eq 0 -and
            $rmEvidence.Count -eq 1 -and $fsmEvidence.Count -eq 1 -and
            [int]$rmEvidence[0].cell_count -eq [int]$config.smoke.cell_count_per_group -and
            [int]$fsmEvidence[0].cell_count -eq [int]$config.smoke.cell_count_per_group -and
            [int]$rmEvidence[0].local_backend_selection_count -ge [int]$config.smoke.minimum_local_backend_selections_per_group -and
            [int]$fsmEvidence[0].local_backend_selection_count -ge [int]$config.smoke.minimum_local_backend_selections_per_group -and
            [int]$rmEvidence[0].accepted_local_call_count -ge [int]$config.smoke.minimum_accepted_local_calls_per_group -and
            [int]$fsmEvidence[0].accepted_local_call_count -ge [int]$config.smoke.minimum_accepted_local_calls_per_group -and
            $fsmAdmissibilityRestrictionCount -ge [int]$config.smoke.minimum_fsm_admissibility_restrictions -and
            $fsmTransitionMatchCount -ge [int]$config.smoke.minimum_fsm_transition_matches
        )
    } elseif ($isRepairDesign) {
        $minimumDistinctAcceptedTasks = if ([string]$config.design_id -in @('phone-a-router-binary-tool-expanded15-v1','phone-a-router-explicit-binary-tool-expanded15-v1')) { [int]$config.smoke.minimum_distinct_tasks_with_accepted_local } else { 0 }
        $mechanismExposurePassed = (
            $routeFailureCount -eq 0 -and
            $localBackendSelectionCount -ge [int]$config.smoke.minimum_local_backend_selections -and
            $localAgentCallCount -ge 1 -and
            $acceptedLocalCallCount -ge [int]$config.smoke.minimum_accepted_local_calls -and
            $fsmAdmissibilityRestrictionCount -ge [int]$config.smoke.minimum_fsm_admissibility_restrictions -and
            $fsmTransitionMatchCount -ge [int]$config.smoke.minimum_fsm_transition_matches -and
            $repairAttemptCount -ge [int]$config.smoke.minimum_repair_attempts -and
            $repairAppliedCount -ge [int]$config.smoke.minimum_repair_applied -and
            $acceptedLocalTaskIds.Count -ge $minimumDistinctAcceptedTasks
        )
    } else {
        $mechanismExposurePassed = -not $requiresMechanismExposure -or (
            $routeFailureCount -eq 0 -and
            $localBackendSelectionCount -ge [int]$config.smoke.minimum_local_backend_selections -and
            $localAgentCallCount -ge 1 -and
            $acceptedLocalCallCount -ge [int]$config.smoke.minimum_accepted_local_calls
        )
    }
    $gate = [ordered]@{
        schema_version=4;record_type='smoke_gate';written_at=[DateTimeOffset]::UtcNow.ToString('o')
        design_id=$config.design_id;config_sha256=$configHash
        passed=($healthyCount -eq $plan.Count -and $infraCount -eq 0 -and @($runIds | Sort-Object -Unique).Count -eq $plan.Count -and $mechanismExposurePassed)
        cell_count=$plan.Count;group_run_id=$GroupRunId;group_id=if($isRouterDesign -and -not $isMultiConditionRouterDesign){$GroupId}else{$null}
        groups=@($statuses.group_id);result_run_ids=$runIds
        structurally_healthy_count=$healthyCount;infrastructure_failure_count=$infraCount
        mechanism_exposure_required=$requiresMechanismExposure;mechanism_exposure_passed=$mechanismExposurePassed
        route_failure_count=$routeFailureCount;local_backend_selection_count=$localBackendSelectionCount
        local_agent_call_count=$localAgentCallCount;accepted_local_call_count=$acceptedLocalCallCount
        fsm_admissibility_restriction_count=$fsmAdmissibilityRestrictionCount
        fsm_transition_pending_count=$fsmTransitionPendingCount
        fsm_transition_resolved_count=$fsmTransitionResolvedCount
        fsm_transition_match_count=$fsmTransitionMatchCount
        fsm_forced_cloud_handoff_count=$fsmForcedCloudHandoffCount
        repair_attempt_count=$repairAttemptCount
        repair_applied_count=$repairAppliedCount
        repair_rejected_count=$repairRejectedCount
        raw_valid_local_call_count=$rawValidLocalCallCount
        repair_assisted_valid_local_call_count=$repairAssistedValidLocalCallCount
        repair_intercepted_after_revalidation_count=$repairInterceptedAfterRevalidationCount
        cloud_agent_call_count=$cloudAgentCallCount
        total_logical_request_count=$totalLogicalRequestCount
        route_reclassification_applied_count=$routeReclassificationAppliedCount
        route_reclassification_rejected_count=$routeReclassificationRejectedCount
        c1_reclassification_execution_count=$c1ReclassificationExecutionCount
        c2_added_execution_count=$c2AddedExecutionCount
        c1_intervention_task_ids=$c1InterventionTaskIds
        c2_intervention_task_ids=$c2InterventionTaskIds
        accepted_local_task_ids=$acceptedLocalTaskIds
        cloud_first_gate_trigger_count=$cloudFirstGateTriggerCount
        cloud_first_followup_ui_count=$cloudFirstFollowupUiCount
        cloud_first_followup_provider_count=$cloudFirstFollowupProviderCount
        cloud_first_followup_shell_count=$cloudFirstFollowupShellCount
        cloud_first_followup_no_tool_count=$cloudFirstFollowupNoToolCount
        cloud_first_followup_mixed_count=$cloudFirstFollowupMixedCount
        effect_aware_transition_count=$effectAwareTransitionCount
        strong_path_check_exposure_count=$strongPathCheckExposureCount
        arm_evidence=$armEvidence
    }
    $null = Write-V4JsonExclusive -Path (Join-Path $OutputRoot 'smoke-gate.json') -Value $gate
}

exit 0
