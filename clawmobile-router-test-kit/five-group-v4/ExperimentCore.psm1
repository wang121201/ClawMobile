Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-V4Config {
    [CmdletBinding()]
    param([Parameter(Mandatory)] [pscustomobject] $Config)

    $rmDesignId = [string]$Config.design_id
    $isBinaryEfficiencyTiny = $rmDesignId -ceq 'phone-a-router-binary-efficiency-tiny-v1'
    if ([int]$Config.schema_version -eq 4 -and $isBinaryEfficiencyTiny) {
        if ([string]$Config.device.device_id -cne 'phone-a' -or [string]$Config.device.ssh_host -cne '10.127.121.62') {
            throw 'Binary Efficiency Tiny requires only Phone A at 10.127.121.62.'
        }
        if ([int]$Config.execution.maximum_controllers -ne 1 -or [int]$Config.execution.maximum_active_cells -ne 1 -or [int]$Config.execution.maximum_request_chains -ne 1) {
            throw 'Binary Efficiency Tiny requires one controller, one active Cell, and one request chain.'
        }
        if ((@($Config.execution.condition_order) -join ',') -cne 'Binary-Control,Binary-Effect-Aware,Binary-Effect-Aware-StrongPathCheck' -or [string]$Config.execution.within_study_order -cne 'arm-major_then_round-major_fixed_task_order') {
            throw 'Binary Efficiency Tiny arm identity or ordering changed.'
        }
        if ([string]$Config.execution.infrastructure_failure_policy -cne 'preserve_and_stop_current_group') {
            throw 'Binary Efficiency Tiny must fail fast on infrastructure failure.'
        }
        $expectedGroups = @(
            'Binary-Control|router-binary-tool-dsv4-agent-dsv4-qwen36-logical-local|6|1|6',
            'Binary-Effect-Aware|router-binary-tool-effect-aware-dsv4-agent-dsv4-qwen36-logical-local|6|7|12',
            'Binary-Effect-Aware-StrongPathCheck|router-binary-tool-effect-aware-strong-path-check-dsv4-agent-dsv4-qwen36-logical-local|6|13|18'
        )
        $observedGroups = @($Config.groups | ForEach-Object { '{0}|{1}|{2}|{3}|{4}' -f $_.group_id,$_.arm_id,$_.cell_count,$_.schedule_first,$_.schedule_last })
        if (($observedGroups -join "`n") -cne ($expectedGroups -join "`n")) { throw 'Binary Efficiency Tiny arm tuples changed.' }
        $expectedTasks = @('1|L3-02|2,1','2|L5-02|1,1','3|L4-02|1,2')
        $observedTasks = @($Config.task_panel | ForEach-Object { '{0}|{1}|{2}' -f $_.ordinal,$_.task_id,(@($_.case_index_by_repetition) -join ',') })
        if (($observedTasks -join "`n") -cne ($expectedTasks -join "`n")) { throw 'Binary Efficiency Tiny task/case panel changed.' }
        $expectedSmoke = @(
            '1|Binary-Control|L5-02:1|1',
            '2|Binary-Effect-Aware|L5-02:1|1',
            '3|Binary-Effect-Aware-StrongPathCheck|L5-02:1|1',
            '4|Binary-Effect-Aware-StrongPathCheck|L3-02:2|1'
        )
        $observedSmoke = @($Config.smoke.cells | Sort-Object smoke_schedule | ForEach-Object { '{0}|{1}|{2}|{3}' -f $_.smoke_schedule,$_.group_id,$_.task_case,$_.repetition })
        if ([int]$Config.smoke.matrix_cell_count -ne 4 -or ($observedSmoke -join "`n") -cne ($expectedSmoke -join "`n")) {
            throw 'Binary Efficiency Tiny four-Cell mechanism Smoke changed.'
        }
        if ([int]$Config.smoke.minimum_effect_aware_transitions -ne 1 -or [int]$Config.smoke.minimum_strong_path_check_exposures -ne 1 -or [int]$Config.formal.matrix_cell_count -ne 18 -or [int]$Config.formal.cell_count_per_group -ne 6 -or [int]$Config.formal.task_count_per_group -ne 3 -or [int]$Config.formal.repetitions_per_task -ne 2) {
            throw 'Binary Efficiency Tiny mechanism threshold or 18-Cell formal boundary changed.'
        }
        if ([string]$Config.models.router.model_id -cne 'deepseek-v4-flash' -or [string]$Config.models.cloud_agent.model_id -cne 'deepseek-v4-flash' -or [string]$Config.models.logical_local_agent.model_id -cne 'qwen3.6-35b') {
            throw 'Binary Efficiency Tiny permits only DSV4 Router/Cloud and Qwen3.6-35B Local.'
        }
        if ([string]$Config.route_policy.effect_aware_policy_version -cne 'g4-binary-ui-effect-aware-v1' -or [string]$Config.route_policy.strong_path_check.version -cne 'g4-binary-strong-path-check-v1' -or $Config.route_policy.strong_path_check.direct_path_forced -ne $false) {
            throw 'Binary Efficiency Tiny state or Strong-Path Check semantics changed.'
        }
        if ([string]$Config.capture_contract.remote_capture_root -cne '/data/data/com.termux/files/home/clawmobile-experiments/router-binary-efficiency-tiny-v1/active/captures') {
            throw 'Binary Efficiency Tiny remote capture root changed.'
        }
        return $true
    }
    $isGpt55Partial = $rmDesignId -ceq 'phone-a-g0-gpt55-expanded15-partial-v1'
    if ([int]$Config.schema_version -eq 4 -and $isGpt55Partial) {
        if ([string]$Config.device.device_id -cne 'phone-a' -or [string]$Config.device.ssh_host -cne '10.127.121.62') {
            throw 'G0 GPT-5.5 requires only Phone A at 10.127.121.62.'
        }
        if ([int]$Config.execution.maximum_controllers -ne 1 -or [int]$Config.execution.maximum_active_cells -ne 1 -or [int]$Config.execution.maximum_request_chains -ne 1) {
            throw 'G0 GPT-5.5 requires one controller, one active Cell, and one request chain.'
        }
        if ((@($Config.execution.group_order) -join ',') -cne 'G0' -or [string]$Config.execution.within_group_order -cne 'round-major_fixed_task_order') {
            throw 'G0 GPT-5.5 identity or ordering changed.'
        }
        if ([string]$Config.execution.infrastructure_failure_policy -cne 'preserve_and_stop_current_group') {
            throw 'G0 GPT-5.5 must fail fast on infrastructure failure.'
        }
        if ((@($Config.active_task_ids) -join ',') -cne 'L3-02,L5-02') {
            throw 'G0 GPT-5.5 active partial task projection changed.'
        }
        $expectedTaskRows = @(
            'L1|L1-02|1,4,2,3','L1|L1-03|1,1,1,1','L1|L1-08|1,3,2,4',
            'L2|L2-01|1,2,2,1','L2|L2-05|1,1,1,1','L2|L2-09|2,1,1,2',
            'L3|L3-01|1,2,2,1','L3|L3-02|2,1,1,2','L3|L3-05|1,2,2,1',
            'L4|L4-01|2,1,1,2','L4|L4-02|1,2,2,1','L4|L4-03|2,1,1,2',
            'L5|L5-01|1,1,1,1','L5|L5-02|1,1,1,1','L5|L5-04|1,1,1,1'
        )
        $observedTaskRows = @($Config.task_panel | ForEach-Object { '{0}|{1}|{2}' -f $_.level,$_.task_id,(@($_.case_index_by_repetition) -join ',') })
        if (($observedTaskRows -join "`n") -cne ($expectedTaskRows -join "`n")) { throw 'G0 GPT-5.5 Expanded15 panel changed.' }
        $observedGroups = @($Config.groups | ForEach-Object { '{0}|{1}|{2}|{3}|{4}' -f $_.group_id,$_.arm_id,$_.cell_count,$_.schedule_first,$_.schedule_last })
        if (($observedGroups -join "`n") -cne 'G0|full-openai-gpt55|8|1|8') { throw 'G0 GPT-5.5 arm tuple changed.' }
        $observedSmoke = @($Config.smoke.cells | ForEach-Object { '{0}|{1}|{2}|{3}' -f $_.smoke_schedule,$_.group_id,$_.task_case,$_.repetition })
        if ([int]$Config.smoke.matrix_cell_count -ne 1 -or ($observedSmoke -join "`n") -cne '1|G0|L3-02:2|1') {
            throw 'G0 GPT-5.5 Smoke changed.'
        }
        if ([int]$Config.formal.matrix_cell_count -ne 8 -or [int]$Config.formal.active_task_count -ne 2 -or [int]$Config.formal.expanded15_task_count -ne 15 -or [int]$Config.formal.repetitions_per_task -ne 4 -or [int]$Config.formal.future_full_matrix_cell_count -ne 60) {
            throw 'G0 GPT-5.5 formal and future Expanded15 counts changed.'
        }
        if ([string]$Config.models.cloud_agent.provider_id -cne 'openai' -or [string]$Config.models.cloud_agent.model_id -cne 'gpt-5.5' -or [string]$Config.models.cloud_agent.physical_platform -cne 'openai-api') {
            throw 'G0 GPT-5.5 provider/model identity changed.'
        }
        if ([string]$Config.capture_contract.remote_capture_root -cne '/data/data/com.termux/files/home/clawmobile-experiments/g0-gpt55-expanded15-v1/active/captures' -or $Config.capture_contract.transparent_cloud_full -ne $true) {
            throw 'G0 GPT-5.5 capture contract changed.'
        }
        return $true
    }
    $isCapabilitySuppressionFullDsv4 = $rmDesignId -ceq 'phone-a-router-capability-suppression-full-dsv4-comparator-v1'
    if ([int]$Config.schema_version -eq 4 -and $isCapabilitySuppressionFullDsv4) {
        if ([string]$Config.device.device_id -cne 'phone-a' -or [string]$Config.device.ssh_host -cne '10.127.121.62') {
            throw 'The Full DSV4 comparator requires only Phone A at 10.127.121.62.'
        }
        if ([int]$Config.execution.maximum_controllers -ne 1 -or [int]$Config.execution.maximum_active_cells -ne 1 -or [int]$Config.execution.maximum_request_chains -ne 1) {
            throw 'The Full DSV4 comparator requires one controller, one active Cell, and one request chain.'
        }
        if ((@($Config.execution.condition_order) -join ',') -cne 'Full-DSV4' -or [string]$Config.execution.within_study_order -cne 'round-major_fixed_task_order') {
            throw 'The Full DSV4 comparator identity or ordering changed.'
        }
        if ([string]$Config.execution.infrastructure_failure_policy -cne 'preserve_and_stop_current_group') {
            throw 'The Full DSV4 comparator must fail fast on infrastructure failure.'
        }
        $observedGroups = @($Config.groups | ForEach-Object { '{0}|{1}|{2}|{3}|{4}' -f $_.group_id,$_.arm_id,$_.cell_count,$_.schedule_first,$_.schedule_last })
        if (($observedGroups -join "`n") -cne 'Full-DSV4|full-dsv4|8|1|8') { throw 'The Full DSV4 comparator arm tuple changed.' }
        $expectedTasks = @('1|L3-01|1','2|L3-05|1','3|L5-04|1','4|L4-02|1')
        $observedTasks = @($Config.task_panel | ForEach-Object { '{0}|{1}|{2}' -f $_.ordinal,$_.task_id,$_.case_index })
        if (($observedTasks -join "`n") -cne ($expectedTasks -join "`n")) { throw 'The Full DSV4 comparator task/case panel changed.' }
        $observedSmoke = @($Config.smoke.cells | ForEach-Object { '{0}|{1}|{2}|{3}' -f $_.smoke_schedule,$_.group_id,$_.task_case,$_.repetition })
        if ([int]$Config.smoke.matrix_cell_count -ne 1 -or ($observedSmoke -join "`n") -cne '1|Full-DSV4|L3-01:1|1') {
            throw 'The Full DSV4 comparator Canary changed.'
        }
        if ([int]$Config.formal.matrix_cell_count -ne 8 -or [int]$Config.formal.task_count -ne 4 -or [int]$Config.formal.repetitions_per_task -ne 2) {
            throw 'The Full DSV4 comparator formal matrix must remain eight Cells.'
        }
        if ([string]$Config.capture_contract.remote_capture_root -cne '/data/data/com.termux/files/home/clawmobile-experiments/router-capability-suppression-full-dsv4-v1/active/captures') {
            throw 'The Full DSV4 comparator remote capture root changed.'
        }
        return $true
    }
    $isCapabilitySuppression = $rmDesignId -ceq 'phone-a-router-capability-suppression-v1'
    if ([int]$Config.schema_version -eq 4 -and $isCapabilitySuppression) {
        if ([string]$Config.device.device_id -cne 'phone-a' -or [string]$Config.device.ssh_host -cne '10.127.121.62') {
            throw 'Capability Suppression requires only Phone A at 10.127.121.62.'
        }
        if ([int]$Config.execution.maximum_controllers -ne 1 -or [int]$Config.execution.maximum_active_cells -ne 1 -or [int]$Config.execution.maximum_request_chains -ne 1) {
            throw 'Capability Suppression requires one controller, one active Cell, and one request chain.'
        }
        if ((@($Config.execution.condition_order) -join ',') -cne 'Baseline,Cloud-first' -or [string]$Config.execution.within_study_order -cne 'arm-major_then_round-major_fixed_task_order') {
            throw 'Capability Suppression arm identity or ordering changed.'
        }
        if ([string]$Config.execution.infrastructure_failure_policy -cne 'preserve_and_stop_current_group') {
            throw 'Capability Suppression must fail fast on infrastructure failure.'
        }
        $expectedGroups = @(
            'Baseline|router-fsm-scoped-repair-dsv4-agent-dsv4-qwen36-logical-local|8|1|8',
            'Cloud-first|router-fsm-scoped-repair-cloud-first-dsv4-agent-dsv4-qwen36-logical-local|8|9|16'
        )
        $observedGroups = @($Config.groups | ForEach-Object { '{0}|{1}|{2}|{3}|{4}' -f $_.group_id,$_.arm_id,$_.cell_count,$_.schedule_first,$_.schedule_last })
        if (($observedGroups -join "`n") -cne ($expectedGroups -join "`n")) { throw 'Capability Suppression arm tuples changed.' }
        $expectedTasks = @('1|L3-01|1','2|L3-05|1','3|L5-04|1','4|L4-02|1')
        $observedTasks = @($Config.task_panel | ForEach-Object { '{0}|{1}|{2}' -f $_.ordinal,$_.task_id,$_.case_index })
        if (($observedTasks -join "`n") -cne ($expectedTasks -join "`n")) { throw 'Capability Suppression task/case panel changed.' }
        $observedSmoke = @($Config.smoke.cells | ForEach-Object { '{0}|{1}|{2}|{3}' -f $_.smoke_schedule,$_.group_id,$_.task_case,$_.repetition })
        if ([int]$Config.smoke.matrix_cell_count -ne 1 -or $Config.smoke.mechanism_exposure_required -ne $false -or ($observedSmoke -join "`n") -cne '1|Baseline|L3-01:1|1') {
            throw 'Capability Suppression recovery Canary changed.'
        }
        if ([int]$Config.formal.matrix_cell_count -ne 16 -or [int]$Config.formal.cell_count_per_group -ne 8 -or [int]$Config.formal.task_count_per_group -ne 4 -or [int]$Config.formal.repetitions_per_task -ne 2) {
            throw 'Capability Suppression formal matrix must remain two arms of eight Cells.'
        }
        $policy = $Config.route_policy
        if ((@($policy.router_output) -join ',') -cne 'OBSERVE_UI_RAW,QUERY_UI_GROUNDED,INTERACT_UI_GROUNDED,RETRIEVE_WEB_BOUNDED,PERSIST_OR_SYSTEM_MUTATION,OPEN_EXEC_OR_COMPOSITE,VERIFY_COMPLETE_RECOVER,NO_TOOL_OR_AMBIGUOUS' -or (@($policy.local_route_classes) -join ',') -cne 'OBSERVE_UI_RAW,QUERY_UI_GROUNDED,INTERACT_UI_GROUNDED') {
            throw 'Capability Suppression finite RouteClass boundary changed.'
        }
        if ([string]$policy.scoped_context_version -cne 'scoped-local-static-affordance-v1' -or [string]$policy.fsm_policy_version -cne 'g4-fsm-scoped-context-v1' -or [string]$policy.repair_policy_version -cne 'g4-fsm-scoped-context-standard-moderate-repair-v1') {
            throw 'Capability Suppression changed scoped context, FSM, or Repair.'
        }
        $suppression = $policy.capability_suppression
        if ((@($suppression.gate_tools) -join ',') -cne 'android_tap,adb_tap,android_type,adb_type,android_swipe,adb_swipe,android_keyevent,adb_keyevent' -or $suppression.all_other_mechanisms_frozen -ne $true) {
            throw 'Capability Suppression gate boundary changed.'
        }
        if ([string]$Config.capture_contract.remote_capture_root -cne '/data/data/com.termux/files/home/clawmobile-experiments/router-capability-suppression-v1/active/captures') {
            throw 'Capability Suppression remote capture root changed.'
        }
        return $true
    }
    $isRouteFlexTiny = $rmDesignId -ceq 'phone-a-router-route-flex-tiny-preliminary-v1'
    if ([int]$Config.schema_version -eq 4 -and $isRouteFlexTiny) {
        if ([string]$Config.device.device_id -cne 'phone-a' -or [string]$Config.device.ssh_host -cne '10.127.121.62') {
            throw 'The Route-Flex Tiny Preliminary requires only Phone A at 10.127.121.62.'
        }
        if ([int]$Config.execution.maximum_controllers -ne 1 -or [int]$Config.execution.maximum_active_cells -ne 1 -or [int]$Config.execution.maximum_request_chains -ne 1) {
            throw 'The Route-Flex Tiny Preliminary requires one controller, one active Cell, and one request chain.'
        }
        if ((@($Config.execution.condition_order) -join ',') -cne 'C0,C1,C2' -or [string]$Config.execution.within_study_order -cne 'task_case_then_c0_c1_c2') {
            throw 'The Route-Flex Tiny condition identities or task-major order changed.'
        }
        if ([string]$Config.execution.infrastructure_failure_policy -cne 'preserve_and_stop_current_group') {
            throw 'The Route-Flex Tiny Preliminary must fail fast on infrastructure failure.'
        }
        $expectedGroups = @(
            'C0|router-fsm-scoped-repair-dsv4-agent-dsv4-qwen36-logical-local|4',
            'C1|router-fsm-scoped-repair-c1-dsv4-agent-dsv4-qwen36-logical-local|4',
            'C2|router-fsm-scoped-repair-c2-dsv4-agent-dsv4-qwen36-logical-local|4'
        )
        $observedGroups = @($Config.groups | ForEach-Object { '{0}|{1}|{2}' -f $_.group_id,$_.arm_id,$_.cell_count })
        if (($observedGroups -join "`n") -cne ($expectedGroups -join "`n")) { throw 'The Route-Flex Tiny arm tuples changed.' }
        $expectedTasks = @('1|L3-01|1','2|L3-02|2','3|L4-01|1','4|L4-03|2')
        $observedTasks = @($Config.task_panel | ForEach-Object { '{0}|{1}|{2}' -f $_.ordinal,$_.task_id,$_.case_index })
        if (($observedTasks -join "`n") -cne ($expectedTasks -join "`n")) { throw 'The Route-Flex Tiny task/case panel changed.' }
        $expectedSmoke = @(
            '1|C0|L3-01:1|1','2|C1|L3-01:1|1','3|C2|L3-01:1|1',
            '4|C0|L3-02:2|1','5|C1|L3-02:2|1','6|C2|L3-02:2|1',
            '7|C0|L4-01:1|1','8|C1|L4-01:1|1','9|C2|L4-01:1|1',
            '10|C0|L4-03:2|1','11|C1|L4-03:2|1','12|C2|L4-03:2|1'
        )
        $observedSmoke = @($Config.smoke.cells | Sort-Object smoke_schedule | ForEach-Object { '{0}|{1}|{2}|{3}' -f $_.smoke_schedule,$_.group_id,$_.task_case,$_.repetition })
        if ([int]$Config.smoke.matrix_cell_count -ne 12 -or [int]$Config.smoke.cell_count_per_condition -ne 4 -or ($observedSmoke -join "`n") -cne ($expectedSmoke -join "`n")) {
            throw 'The Route-Flex Tiny 12-cell schedule changed.'
        }
        if ([int]$Config.smoke.minimum_c1_intervention_tasks -ne 2 -or [int]$Config.smoke.minimum_c2_intervention_tasks -ne 2 -or [int]$Config.formal.matrix_cell_count -ne 0) {
            throw 'The Route-Flex Tiny intervention threshold or preliminary-only boundary changed.'
        }
        $policy = $Config.route_policy
        if ((@($policy.router_output) -join ',') -cne 'OBSERVE_UI_RAW,QUERY_UI_GROUNDED,INTERACT_UI_GROUNDED,RETRIEVE_WEB_BOUNDED,PERSIST_OR_SYSTEM_MUTATION,OPEN_EXEC_OR_COMPOSITE,VERIFY_COMPLETE_RECOVER,NO_TOOL_OR_AMBIGUOUS' -or (@($policy.local_route_classes) -join ',') -cne 'OBSERVE_UI_RAW,QUERY_UI_GROUNDED,INTERACT_UI_GROUNDED' -or (@($policy.always_cloud_tools) -join ',') -cne 'android_shell,adb_shell,exec,web_search') {
            throw 'The Route-Flex Tiny frozen RouteClass or Cloud-only boundary changed.'
        }
        if ([string]$policy.scoped_context_version -cne 'scoped-local-static-affordance-v1' -or [string]$policy.fsm_policy_version -cne 'g4-fsm-scoped-context-v1' -or [string]$policy.repair_policy_version -cne 'g4-fsm-scoped-context-standard-moderate-repair-v1') {
            throw 'The Route-Flex Tiny scoped context, FSM, or Repair version changed.'
        }
        if ([string]$Config.capture_contract.remote_capture_root -cne '/data/data/com.termux/files/home/clawmobile-experiments/router-route-flex-tiny-preliminary-v1/active/captures') {
            throw 'The Route-Flex Tiny remote capture root changed.'
        }
        return $true
    }
    $isFsmTierA = $rmDesignId -ceq 'phone-a-router-r2-fsm-paired-v1'
    $isFsmExpanded15 = $rmDesignId -ceq 'phone-a-router-r2-fsm-expanded15-paired-v1'
    $isFsmPaired = $isFsmTierA -or $isFsmExpanded15
    if ([int]$Config.schema_version -eq 4 -and $isFsmPaired) {
        if ([string]$Config.device.device_id -cne 'phone-a' -or [string]$Config.device.ssh_host -cne '10.127.121.62') {
            throw 'The R2-FSM paired design requires only Phone A at 10.127.121.62.'
        }
        if ([int]$Config.execution.maximum_controllers -ne 1 -or [int]$Config.execution.maximum_active_cells -ne 1 -or [int]$Config.execution.maximum_request_chains -ne 1) {
            throw 'The R2-FSM paired design requires one controller, one active cell, and one request chain.'
        }
        if ((@($Config.execution.condition_order) -join ',') -cne 'G4-RM-SC,G4-FSM-SC' -or [string]$Config.execution.within_study_order -cne 'task_case_repetition_paired_ab_ba') {
            throw 'The R2-FSM paired condition identities or AB/BA ordering changed.'
        }
        if ([string]$Config.execution.infrastructure_failure_policy -cne 'preserve_and_stop_current_group') {
            throw 'The R2-FSM paired design must preserve the first infrastructure failure and stop.'
        }
        $expectedGroups = if ($isFsmExpanded15) {
            @(
                'G4-RM-SC|router-rm-scoped-dsv4-agent-dsv4-qwen36-logical-local|60|new_paired_expanded15_collection',
                'G4-FSM-SC|router-fsm-scoped-dsv4-agent-dsv4-qwen36-logical-local|60|new_paired_expanded15_collection'
            )
        } else {
            @(
                'G4-RM-SC|router-rm-scoped-dsv4-agent-dsv4-qwen36-logical-local|40|new_paired_tier_a_collection',
                'G4-FSM-SC|router-fsm-scoped-dsv4-agent-dsv4-qwen36-logical-local|40|new_paired_tier_a_collection'
            )
        }
        $observedGroups = @($Config.groups | ForEach-Object { '{0}|{1}|{2}|{3}' -f $_.group_id,$_.arm_id,$_.cell_count,$_.data_source })
        if (($observedGroups -join "`n") -cne ($expectedGroups -join "`n")) { throw 'The R2-FSM paired arm tuples changed.' }
        if ($isFsmExpanded15) {
            $expectedTasks = @(
                '1|L1|L1-02|1,4,2,3','2|L1|L1-03|1,1,1,1','3|L1|L1-08|1,3,2,4',
                '4|L2|L2-01|1,2,2,1','5|L2|L2-05|1,1,1,1','6|L2|L2-09|2,1,1,2',
                '7|L3|L3-01|1,2,2,1','8|L3|L3-02|2,1,1,2','9|L3|L3-05|1,2,2,1',
                '10|L4|L4-01|2,1,1,2','11|L4|L4-02|1,2,2,1','12|L4|L4-03|2,1,1,2',
                '13|L5|L5-01|1,1,1,1','14|L5|L5-02|1,1,1,1','15|L5|L5-04|1,1,1,1'
            )
            $observedTasks = @($Config.task_panel | ForEach-Object { '{0}|{1}|{2}|{3}' -f $_.ordinal,$_.level,$_.task_id,(@($_.case_index_by_repetition) -join ',') })
            if (($observedTasks -join "`n") -cne ($expectedTasks -join "`n")) { throw 'The paired Expanded15 task/case panel changed.' }
            $expectedRounds = @('L1,L2,L3,L4,L5','L2,L3,L4,L5,L1','L3,L4,L5,L1,L2','L4,L5,L1,L2,L3')
            $observedRounds = @(1..4 | ForEach-Object { @($Config.round_level_order.PSObject.Properties[[string]$_].Value) -join ',' })
            if (($observedRounds -join "`n") -cne ($expectedRounds -join "`n")) { throw 'The paired Expanded15 round rotations changed.' }
        } else {
            $expectedTasks = @(
                '1|matched-five|L3-01|1',
                '2|expanded15|L3-01|2',
                '3|expanded15|L3-05|1',
                '4|expanded15|L5-02|1'
            )
            $observedTasks = @($Config.task_panel | ForEach-Object { '{0}|{1}|{2}|{3}' -f $_.ordinal,$_.panel,$_.task_id,$_.case_index })
            if (($observedTasks -join "`n") -cne ($expectedTasks -join "`n")) { throw 'The R2-FSM Tier-A task/case panel changed.' }
        }
        $expectedSmokeCount = if ($isFsmExpanded15) { 10 } else { 8 }
        $expectedSmokePerGroup = if ($isFsmExpanded15) { 5 } else { 4 }
        if ([int]$Config.smoke.matrix_cell_count -ne $expectedSmokeCount -or [int]$Config.smoke.cell_count_per_group -ne $expectedSmokePerGroup -or @($Config.smoke.cells).Count -ne $expectedSmokeCount -or $Config.smoke.mechanism_exposure_required -ne $true) {
            throw "The R2-FSM paired Smoke must contain $expectedSmokeCount frozen Cells."
        }
        $expectedSmoke = if ($isFsmExpanded15) {
            @(
                '1|G4-RM-SC|L1-03:1|1|canary-L1-L1-03-case-1','2|G4-FSM-SC|L1-03:1|1|canary-L1-L1-03-case-1',
                '3|G4-FSM-SC|L2-09:2|1|canary-L2-L2-09-case-2','4|G4-RM-SC|L2-09:2|1|canary-L2-L2-09-case-2',
                '5|G4-RM-SC|L3-02:2|1|canary-L3-L3-02-case-2','6|G4-FSM-SC|L3-02:2|1|canary-L3-L3-02-case-2',
                '7|G4-FSM-SC|L4-01:1|1|canary-L4-L4-01-case-1','8|G4-RM-SC|L4-01:1|1|canary-L4-L4-01-case-1',
                '9|G4-RM-SC|L5-04:1|1|canary-L5-L5-04-case-1','10|G4-FSM-SC|L5-04:1|1|canary-L5-L5-04-case-1'
            )
        } else {
            @(
                '1|G4-RM-SC|L3-01:1|1|smoke-L3-01-case-1',
                '2|G4-FSM-SC|L3-01:1|1|smoke-L3-01-case-1',
                '3|G4-FSM-SC|L3-01:2|1|smoke-L3-01-case-2',
                '4|G4-RM-SC|L3-01:2|1|smoke-L3-01-case-2',
                '5|G4-RM-SC|L3-05:1|1|smoke-L3-05-case-1',
                '6|G4-FSM-SC|L3-05:1|1|smoke-L3-05-case-1',
                '7|G4-FSM-SC|L5-02:1|1|smoke-L5-02-case-1',
                '8|G4-RM-SC|L5-02:1|1|smoke-L5-02-case-1'
            )
        }
        $observedSmoke = @($Config.smoke.cells | Sort-Object smoke_schedule | ForEach-Object { '{0}|{1}|{2}|{3}|{4}' -f $_.smoke_schedule,$_.group_id,$_.task_case,$_.repetition,$_.pair_id })
        if (($observedSmoke -join "`n") -cne ($expectedSmoke -join "`n")) { throw 'The R2-FSM paired Smoke order changed.' }
        $expectedFormalCount = if ($isFsmExpanded15) { 120 } else { 80 }
        $expectedFormalPerGroup = if ($isFsmExpanded15) { 60 } else { 40 }
        $expectedTaskCount = if ($isFsmExpanded15) { 15 } else { 4 }
        $expectedRepetitions = if ($isFsmExpanded15) { 4 } else { 10 }
        if ([int]$Config.formal.matrix_cell_count -ne $expectedFormalCount -or [int]$Config.formal.cell_count_per_group -ne $expectedFormalPerGroup -or [int]$Config.formal.task_count_per_group -ne $expectedTaskCount -or [int]$Config.formal.repetitions_per_task -ne $expectedRepetitions) {
            throw "The R2-FSM paired formal matrix must remain $expectedFormalCount Cells."
        }
        $policy = $Config.route_policy
        $expectedClasses = @('OBSERVE_UI_RAW','QUERY_UI_GROUNDED','INTERACT_UI_GROUNDED','RETRIEVE_WEB_BOUNDED','PERSIST_OR_SYSTEM_MUTATION','OPEN_EXEC_OR_COMPOSITE','VERIFY_COMPLETE_RECOVER','NO_TOOL_OR_AMBIGUOUS')
        $expectedLocal = @('OBSERVE_UI_RAW','QUERY_UI_GROUNDED','INTERACT_UI_GROUNDED')
        $expectedCloud = @('RETRIEVE_WEB_BOUNDED','PERSIST_OR_SYSTEM_MUTATION','OPEN_EXEC_OR_COMPOSITE','VERIFY_COMPLETE_RECOVER','NO_TOOL_OR_AMBIGUOUS')
        if ((@($policy.router_output) -join ',') -cne ($expectedClasses -join ',') -or (@($policy.local_route_classes) -join ',') -cne ($expectedLocal -join ',') -or (@($policy.always_cloud_route_classes) -join ',') -cne ($expectedCloud -join ',')) {
            throw 'The R2-FSM paired finite RouteClass boundary changed.'
        }
        if ([string]$policy.scoped_context_version -cne 'scoped-local-static-affordance-v1' -or [string]$policy.rm_policy_version -cne 'g4-rm-scoped-context-v1' -or [string]$policy.fsm_policy_version -cne 'g4-fsm-scoped-context-v1') {
            throw 'The paired scoped-context or policy version changed.'
        }
        if ((@($policy.always_cloud_tools) -join ',') -cne 'android_shell,adb_shell,exec,web_search') {
            throw 'The paired study must keep shell, exec, and web retrieval Cloud-only.'
        }
        $expectedCaptureRoot = if ($isFsmExpanded15) { '/data/data/com.termux/files/home/clawmobile-experiments/router-r2-fsm-expanded15-paired-v1/active/captures' } else { '/data/data/com.termux/files/home/clawmobile-experiments/router-r2-fsm-paired-v1/active/captures' }
        if ([string]$Config.capture_contract.remote_capture_root -cne $expectedCaptureRoot) {
            throw 'The R2-FSM paired remote capture root changed.'
        }
        return $true
    }

    $isRmMatched = $rmDesignId -ceq 'phone-a-router-rm-matched5-v1'
    $isRmExpanded15 = $rmDesignId -ceq 'phone-a-router-rm-expanded15-v1'
    $isRepairExpanded15 = $rmDesignId -ceq 'phone-a-router-fsm-scoped-repair-expanded15-v1'
    $isQwenRouterRepairExpanded15 = $rmDesignId -ceq 'phone-a-router-fsm-scoped-repair-qwen-router-expanded15-v1'
    $isBinaryToolExpanded15 = $rmDesignId -ceq 'phone-a-router-binary-tool-expanded15-v1'
    $isExplicitBinaryToolExpanded15 = $rmDesignId -ceq 'phone-a-router-explicit-binary-tool-expanded15-v1'
    $isAnyRepairExpanded15 = $isRepairExpanded15 -or $isQwenRouterRepairExpanded15 -or $isBinaryToolExpanded15 -or $isExplicitBinaryToolExpanded15
    $isSingleRouterExpanded15 = $isRmExpanded15 -or $isAnyRepairExpanded15
    if ([int]$Config.schema_version -eq 4 -and ($isRmMatched -or $isSingleRouterExpanded15)) {
        if ([string]$Config.device.device_id -cne 'phone-a' -or [string]$Config.device.ssh_host -cne '10.127.121.62') {
            throw 'G4-RM requires only Phone A at 10.127.121.62.'
        }
        if ([int]$Config.execution.maximum_controllers -ne 1 -or [int]$Config.execution.maximum_active_cells -ne 1 -or [int]$Config.execution.maximum_request_chains -ne 1) {
            throw 'G4-RM concurrency must be exactly one controller, one active cell, and one request chain.'
        }
        $expectedWithinGroupOrder = if ($isSingleRouterExpanded15) { 'round-major_with_rotating_level_order' } else { 'round-major_fixed_task_order' }
        $expectedGroupOrder = if ($isExplicitBinaryToolExpanded15) { 'G4-Explicit-Binary-Tool' } elseif ($isBinaryToolExpanded15) { 'G4-Binary-Tool' } elseif ($isQwenRouterRepairExpanded15) { 'G4-FSM-SC-Repair-QwenRouter' } elseif ($isRepairExpanded15) { 'G4-FSM-SC-Repair' } else { 'G4-RM' }
        if ((@($Config.execution.group_order) -join ',') -cne $expectedGroupOrder -or [string]$Config.execution.within_group_order -cne $expectedWithinGroupOrder) {
            throw 'G4-RM group-major and round-major ordering changed.'
        }
        if ([string]$Config.execution.infrastructure_failure_policy -cne 'preserve_and_stop_current_group') {
            throw 'G4-RM must preserve the first infrastructure failure and stop the current group.'
        }
        $expectedGroups = if ($isExplicitBinaryToolExpanded15) {
            @('G4-Explicit-Binary-Tool|router-explicit-binary-tool-deterministic-dsv4-qwen36-logical-local|60|1|60|new_explicit_fsm_exact_tool_expanded15_collection')
        } elseif ($isBinaryToolExpanded15) {
            @('G4-Binary-Tool|router-binary-tool-dsv4-agent-dsv4-qwen36-logical-local|60|1|60|new_binary_router_exact_tool_expanded15_collection')
        } elseif ($isQwenRouterRepairExpanded15) {
            @('G4-FSM-SC-Repair-QwenRouter|router-fsm-scoped-repair-qwen36-agent-dsv4-qwen36-logical-local|60|1|60|new_qwen_router_only_expanded15_collection')
        } elseif ($isRepairExpanded15) {
            @('G4-FSM-SC-Repair|router-fsm-scoped-repair-dsv4-agent-dsv4-qwen36-logical-local|60|1|60|new_repair_only_expanded15_collection')
        } elseif ($isRmExpanded15) {
            @('G4-RM|router-rm-dsv4-agent-dsv4-qwen36-logical-local|60|1|60|new_router_expanded15_collection')
        } else {
            @('G4-RM|router-rm-dsv4-agent-dsv4-qwen36-logical-local|50|1|50|new_router_matched5_collection')
        }
        $observedGroups = @($Config.groups | ForEach-Object { '{0}|{1}|{2}|{3}|{4}|{5}' -f $_.group_id,$_.arm_id,$_.cell_count,$_.schedule_first,$_.schedule_last,$_.data_source })
        if (($observedGroups -join "`n") -cne ($expectedGroups -join "`n")) { throw 'The G4-RM frozen group tuple changed.' }
        if ($isSingleRouterExpanded15) {
            $expectedTaskRows = @(
                'L1|L1-02|1,4,2,3','L1|L1-03|1,1,1,1','L1|L1-08|1,3,2,4',
                'L2|L2-01|1,2,2,1','L2|L2-05|1,1,1,1','L2|L2-09|2,1,1,2',
                'L3|L3-01|1,2,2,1','L3|L3-02|2,1,1,2','L3|L3-05|1,2,2,1',
                'L4|L4-01|2,1,1,2','L4|L4-02|1,2,2,1','L4|L4-03|2,1,1,2',
                'L5|L5-01|1,1,1,1','L5|L5-02|1,1,1,1','L5|L5-04|1,1,1,1'
            )
            $observedTaskRows = @($Config.task_panel | ForEach-Object { '{0}|{1}|{2}' -f $_.level,$_.task_id,(@($_.case_index_by_repetition) -join ',') })
            if (($observedTaskRows -join "`n") -cne ($expectedTaskRows -join "`n")) { throw 'The G4-RM Expanded15 paired panel changed.' }
            $expectedRounds = @('L1,L2,L3,L4,L5','L2,L3,L4,L5,L1','L3,L4,L5,L1,L2','L4,L5,L1,L2,L3')
            $observedRounds = @(1..4 | ForEach-Object { @($Config.round_level_order.PSObject.Properties[[string]$_].Value) -join ',' })
            if (($observedRounds -join "`n") -cne ($expectedRounds -join "`n")) { throw 'The G4-RM Expanded15 round rotations changed.' }
            if ([int]$Config.formal.matrix_cell_count -ne 60 -or [int]$Config.formal.group_cell_count -ne 60 -or [int]$Config.formal.task_count_per_group -ne 15 -or [int]$Config.formal.repetitions_per_task -ne 4) {
                throw 'G4-RM Expanded15 formal counts must remain one group of 60 cells.'
            }
        } else {
            $expectedTasks = @('1|L1-03|1','2|L2-01|1','3|L3-01|1','4|L4-02|1','5|L5-01|1')
            $observedTasks = @($Config.task_panel | ForEach-Object { '{0}|{1}|{2}' -f $_.ordinal,$_.task_id,$_.case_index })
            if (($observedTasks -join "`n") -cne ($expectedTasks -join "`n")) { throw 'The G4-RM matched five-task panel changed.' }
            if ([int]$Config.formal.matrix_cell_count -ne 50 -or [int]$Config.formal.group_cell_count -ne 50 -or [int]$Config.formal.task_count_per_group -ne 5 -or [int]$Config.formal.repetitions_per_task -ne 10) {
                throw 'G4-RM formal counts must remain one group of 50 cells.'
            }
        }
        if ([int]$Config.smoke.matrix_cell_count -ne 5 -or [int]$Config.smoke.cell_count_per_group -ne 5 -or @($Config.smoke.cells).Count -ne 5 -or $Config.smoke.mechanism_exposure_required -ne $true) {
            throw 'G4-RM Smoke must remain five cells with mechanism exposure required.'
        }
        if ($isAnyRepairExpanded15) {
            $expectedRepairGroup = if ($isExplicitBinaryToolExpanded15) { 'G4-Explicit-Binary-Tool' } elseif ($isBinaryToolExpanded15) { 'G4-Binary-Tool' } elseif ($isQwenRouterRepairExpanded15) { 'G4-FSM-SC-Repair-QwenRouter' } else { 'G4-FSM-SC-Repair' }
            $expectedSmoke = @(
                "1|$expectedRepairGroup|L1-03:1|1","2|$expectedRepairGroup|L2-09:2|1","3|$expectedRepairGroup|L3-01:1|1",
                "4|$expectedRepairGroup|L4-01:1|1","5|$expectedRepairGroup|L5-02:1|1"
            )
            $observedSmoke = @($Config.smoke.cells | Sort-Object smoke_schedule | ForEach-Object { '{0}|{1}|{2}|{3}' -f $_.smoke_schedule,$_.group_id,$_.task_case,$_.repetition })
            if (($observedSmoke -join "`n") -cne ($expectedSmoke -join "`n")) { throw 'Repair-only Smoke order changed.' }
            $expectedMinimumRepair = if ($isExplicitBinaryToolExpanded15) { 0 } else { 1 }
            if ([int]$Config.smoke.minimum_repair_attempts -ne $expectedMinimumRepair -or [int]$Config.smoke.minimum_repair_applied -ne $expectedMinimumRepair) {
                throw 'Repair-only Smoke repair exposure threshold changed.'
            }
            if (($isBinaryToolExpanded15 -or $isExplicitBinaryToolExpanded15) -and [int]$Config.smoke.minimum_distinct_tasks_with_accepted_local -ne 2) {
                throw 'Binary Tool Smoke must execute accepted Local Tools in at least two distinct Tasks.'
            }
        }
        $policy = $Config.route_policy
        $expectedClasses = @('OBSERVE_UI_RAW','QUERY_UI_GROUNDED','INTERACT_UI_GROUNDED','RETRIEVE_WEB_BOUNDED','PERSIST_OR_SYSTEM_MUTATION','OPEN_EXEC_OR_COMPOSITE','VERIFY_COMPLETE_RECOVER','NO_TOOL_OR_AMBIGUOUS')
        if ($isAnyRepairExpanded15) {
            $expectedLocal = @('OBSERVE_UI_RAW','QUERY_UI_GROUNDED','INTERACT_UI_GROUNDED')
            $expectedCloud = @('RETRIEVE_WEB_BOUNDED','PERSIST_OR_SYSTEM_MUTATION','OPEN_EXEC_OR_COMPOSITE','VERIFY_COMPLETE_RECOVER','NO_TOOL_OR_AMBIGUOUS')
            if ($isExplicitBinaryToolExpanded15) {
                if ((@($policy.policy_output) -join ',') -cne 'LOCAL_EXACT_TOOL,CLOUD_REQUIRED' -or (@($policy.local_route_classes) -join ',') -cne ($expectedLocal -join ',') -or (@($policy.cloud_merged_route_classes) -join ',') -cne ($expectedCloud -join ',') -or (@($policy.exact_local_tools) -join ',') -cne 'android_ui_dump,android_ui_query,android_tap' -or [string]$policy.decision_mode -cne 'deterministic_fsm_exact_tool_capability') {
                    throw 'Explicit binary Tool capability policy boundary changed.'
                }
            } elseif ($isBinaryToolExpanded15) {
                if ((@($policy.router_output) -join ',') -cne 'LOCAL_UI_CANDIDATE,CLOUD_REQUIRED' -or (@($policy.local_route_classes) -join ',') -cne ($expectedLocal -join ',') -or (@($policy.cloud_merged_route_classes) -join ',') -cne ($expectedCloud -join ',') -or [string]$policy.local_output_contract -cne 'exactly_one_openai_tool_call' -or [string]$policy.routeclass_resolution -cne 'derive_deterministically_from_exact_tool_name') {
                    throw 'Binary Tool Router boundary changed.'
                }
            } elseif ((@($policy.router_output) -join ',') -cne ($expectedClasses -join ',') -or (@($policy.local_route_classes) -join ',') -cne ($expectedLocal -join ',') -or (@($policy.always_cloud_route_classes) -join ',') -cne ($expectedCloud -join ',')) {
                throw 'Repair-only finite RouteClass boundary changed.'
            }
            $expectedScopedContext = if ($isBinaryToolExpanded15 -or $isExplicitBinaryToolExpanded15) { 'coarse-local-tool-union-v1' } else { 'scoped-local-static-affordance-v1' }
            if ([string]$policy.scoped_context_version -cne $expectedScopedContext -or [string]$policy.fsm_policy_version -cne 'g4-fsm-scoped-context-v1' -or [string]$policy.repair_policy_version -cne 'g4-fsm-scoped-context-standard-moderate-repair-v1') {
                throw 'Repair-only scoped-context, FSM, or Repair policy version changed.'
            }
            $repair = $policy.repair_contract
            if (
                [string]$repair.name -cne 'standard_moderate_repair' -or
                (@($repair.eligible_route_classes) -join ',') -cne 'OBSERVE_UI_RAW,QUERY_UI_GROUNDED,INTERACT_UI_GROUNDED' -or
                (@($repair.eligible_tools) -join ',') -cne 'android_ui_dump,adb_ui_dump_xml,android_ui_query,android_tap,adb_tap' -or
                $repair.requires_exactly_one_tool_call -ne $true -or
                $repair.full_revalidation_before_execution -ne $true -or
                $repair.route_class_change_allowed -ne $false -or
                $repair.tool_substitution_allowed -ne $false -or
                $repair.semantic_target_selection_allowed -ne $false -or
                $repair.wrong_tool_repair_allowed -ne $false -or
                $repair.shell_or_exec_repair_allowed -ne $false -or
                $repair.multi_tool_repair_allowed -ne $false -or
                $repair.ambiguous_selector_repair_allowed -ne $false -or
                $repair.missing_fresh_artifact_repair_allowed -ne $false
            ) {
                throw 'Standard Moderate Repair boundary changed.'
            }
            $expectedInteractionTools = if ($isExplicitBinaryToolExpanded15) { 'android_tap' } else { 'android_tap,adb_tap' }
            if ((@($policy.always_cloud_tools) -join ',') -cne 'android_shell,adb_shell,exec,web_search' -or (@($policy.interaction_tools) -join ',') -cne $expectedInteractionTools) {
                throw 'Repair-only Cloud guard or grounded tap contract changed.'
            }
            $expectedBaselineDesign = if ($isExplicitBinaryToolExpanded15) { 'phone-a-router-binary-tool-expanded15-v1' } elseif ($isBinaryToolExpanded15) { 'phone-a-router-fsm-scoped-repair-qwen-router-expanded15-v1' } elseif ($isQwenRouterRepairExpanded15) { 'phone-a-router-fsm-scoped-repair-expanded15-v1' } else { 'phone-a-router-r2-fsm-expanded15-paired-v1' }
            $expectedBaselineGroup = if ($isExplicitBinaryToolExpanded15) { 'G4-Binary-Tool' } elseif ($isBinaryToolExpanded15) { 'G4-FSM-SC-Repair-QwenRouter' } elseif ($isQwenRouterRepairExpanded15) { 'G4-FSM-SC-Repair' } else { 'G4-FSM-SC' }
            if ([string]$Config.historical_baseline.design_id -cne $expectedBaselineDesign -or [string]$Config.historical_baseline.group_id -cne $expectedBaselineGroup -or [int]$Config.historical_baseline.canonical_cell_count -ne 60) {
                throw 'Repair-only historical baseline identity changed.'
            }
            if ($isRepairExpanded15 -and (
                [string]$Config.models.router.provider_id -cne 'freeinference' -or [string]$Config.models.router.model_id -cne 'deepseek-v4-flash' -or [string]$Config.models.router.physical_platform -cne 'freeinference-cloud' -or
                [string]$Config.models.cloud_agent.provider_id -cne 'freeinference' -or [string]$Config.models.cloud_agent.model_id -cne 'deepseek-v4-flash' -or [string]$Config.models.cloud_agent.physical_platform -cne 'freeinference-cloud' -or
                [string]$Config.models.logical_local_agent.provider_id -cne 'freeinference' -or [string]$Config.models.logical_local_agent.model_id -cne 'qwen3.6-35b' -or [string]$Config.models.logical_local_agent.physical_platform -cne 'freeinference-cloud' -or $Config.models.logical_local_agent.logical_role_only -ne $true
            )) {
                throw 'DSV4-Router Repair study model/provider roles changed.'
            }
            if ($isQwenRouterRepairExpanded15 -and (
                [string]$Config.models.router.provider_id -cne 'freeinference' -or [string]$Config.models.router.model_id -cne 'qwen3.6-35b' -or [string]$Config.models.router.physical_platform -cne 'freeinference-cloud' -or
                [string]$Config.models.cloud_agent.provider_id -cne 'freeinference' -or [string]$Config.models.cloud_agent.model_id -cne 'deepseek-v4-flash' -or [string]$Config.models.cloud_agent.physical_platform -cne 'freeinference-cloud' -or
                [string]$Config.models.logical_local_agent.provider_id -cne 'freeinference' -or [string]$Config.models.logical_local_agent.model_id -cne 'qwen3.6-35b' -or [string]$Config.models.logical_local_agent.physical_platform -cne 'freeinference-cloud' -or $Config.models.logical_local_agent.logical_role_only -ne $true
            )) {
                throw 'Qwen-Router study model/provider roles changed.'
            }
            if ($isBinaryToolExpanded15 -and (
                [string]$Config.models.router.provider_id -cne 'freeinference' -or [string]$Config.models.router.model_id -cne 'deepseek-v4-flash' -or [string]$Config.models.router.physical_platform -cne 'freeinference-cloud' -or
                [string]$Config.models.cloud_agent.provider_id -cne 'freeinference' -or [string]$Config.models.cloud_agent.model_id -cne 'deepseek-v4-flash' -or [string]$Config.models.cloud_agent.physical_platform -cne 'freeinference-cloud' -or
                [string]$Config.models.logical_local_agent.provider_id -cne 'freeinference' -or [string]$Config.models.logical_local_agent.model_id -cne 'qwen3.6-35b' -or [string]$Config.models.logical_local_agent.physical_platform -cne 'freeinference-cloud' -or $Config.models.logical_local_agent.logical_role_only -ne $true
            )) {
                throw 'Binary Tool Router study model/provider roles changed.'
            }
            if ($isExplicitBinaryToolExpanded15 -and (
                [string]$Config.models.router.provider_id -cne 'deterministic-proxy' -or [string]$Config.models.router.model_id -cne 'fsm-exact-tool-capability-policy' -or [string]$Config.models.router.physical_platform -cne 'phone-proxy-cpu' -or
                [string]$Config.models.cloud_agent.provider_id -cne 'freeinference' -or [string]$Config.models.cloud_agent.model_id -cne 'deepseek-v4-flash' -or [string]$Config.models.cloud_agent.physical_platform -cne 'freeinference-cloud' -or
                [string]$Config.models.logical_local_agent.provider_id -cne 'freeinference' -or [string]$Config.models.logical_local_agent.model_id -cne 'qwen3.6-35b' -or [string]$Config.models.logical_local_agent.physical_platform -cne 'freeinference-cloud' -or $Config.models.logical_local_agent.logical_role_only -ne $true
            )) {
                throw 'Explicit binary Tool study model/provider roles changed.'
            }
        } else {
            $expectedLocal = @('OBSERVE_UI_RAW','QUERY_UI_GROUNDED','INTERACT_UI_GROUNDED','RETRIEVE_WEB_BOUNDED')
            if ([string]$policy.version -cne 'g4-rm-moderate-action-v1' -or (@($policy.router_output) -join ',') -cne ($expectedClasses -join ',') -or (@($policy.local_route_classes) -join ',') -cne ($expectedLocal -join ',')) {
                throw 'G4-RM Action-Class contract changed.'
            }
            if ((@($policy.always_cloud_tools) -join ',') -cne 'android_shell,adb_shell,exec' -or (@($policy.interaction_tools) -join ',') -cne 'android_tap,adb_tap') {
                throw 'G4-RM shell Cloud guard or grounded tap contract changed.'
            }
        }
        $expectedCaptureRoot = if ($isExplicitBinaryToolExpanded15) { '/data/data/com.termux/files/home/clawmobile-experiments/router-explicit-binary-tool-expanded15-v1/active/captures' } elseif ($isBinaryToolExpanded15) { '/data/data/com.termux/files/home/clawmobile-experiments/router-binary-tool-expanded15-v1/active/captures' } elseif ($isQwenRouterRepairExpanded15) { '/data/data/com.termux/files/home/clawmobile-experiments/router-fsm-scoped-repair-qwen-router-expanded15-v1/active/captures' } elseif ($isRepairExpanded15) { '/data/data/com.termux/files/home/clawmobile-experiments/router-fsm-scoped-repair-expanded15-v1/active/captures' } else { '/data/data/com.termux/files/home/clawmobile-experiments/router-rm-v1/active/captures' }
        if ([string]$Config.capture_contract.remote_capture_root -cne $expectedCaptureRoot) {
            throw 'G4-RM remote capture root changed.'
        }
        return $true
    }

    if ([int]$Config.schema_version -eq 4 -and [string]$Config.design_id -ceq 'phone-a-router-r1-r2-matched5-v1') {
        if ([string]$Config.device.device_id -cne 'phone-a' -or [string]$Config.device.ssh_host -cne '10.127.121.62') {
            throw 'Router R1/R2 requires only Phone A at 10.127.121.62.'
        }
        if ([int]$Config.execution.maximum_controllers -ne 1 -or [int]$Config.execution.maximum_active_cells -ne 1 -or [int]$Config.execution.maximum_request_chains -ne 1) {
            throw 'Router R1/R2 concurrency must be exactly one controller, one active cell, and one request chain.'
        }
        if ((@($Config.execution.group_order) -join ',') -cne 'G4-R1,G4-R2' -or [string]$Config.execution.within_group_order -cne 'round-major_fixed_task_order') {
            throw 'Router R1/R2 group-major and fixed-task round-major ordering changed.'
        }
        if ([string]$Config.execution.infrastructure_failure_policy -cne 'preserve_and_stop_current_group') {
            throw 'Router R1/R2 must preserve the first infrastructure failure and stop the current group.'
        }
        $expectedGroups = @(
            'G4-R1|router-r1-dsv4-agent-dsv4-qwen36-logical-local|50|1|50|new_router_matched5_collection',
            'G4-R2|router-r2-dsv4-agent-dsv4-qwen36-logical-local|50|51|100|new_router_matched5_collection'
        )
        $observedGroups = @($Config.groups | ForEach-Object { '{0}|{1}|{2}|{3}|{4}|{5}' -f $_.group_id,$_.arm_id,$_.cell_count,$_.schedule_first,$_.schedule_last,$_.data_source })
        if (($observedGroups -join "`n") -cne ($expectedGroups -join "`n")) { throw 'The Router R1/R2 frozen group tuples changed.' }
        $expectedTasks = @('1|L1-03|1','2|L2-01|1','3|L3-01|1','4|L4-02|1','5|L5-01|1')
        $observedTasks = @($Config.task_panel | ForEach-Object { '{0}|{1}|{2}' -f $_.ordinal,$_.task_id,$_.case_index })
        if (($observedTasks -join "`n") -cne ($expectedTasks -join "`n")) { throw 'The Router R1/R2 matched five-task panel changed.' }
        if ([int]$Config.formal.matrix_cell_count -ne 100 -or [int]$Config.formal.group_cell_count -ne 50 -or [int]$Config.formal.task_count_per_group -ne 5 -or [int]$Config.formal.repetitions_per_task -ne 10) {
            throw 'Router R1/R2 formal counts must remain two groups of 50 cells, 100 total.'
        }
        if ([int]$Config.smoke.matrix_cell_count -ne 10 -or [int]$Config.smoke.cell_count_per_group -ne 5 -or @($Config.smoke.cells).Count -ne 10) {
            throw 'Router R1/R2 Smoke must remain five cells per group, ten total.'
        }
        $r1 = $Config.route_policies.'G4-R1'
        $r2 = $Config.route_policies.'G4-R2'
        if ([string]$r1.version -cne 'g4-r1-evidence-v1' -or (@($r1.local_tools) -join ',') -cne 'android_screenshot,adb_screenshot,android_ui_dump,adb_ui_dump_xml') {
            throw 'G4-R1 finite evidence contract changed.'
        }
        if ([string]$r2.version -cne 'g4-r2-grounded-query-v1' -or (@($r2.added_local_tools) -join ',') -cne 'android_ui_query' -or [string]$r2.inherits -cne 'G4-R1') {
            throw 'G4-R2 grounded query contract changed.'
        }
        if ([string]$Config.historical_reference.display_label -cne 'G4-R0' -or [string]$Config.historical_reference.raw_group_id -cne 'G4') {
            throw 'Historical Router reference must remain display-only G4-R0 over raw G4 evidence.'
        }
        if ([string]$Config.capture_contract.remote_capture_root -cne '/data/data/com.termux/files/home/clawmobile-experiments/router-r1-r2-v1/active/captures') {
            throw 'Router R1/R2 remote capture root changed.'
        }
        return $true
    }

    if ([int]$Config.schema_version -ne 4 -or [string]$Config.design_id -cne 'phone-a-four-group-expanded15-v4') {
        throw 'Only the expanded fifteen-task Phone A schema_version=4 config is accepted.'
    }
    if ([string]$Config.device.device_id -cne 'phone-a' -or [string]$Config.device.ssh_host -cne '10.127.121.62') {
        throw 'v4 requires only Phone A at 10.127.121.62.'
    }
    if ([int]$Config.execution.maximum_controllers -ne 1 -or [int]$Config.execution.maximum_active_cells -ne 1 -or [int]$Config.execution.maximum_request_chains -ne 1) {
        throw 'v4 concurrency must be exactly one controller, one active cell, and one request chain.'
    }
    if ((@($Config.execution.group_order) -join ',') -cne 'G1,G2,G3,G5' -or [string]$Config.execution.within_group_order -cne 'round-major_with_rotating_level_order') {
        throw 'Expanded v4 group-major and rotating-level round-major ordering changed.'
    }
    if ([string]$Config.execution.infrastructure_failure_policy -cne 'preserve_and_stop_current_group') {
        throw 'v4 must preserve the first infrastructure failure and stop the current group.'
    }
    $expected = @(
        'G1|full-dsv4|60|1|60|new_expanded15_collection',
        'G2|filter-dsv4-agent-dsv4|60|61|120|new_expanded15_collection',
        'G3|filter-qwen36-agent-dsv4|60|121|180|new_expanded15_collection',
        'G5|full-qwen36|60|181|240|new_expanded15_collection'
    )
    $observed = @($Config.groups | ForEach-Object { '{0}|{1}|{2}|{3}|{4}|{5}' -f $_.group_id,$_.arm_id,$_.cell_count,$_.schedule_first,$_.schedule_last,$_.data_source })
    if (($observed -join "`n") -cne ($expected -join "`n")) { throw 'The four expanded frozen group tuples changed.' }
    if ([int]$Config.formal.matrix_cell_count -ne 240 -or [int]$Config.formal.group_cell_count -ne 60 -or [int]$Config.formal.task_count_per_group -ne 15 -or [int]$Config.formal.repetitions_per_task -ne 4) {
        throw 'Expanded v4 formal counts must remain four groups of 60 cells, 240 total.'
    }
    if ([int]$Config.smoke.cell_count -ne 4) { throw 'Expanded v4 Smoke must contain exactly four cells.' }
    $expectedTaskRows = @(
        'L1|L1-02|1,4,2,3','L1|L1-03|1,1,1,1','L1|L1-08|1,3,2,4',
        'L2|L2-01|1,2,2,1','L2|L2-05|1,1,1,1','L2|L2-09|2,1,1,2',
        'L3|L3-01|1,2,2,1','L3|L3-02|2,1,1,2','L3|L3-05|1,2,2,1',
        'L4|L4-01|2,1,1,2','L4|L4-02|1,2,2,1','L4|L4-03|2,1,1,2',
        'L5|L5-01|1,1,1,1','L5|L5-02|1,1,1,1','L5|L5-04|1,1,1,1'
    )
    $observedTaskRows = @($Config.task_panel | ForEach-Object { '{0}|{1}|{2}' -f $_.level,$_.task_id,(@($_.case_index_by_repetition) -join ',') })
    if (($observedTaskRows -join "`n") -cne ($expectedTaskRows -join "`n")) { throw 'Expanded task/case/repetition panel changed.' }
    $expectedRounds = @('L1,L2,L3,L4,L5','L2,L3,L4,L5,L1','L3,L4,L5,L1,L2','L4,L5,L1,L2,L3')
    $observedRounds = @(1..4 | ForEach-Object { @($Config.round_level_order.PSObject.Properties[[string]$_].Value) -join ',' })
    if (($observedRounds -join "`n") -cne ($expectedRounds -join "`n")) { throw 'Expanded round level rotations changed.' }
    return $true
}

function Split-V4TaskCase {
    param([Parameter(Mandatory)] [string] $TaskCase)
    if ($TaskCase -notmatch '^(L[1-5]-\d{2}):(\d+)$') { throw "Invalid task case: $TaskCase" }
    return [pscustomobject]@{ task_id=$Matches[1]; case_index=[int]$Matches[2] }
}

function Get-V4Plan {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [pscustomobject] $Config,
        [Parameter(Mandatory)] [ValidateSet('Smoke','Formal')] [string] $Stage
    )
    $null = Assert-V4Config -Config $Config
    $cells = [Collections.Generic.List[object]]::new()
    $isBinaryEfficiencyTiny = [string]$Config.design_id -ceq 'phone-a-router-binary-efficiency-tiny-v1'
    if ($isBinaryEfficiencyTiny) {
        if ($Stage -ceq 'Smoke') {
            foreach ($row in @($Config.smoke.cells | Sort-Object smoke_schedule)) {
                $group = @($Config.groups | Where-Object group_id -CEQ ([string]$row.group_id))
                if ($group.Count -ne 1) { throw "Binary Efficiency Tiny references unknown condition $($row.group_id)." }
                $task = Split-V4TaskCase -TaskCase ([string]$row.task_case)
                $taskRow = @($Config.task_panel | Where-Object task_id -CEQ $task.task_id)
                if ($taskRow.Count -ne 1) { throw "Binary Efficiency Tiny references unknown Task $($task.task_id)." }
                $cells.Add([pscustomobject][ordered]@{
                    stage='smoke';schedule=[int]$row.smoke_schedule;group_id=[string]$group[0].group_id;arm_id=[string]$group[0].arm_id
                    task_set='router-binary-efficiency-tiny';panel='mechanism-smoke';task_case=[string]$row.task_case
                    task_id=$task.task_id;case_index=$task.case_index;repetition=[int]$row.repetition;task_ordinal=[int]$taskRow[0].ordinal
                    condition_position=[array]::IndexOf(@($Config.execution.condition_order),[string]$group[0].group_id)+1
                })
            }
        } else {
            foreach ($group in @($Config.groups)) {
                $ordinal = 0
                foreach ($repetition in 1..2) {
                    foreach ($taskRow in @($Config.task_panel | Sort-Object ordinal)) {
                        $caseIndex = [int]@($taskRow.case_index_by_repetition)[$repetition - 1]
                        $taskCase = '{0}:{1}' -f [string]$taskRow.task_id,$caseIndex
                        $task = Split-V4TaskCase -TaskCase $taskCase
                        $cells.Add([pscustomobject][ordered]@{
                            stage='formal';schedule=([int]$group.schedule_first + $ordinal);group_id=[string]$group.group_id;arm_id=[string]$group.arm_id
                            task_set='router-binary-efficiency-tiny';panel='calendar-maps-efficiency';task_case=$taskCase
                            task_id=$task.task_id;case_index=$task.case_index;repetition=$repetition;task_ordinal=[int]$taskRow.ordinal
                            condition_position=[array]::IndexOf(@($Config.execution.condition_order),[string]$group.group_id)+1
                        })
                        $ordinal++
                    }
                }
                if ($ordinal -ne 6 -or ([int]$group.schedule_first + $ordinal - 1) -ne [int]$group.schedule_last) {
                    throw "Binary Efficiency Tiny segment $($group.group_id) is not its frozen six-Cell boundary."
                }
            }
        }
        $expected = if ($Stage -ceq 'Smoke') { 4 } else { 18 }
        if ($cells.Count -ne $expected) { throw "$Stage Binary Efficiency Tiny plan count is $($cells.Count), expected $expected." }
        return @($cells)
    }
    $isGpt55Partial = [string]$Config.design_id -ceq 'phone-a-g0-gpt55-expanded15-partial-v1'
    if ($isGpt55Partial) {
        $group = @($Config.groups)[0]
        if ($Stage -ceq 'Smoke') {
            $row = @($Config.smoke.cells)[0]
            $task = Split-V4TaskCase -TaskCase ([string]$row.task_case)
            $cells.Add([pscustomobject][ordered]@{
                stage='smoke';schedule=1;group_id='G0';arm_id=[string]$group.arm_id
                task_set='expanded15';panel='expanded15-partial-g0';task_case=[string]$row.task_case
                task_id=$task.task_id;case_index=$task.case_index;repetition=1;task_ordinal=1
            })
        } else {
            $schedule = 0
            foreach ($repetition in 1..4) {
                foreach ($taskId in @($Config.active_task_ids)) {
                    $taskRow = @($Config.task_panel | Where-Object task_id -CEQ ([string]$taskId))
                    if ($taskRow.Count -ne 1) { throw "G0 GPT-5.5 cannot resolve task $taskId in Expanded15." }
                    $caseIndex = [int]@($taskRow[0].case_index_by_repetition)[$repetition - 1]
                    $taskCase = '{0}:{1}' -f [string]$taskId,$caseIndex
                    $task = Split-V4TaskCase -TaskCase $taskCase
                    $schedule++
                    $cells.Add([pscustomobject][ordered]@{
                        stage='formal';schedule=$schedule;group_id='G0';arm_id=[string]$group.arm_id
                        task_set='expanded15';panel='expanded15-partial-g0';task_case=$taskCase
                        task_id=$task.task_id;case_index=$task.case_index;repetition=$repetition
                        level=[string]$taskRow[0].level;task_ordinal=[array]::IndexOf(@($Config.active_task_ids),[string]$taskId)+1
                    })
                }
            }
        }
        $expected = if ($Stage -ceq 'Smoke') { 1 } else { 8 }
        if ($cells.Count -ne $expected) { throw "$Stage G0 GPT-5.5 plan count is $($cells.Count), expected $expected." }
        return @($cells)
    }
    $isCapabilitySuppressionFullDsv4 = [string]$Config.design_id -ceq 'phone-a-router-capability-suppression-full-dsv4-comparator-v1'
    if ($isCapabilitySuppressionFullDsv4) {
        $group = @($Config.groups)[0]
        if ($Stage -ceq 'Smoke') {
            $row = @($Config.smoke.cells)[0]
            $task = Split-V4TaskCase -TaskCase ([string]$row.task_case)
            $cells.Add([pscustomobject][ordered]@{
                stage='smoke';schedule=1;group_id=[string]$group.group_id;arm_id=[string]$group.arm_id
                task_set='capability-suppression-comparator';panel='recovery-canary';task_case=[string]$row.task_case
                task_id=$task.task_id;case_index=$task.case_index;repetition=1;task_ordinal=1;condition_position=3
            })
        } else {
            $schedule = 0
            foreach ($repetition in 1..2) {
                foreach ($taskRow in @($Config.task_panel | Sort-Object ordinal)) {
                    $taskCase = '{0}:{1}' -f [string]$taskRow.task_id,[int]$taskRow.case_index
                    $task = Split-V4TaskCase -TaskCase $taskCase
                    $schedule++
                    $cells.Add([pscustomobject][ordered]@{
                        stage='formal';schedule=$schedule;group_id=[string]$group.group_id;arm_id=[string]$group.arm_id
                        task_set='capability-suppression-comparator';panel='fixed-four';task_case=$taskCase
                        task_id=$task.task_id;case_index=$task.case_index;repetition=$repetition
                        task_ordinal=[int]$taskRow.ordinal;condition_position=3
                    })
                }
            }
        }
        $expected = if ($Stage -ceq 'Smoke') { 1 } else { 8 }
        if ($cells.Count -ne $expected) { throw "$Stage Full DSV4 comparator plan count is $($cells.Count), expected $expected." }
        return @($cells)
    }
    $isCapabilitySuppression = [string]$Config.design_id -ceq 'phone-a-router-capability-suppression-v1'
    if ($isCapabilitySuppression) {
        if ($Stage -ceq 'Smoke') {
            $row = @($Config.smoke.cells)[0]
            $group = @($Config.groups | Where-Object group_id -CEQ ([string]$row.group_id))
            $task = Split-V4TaskCase -TaskCase ([string]$row.task_case)
            $cells.Add([pscustomobject][ordered]@{
                stage='smoke';schedule=1;group_id=[string]$group[0].group_id;arm_id=[string]$group[0].arm_id
                task_set='capability-suppression';panel='recovery-canary';task_case=[string]$row.task_case
                task_id=$task.task_id;case_index=$task.case_index;repetition=1;task_ordinal=1;condition_position=1
            })
        } else {
            foreach ($group in @($Config.groups)) {
                $ordinal = 0
                foreach ($repetition in 1..2) {
                    foreach ($taskRow in @($Config.task_panel | Sort-Object ordinal)) {
                        $taskCase = '{0}:{1}' -f [string]$taskRow.task_id,[int]$taskRow.case_index
                        $task = Split-V4TaskCase -TaskCase $taskCase
                        $cells.Add([pscustomobject][ordered]@{
                            stage='formal';schedule=([int]$group.schedule_first + $ordinal);group_id=[string]$group.group_id
                            arm_id=[string]$group.arm_id;task_set='capability-suppression';panel='fixed-four'
                            task_case=$taskCase;task_id=$task.task_id;case_index=$task.case_index;repetition=$repetition
                            task_ordinal=[int]$taskRow.ordinal;condition_position=if([string]$group.group_id -ceq 'Baseline'){1}else{2}
                        })
                        $ordinal++
                    }
                }
                if ($ordinal -ne 8 -or ([int]$group.schedule_first + $ordinal - 1) -ne [int]$group.schedule_last) {
                    throw "Capability Suppression segment $($group.group_id) is not its frozen eight-Cell boundary."
                }
            }
        }
        $expected = if ($Stage -ceq 'Smoke') { 1 } else { 16 }
        if ($cells.Count -ne $expected) { throw "$Stage Capability Suppression plan count is $($cells.Count), expected $expected." }
        return @($cells)
    }
    $isRouteFlexTiny = [string]$Config.design_id -ceq 'phone-a-router-route-flex-tiny-preliminary-v1'
    if ($isRouteFlexTiny) {
        if ($Stage -cne 'Smoke') { throw 'The Route-Flex Tiny Preliminary has only its fresh 12-cell Smoke stage.' }
        foreach ($row in @($Config.smoke.cells | Sort-Object smoke_schedule)) {
            $group = @($Config.groups | Where-Object group_id -CEQ ([string]$row.group_id))
            if ($group.Count -ne 1) { throw "Route-Flex Tiny references unknown condition $($row.group_id)." }
            $task = Split-V4TaskCase -TaskCase ([string]$row.task_case)
            $taskRow = @($Config.task_panel | Where-Object { [string]$_.task_id -ceq $task.task_id -and [int]$_.case_index -eq $task.case_index })
            if ($taskRow.Count -ne 1) { throw "Route-Flex Tiny references unknown task/case $($row.task_case)." }
            $cells.Add([pscustomobject][ordered]@{
                stage='smoke';schedule=[int]$row.smoke_schedule;group_id=[string]$group[0].group_id
                arm_id=[string]$group[0].arm_id;task_set='route-flex-tiny';panel='tiny-preliminary'
                task_case=[string]$row.task_case;task_id=$task.task_id;case_index=$task.case_index
                repetition=[int]$row.repetition;task_ordinal=[int]$taskRow[0].ordinal
                condition_position=1 + (([int]$row.smoke_schedule - 1) % 3)
            })
        }
        if ($cells.Count -ne 12) { throw "Route-Flex Tiny plan count is $($cells.Count), expected 12." }
        foreach ($condition in @('C0','C1','C2')) {
            if (@($cells | Where-Object group_id -CEQ $condition).Count -ne 4) { throw "Route-Flex Tiny condition $condition does not contain four Cells." }
        }
        return @($cells)
    }
    $isFsmTierA = [string]$Config.design_id -ceq 'phone-a-router-r2-fsm-paired-v1'
    $isFsmExpanded15 = [string]$Config.design_id -ceq 'phone-a-router-r2-fsm-expanded15-paired-v1'
    if ($isFsmTierA -or $isFsmExpanded15) {
        if ($Stage -ceq 'Smoke') {
            foreach ($row in @($Config.smoke.cells | Sort-Object smoke_schedule)) {
                $group = @($Config.groups | Where-Object group_id -CEQ ([string]$row.group_id))
                if ($group.Count -ne 1) { throw "Paired Smoke references unknown group $($row.group_id)." }
                $task = Split-V4TaskCase -TaskCase ([string]$row.task_case)
                $taskRow = @(if ($isFsmExpanded15) {
                    @($Config.task_panel | Where-Object { [string]$_.task_id -ceq $task.task_id -and $task.case_index -in @($_.case_index_by_repetition | ForEach-Object { [int]$_ }) })
                } else {
                    @($Config.task_panel | Where-Object { [string]$_.task_id -ceq $task.task_id -and [int]$_.case_index -eq $task.case_index })
                })
                if ($taskRow.Count -ne 1) { throw "Paired Smoke references an unknown frozen case $($row.task_case)." }
                $cells.Add([pscustomobject][ordered]@{
                    stage='smoke';schedule=[int]$row.smoke_schedule;group_id=[string]$group[0].group_id
                    arm_id=[string]$group[0].arm_id;task_set=if($isFsmExpanded15){'expanded15-fsm'}else{'tier-a-fsm'};panel=if($isFsmExpanded15){'expanded15'}else{[string]$taskRow[0].panel}
                    task_case=[string]$row.task_case;task_id=$task.task_id;case_index=$task.case_index
                    repetition=[int]$row.repetition;pair_id=[string]$row.pair_id
                    pair_position=if(([int]$row.smoke_schedule % 2) -eq 1){1}else{2}
                })
            }
        } else {
            $schedule = 0
            $repetitions = [int]$Config.formal.repetitions_per_task
            foreach ($repetition in 1..$repetitions) {
                $orderedTaskRows = if ($isFsmExpanded15) {
                    @($Config.round_level_order.PSObject.Properties[[string]$repetition].Value | ForEach-Object {
                        $level = [string]$_
                        @($Config.task_panel | Where-Object level -CEQ $level | Sort-Object ordinal)
                    })
                } else {
                    @($Config.task_panel | Sort-Object ordinal)
                }
                foreach ($taskRow in $orderedTaskRows) {
                    $caseIndex = if ($isFsmExpanded15) { [int]@($taskRow.case_index_by_repetition)[$repetition - 1] } else { [int]$taskRow.case_index }
                    $taskCase = '{0}:{1}' -f [string]$taskRow.task_id,$caseIndex
                    $task = Split-V4TaskCase -TaskCase $taskCase
                    $rmFirst = (($repetition + [int]$taskRow.ordinal) % 2) -eq 0
                    $pairGroups = if ($rmFirst) { @('G4-RM-SC','G4-FSM-SC') } else { @('G4-FSM-SC','G4-RM-SC') }
                    $pairId = 'formal-r{0:D2}-{1}' -f $repetition,($taskCase -replace ':','-case-')
                    for ($pairPosition = 1; $pairPosition -le 2; $pairPosition++) {
                        $groupId = [string]$pairGroups[$pairPosition - 1]
                        $group = @($Config.groups | Where-Object group_id -CEQ $groupId)[0]
                        $schedule++
                        $cells.Add([pscustomobject][ordered]@{
                            stage='formal';schedule=$schedule;group_id=$groupId;arm_id=[string]$group.arm_id
                            task_set=if($isFsmExpanded15){'expanded15-fsm'}else{'tier-a-fsm'};panel=if($isFsmExpanded15){'expanded15'}else{[string]$taskRow.panel};task_case=$taskCase
                            task_id=$task.task_id;case_index=$task.case_index;repetition=$repetition
                            task_ordinal=[int]$taskRow.ordinal;pair_id=$pairId;pair_position=$pairPosition
                        })
                    }
                }
            }
        }
        $expectedCount = if ($Stage -ceq 'Smoke') { [int]$Config.smoke.matrix_cell_count } else { [int]$Config.formal.matrix_cell_count }
        if ($cells.Count -ne $expectedCount) { throw "$Stage R2-FSM paired plan count is $($cells.Count), expected $expectedCount." }
        foreach ($groupId in @('G4-RM-SC','G4-FSM-SC')) {
            $groupCount = @($cells | Where-Object group_id -CEQ $groupId).Count
            $expectedGroupCount = if ($Stage -ceq 'Smoke') { [int]$Config.smoke.cell_count_per_group } else { [int]$Config.formal.cell_count_per_group }
            if ($groupCount -ne $expectedGroupCount) { throw "$Stage R2-FSM group $groupId has $groupCount Cells, expected $expectedGroupCount." }
        }
        return @($cells)
    }
    if ([string]$Config.design_id -in @('phone-a-router-r1-r2-matched5-v1','phone-a-router-rm-matched5-v1')) {
        if ($Stage -ceq 'Smoke') {
            foreach ($row in @($Config.smoke.cells | Sort-Object smoke_schedule)) {
                $group = @($Config.groups | Where-Object group_id -CEQ ([string]$row.group_id))
                if ($group.Count -ne 1) { throw "Smoke references unknown group $($row.group_id)." }
                $task = Split-V4TaskCase -TaskCase ([string]$row.task_case)
                $cells.Add([pscustomobject][ordered]@{
                    stage='smoke';schedule=[int]$row.smoke_schedule;group_id=[string]$group[0].group_id
                    arm_id=[string]$group[0].arm_id;task_set='matched5-router'
                    task_case=[string]$row.task_case;task_id=$task.task_id;case_index=$task.case_index
                    repetition=[int]$row.repetition
                })
            }
        } else {
            foreach ($groupId in @($Config.execution.group_order)) {
                $group = @($Config.groups | Where-Object group_id -CEQ $groupId)[0]
                $ordinal = 0
                for ($repetition=1; $repetition -le 10; $repetition++) {
                    foreach ($taskRow in @($Config.task_panel | Sort-Object ordinal)) {
                        $taskCase = '{0}:{1}' -f [string]$taskRow.task_id,[int]$taskRow.case_index
                        $task = Split-V4TaskCase -TaskCase $taskCase
                        $cells.Add([pscustomobject][ordered]@{
                            stage='formal';schedule=([int]$group.schedule_first + $ordinal);group_id=$groupId
                            arm_id=[string]$group.arm_id;task_set='matched5-router'
                            task_case=$taskCase;task_id=$task.task_id;case_index=$task.case_index
                            repetition=$repetition;task_ordinal=[int]$taskRow.ordinal
                        })
                        $ordinal++
                    }
                }
                if ($ordinal -ne 50 -or ([int]$group.schedule_first + $ordinal - 1) -ne [int]$group.schedule_last) {
                    throw "Generated formal segment for $groupId differs from its frozen 50-cell boundary."
                }
            }
        }
        $expectedRouterCount = if ($Stage -ceq 'Smoke') { [int]$Config.smoke.matrix_cell_count } else { [int]$Config.formal.matrix_cell_count }
        if ($cells.Count -ne $expectedRouterCount) { throw "$Stage Router plan count is $($cells.Count), expected $expectedRouterCount." }
        return @($cells)
    }
    if ($Stage -ceq 'Smoke') {
        foreach ($row in @($Config.smoke.cells | Sort-Object smoke_schedule)) {
            $group = @($Config.groups | Where-Object group_id -CEQ ([string]$row.group_id))
            if ($group.Count -ne 1) { throw "Smoke references unknown group $($row.group_id)." }
            $task = Split-V4TaskCase -TaskCase ([string]$row.task_case)
            $cells.Add([pscustomobject][ordered]@{
                stage='smoke'; schedule=[int]$row.smoke_schedule; group_id=[string]$group[0].group_id
                arm_id=[string]$group[0].arm_id; task_set='expanded15'
                task_case=[string]$row.task_case; task_id=$task.task_id; case_index=$task.case_index
                repetition=[int]$row.repetition
            })
        }
    } else {
        foreach ($groupId in @($Config.execution.group_order)) {
            $group = @($Config.groups | Where-Object group_id -CEQ $groupId)[0]
            $ordinal = 0
            for ($repetition=1; $repetition -le 4; $repetition++) {
                foreach ($level in @($Config.round_level_order.PSObject.Properties[[string]$repetition].Value)) {
                    foreach ($taskRow in @($Config.task_panel | Where-Object level -CEQ ([string]$level))) {
                        $caseIndex = [int]@($taskRow.case_index_by_repetition)[$repetition - 1]
                        $taskCase = '{0}:{1}' -f [string]$taskRow.task_id,$caseIndex
                        $task = Split-V4TaskCase -TaskCase $taskCase
                        $cells.Add([pscustomobject][ordered]@{
                            stage='formal'; schedule=([int]$group.schedule_first + $ordinal); group_id=$groupId
                            arm_id=[string]$group.arm_id; task_set='expanded15'
                            task_case=$taskCase; task_id=$task.task_id; case_index=$task.case_index
                            repetition=$repetition;level=[string]$level
                        })
                        $ordinal++
                    }
                }
            }
            if ($ordinal -ne [int]$group.cell_count -or ([int]$group.schedule_first + $ordinal - 1) -ne [int]$group.schedule_last) {
                throw "Generated formal segment for $groupId differs from its frozen count or boundary."
            }
        }
    }
    $isSingleRouterExpanded15 = [string]$Config.design_id -in @('phone-a-router-rm-expanded15-v1','phone-a-router-fsm-scoped-repair-expanded15-v1','phone-a-router-fsm-scoped-repair-qwen-router-expanded15-v1','phone-a-router-binary-tool-expanded15-v1','phone-a-router-explicit-binary-tool-expanded15-v1')
    $expectedCount = if ($isSingleRouterExpanded15) {
        if ($Stage -ceq 'Smoke') { [int]$Config.smoke.matrix_cell_count } else { [int]$Config.formal.matrix_cell_count }
    } else {
        if ($Stage -ceq 'Smoke') { 4 } else { 240 }
    }
    if ($cells.Count -ne $expectedCount) { throw "$Stage plan count is $($cells.Count), expected $expectedCount." }
    return @($cells)
}

function Get-V4CellRoot {
    param(
        [Parameter(Mandatory)] [string] $OutputRoot,
        [Parameter(Mandatory)] [pscustomobject] $Cell
    )
    $caseSlug = ([string]$Cell.task_case) -replace ':', '-case-'
    return Join-Path $OutputRoot (Join-Path ([string]$Cell.stage) (Join-Path ([string]$Cell.group_id) ('s{0:D4}_r{1:D2}_{2}' -f [int]$Cell.schedule,[int]$Cell.repetition,$caseSlug)))
}

function Invoke-V4Cell {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [pscustomobject] $Config,
        [Parameter(Mandatory)] [pscustomobject] $Cell,
        [Parameter(Mandatory)] [string] $OutputRoot,
        [Parameter(Mandatory)] [string] $GroupRunId,
        [Parameter(Mandatory)] [string] $ExpectedBootId,
        [Parameter(Mandatory)] [string] $RouterToken,
        [Parameter(Mandatory)] [string] $RemoteCaptureRoot,
        [Parameter(Mandatory)] [string] $PythonPath,
        [Parameter(Mandatory)] [string] $ClawBenchRoot,
        [string] $ExpectedXmuModelId = '',
        [int] $ExpectedXmuContextWindow = 0
    )
    $cellRoot = Get-V4CellRoot -OutputRoot $OutputRoot -Cell $Cell
    $stageRows = [Collections.Generic.List[object]]::new()
    $statusPath = Join-Path $cellRoot 'cell-status.json'
    $claimed = $false
    $resultEvidence = $null
    $captureValidation = $null
    $captureFiles = @()
    $runnerExitCode = $null
    $runId = $null
    $errorRecord = $null
    $xmuBoundary = $null
    $overall = [Diagnostics.Stopwatch]::StartNew()
    try {
        $at = [DateTimeOffset]::UtcNow
        $null = Assert-V4CellEnvironment -Config $Config -ExpectedBootId $ExpectedBootId
        $stageRows.Add([pscustomobject]@{stage='PRECHECK';started_at=$at.ToString('o');completed_at=[DateTimeOffset]::UtcNow.ToString('o');semantics='Full SSH, ADB, Channel, Gateway, and shared Proxy chain verified before creating cell evidence.'})

        $at = [DateTimeOffset]::UtcNow
        $null = New-V4CellClaim -CellRoot $cellRoot -Cell $Cell -GroupRunId $GroupRunId
        $claimed = $true
        $stageRows.Add([pscustomobject]@{stage='CLAIM';started_at=$at.ToString('o');completed_at=[DateTimeOffset]::UtcNow.ToString('o')})

        $planned = [ordered]@{schema_version=4;group_run_id=$GroupRunId;stage=$Cell.stage;schedule=[int]$Cell.schedule;group_id=$Cell.group_id;arm_id=$Cell.arm_id;task_case=$Cell.task_case;repetition=[int]$Cell.repetition}
        $null = Write-V4JsonExclusive -Path (Join-Path $cellRoot 'cell-plan.json') -Value $planned

        if (-not [string]::IsNullOrWhiteSpace($ExpectedXmuModelId)) {
            if ($ExpectedXmuContextWindow -le 0) { throw 'Expected XMU context window must be positive.' }
            $at = [DateTimeOffset]::UtcNow
            $preXmu = Reset-V4XmuSlot -Device $Config.device -ExpectedModelId $ExpectedXmuModelId -ExpectedContextWindow $ExpectedXmuContextWindow
            $xmuBoundary = [ordered]@{model_id=$ExpectedXmuModelId;context_window=$ExpectedXmuContextWindow;before_cell=$preXmu;after_durable_capture=$null}
            $stageRows.Add([pscustomobject]@{stage='XMU_PREPARE';started_at=$at.ToString('o');completed_at=[DateTimeOffset]::UtcNow.ToString('o');model_id=$ExpectedXmuModelId;slot_clean=$true})
        }

        $previous = @{}
        foreach ($name in @('ADB_SERVER_SOCKET','CLAWBENCH_RESULTS_DIR','CLAWBENCH_AGENT_BASE_URL','CLAWBENCH_EXPERIMENT_ARM_ID','CLAWBENCH_PROXY_CONTROL_URL','CLAWBENCH_PROXY_CONTROL_TOKEN','CLAWBENCH_ADB_TIMEOUT_SECONDS','CLAWBENCH_DEVICE_SERIAL','CLAWBENCH_SKILL_RUNNER')) {
            $previous[$name] = [Environment]::GetEnvironmentVariable($name)
        }
        try {
            $env:ADB_SERVER_SOCKET = if ($Config.device.PSObject.Properties.Name -contains 'adb_server_socket') { [string]$Config.device.adb_server_socket } else { 'tcp:127.0.0.1:15038' }
            $env:CLAWBENCH_RESULTS_DIR = $cellRoot
            $env:CLAWBENCH_AGENT_BASE_URL = if ($Config.device.PSObject.Properties.Name -contains 'clawbench_agent_base_url') { [string]$Config.device.clawbench_agent_base_url } else { 'http://127.0.0.1:18766' }
            $env:CLAWBENCH_EXPERIMENT_ARM_ID = [string]$Cell.arm_id
            $env:CLAWBENCH_PROXY_CONTROL_URL = if ($Config.device.PSObject.Properties.Name -contains 'router_proxy_base_url') { [string]$Config.device.router_proxy_base_url } else { 'http://127.0.0.1:18081' }
            $env:CLAWBENCH_PROXY_CONTROL_TOKEN = $RouterToken
            $env:CLAWBENCH_ADB_TIMEOUT_SECONDS = '30'
            $env:CLAWBENCH_DEVICE_SERIAL = [string]$Config.device.adb_serial
            $skillRunnerPath = (Join-Path $ClawBenchRoot 'scripts\run_verifier_skill.py').Replace('\','/')
            $env:CLAWBENCH_SKILL_RUNNER = ('{0} {1}' -f $PythonPath.Replace('\','/'),$skillRunnerPath)
            $runLabel = '{0}-{1}-s{2:D4}' -f $GroupRunId,[string]$Cell.stage,[int]$Cell.schedule
            $arguments = @(
                (Join-Path $ClawBenchRoot 'scripts\run_task_set.py'),
                '--device-serial',[string]$Config.device.adb_serial,
                '--model-label',[string]$Cell.group_id,
                '--task-case',[string]$Cell.task_case,
                '--repeat','1','--seed','0','--run-label',$runLabel
            )
            $at = [DateTimeOffset]::UtcNow
            $stageRows.Add([pscustomobject]@{stage='SETUP';started_at=$at.ToString('o');completed_at=$at.ToString('o');semantics='ClawBench task setup is inside RUN and is preserved in the result lifecycle.'})
            $process = Start-Process -FilePath $PythonPath -ArgumentList $arguments -WorkingDirectory $ClawBenchRoot -Wait -PassThru -NoNewWindow -RedirectStandardOutput (Join-Path $cellRoot 'runner.stdout.log') -RedirectStandardError (Join-Path $cellRoot 'runner.stderr.log')
            $runnerExitCode = [int]$process.ExitCode
            $stageRows.Add([pscustomobject]@{stage='RUN';started_at=$at.ToString('o');completed_at=[DateTimeOffset]::UtcNow.ToString('o');runner_exit_code=$runnerExitCode})
        } finally {
            foreach ($name in $previous.Keys) {
                if ($null -eq $previous[$name]) { Remove-Item "Env:$name" -ErrorAction SilentlyContinue }
                else { [Environment]::SetEnvironmentVariable($name, [string]$previous[$name]) }
            }
        }

        $resultEvidence = Read-V4Result -CellRoot $cellRoot
        if ($resultEvidence.value.PSObject.Properties.Name -contains 'run_id') { $runId = [string]$resultEvidence.value.run_id }
        if ($runId -notmatch '^[0-9a-f]{32}$') {
            throw 'ClawBench result does not contain a valid lowercase 32-hex result.run_id.'
        }

        $at = [DateTimeOffset]::UtcNow
        $proxyControlUrl = if ($Config.device.PSObject.Properties.Name -contains 'router_proxy_base_url') { [string]$Config.device.router_proxy_base_url } else { 'http://127.0.0.1:18081' }
        $proxyHealth = Wait-V4ProxyCapture -RunId $runId -ProxyControlUrl $proxyControlUrl
        $stageRows.Add([pscustomobject]@{stage='FLUSH';started_at=$at.ToString('o');completed_at=[DateTimeOffset]::UtcNow.ToString('o');capture=$proxyHealth.capture})

        $at = [DateTimeOffset]::UtcNow
        $captureFiles = @(Copy-V4CaptureEvidence -Device $Config.device -RemoteCaptureRoot $RemoteCaptureRoot -RunId $runId -CellRoot $cellRoot)
        $captureValidation = Test-V4Capture -Path (Join-Path $cellRoot 'model-calls.jsonl') -ProxyEventsPath (Join-Path $cellRoot 'proxy-events.jsonl') -RunId $runId -ArmId ([string]$Cell.arm_id)
        if ([string]$Config.design_id -ceq 'phone-a-g0-gpt55-expanded15-partial-v1') {
            $g0Records = @([IO.File]::ReadAllLines((Join-Path $cellRoot 'model-calls.jsonl'), [Text.Encoding]::UTF8) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | ForEach-Object { $_ | ConvertFrom-Json })
            $g0Inbound = @($g0Records | Where-Object event -eq 'proxy_request')
            $g0Calls = @($g0Records | Where-Object event -eq 'model_call')
            if ($g0Calls.Count -ne $g0Inbound.Count -or @($g0Calls | Where-Object { [string]$_.call_role -cne 'cloud_agent' -or [string]$_.provider_id -cne 'openai' -or [string]$_.model -cne 'gpt-5.5' }).Count -ne 0) {
                throw 'G0 capture is not a one-to-one transparent openai/gpt-5.5 Cloud Agent path.'
            }
        }
        if ([string]$resultEvidence.value.results.outcome -notin @('SUCCESS','FAILURE','INFRA_FAILURE','TIMEOUT')) {
            throw "Unknown ClawBench outcome: $($resultEvidence.value.results.outcome)"
        }
        if ($runnerExitCode -ne 0 -or [string]$resultEvidence.value.results.outcome -in @('INFRA_FAILURE','TIMEOUT')) {
            throw "ClawBench reported infrastructure outcome=$($resultEvidence.value.results.outcome), runner_exit_code=$runnerExitCode."
        }
        if ($null -ne $xmuBoundary) {
            $xmuResetAt = [DateTimeOffset]::UtcNow
            $xmuBoundary.after_durable_capture = Reset-V4XmuSlot -Device $Config.device -ExpectedModelId $ExpectedXmuModelId -ExpectedContextWindow $ExpectedXmuContextWindow
            $null = Write-V4JsonExclusive -Path (Join-Path $cellRoot 'xmu-boundary.json') -Value $xmuBoundary
            $stageRows.Add([pscustomobject]@{stage='XMU_RESET';started_at=$xmuResetAt.ToString('o');completed_at=[DateTimeOffset]::UtcNow.ToString('o');model_id=$ExpectedXmuModelId;slot_clean=$true})
        }
        $stageRows.Add([pscustomobject]@{stage='VERIFY';started_at=$at.ToString('o');completed_at=[DateTimeOffset]::UtcNow.ToString('o');capture=$captureValidation})

        $at = [DateTimeOffset]::UtcNow
        $null = Assert-V4CellEnvironment -Config $Config -ExpectedBootId $ExpectedBootId
        $stageRows.Add([pscustomobject]@{stage='TEARDOWN';started_at=$at.ToString('o');completed_at=[DateTimeOffset]::UtcNow.ToString('o');semantics='ClawBench teardown completed before result persistence; controller verified the target device remained on the same boot.'})
    } catch {
        $errorRecord = [pscustomobject]@{type=$_.Exception.GetType().FullName;message=$_.Exception.Message;script_stack=$_.ScriptStackTrace}
    } finally {
        if ($claimed -and $null -ne $xmuBoundary -and $null -eq $xmuBoundary.after_durable_capture) {
            try {
                $xmuResetAt = [DateTimeOffset]::UtcNow
                $xmuBoundary.after_durable_capture = Reset-V4XmuSlot -Device $Config.device -ExpectedModelId $ExpectedXmuModelId -ExpectedContextWindow $ExpectedXmuContextWindow
                $null = Write-V4JsonExclusive -Path (Join-Path $cellRoot 'xmu-boundary.json') -Value $xmuBoundary
                $stageRows.Add([pscustomobject]@{stage='XMU_RESET_AFTER_ERROR';started_at=$xmuResetAt.ToString('o');completed_at=[DateTimeOffset]::UtcNow.ToString('o');model_id=$ExpectedXmuModelId;slot_clean=$true})
            } catch {
                if ($null -eq $errorRecord) {
                    $errorRecord = [pscustomobject]@{type=$_.Exception.GetType().FullName;message=$_.Exception.Message;script_stack=$_.ScriptStackTrace}
                } else {
                    $errorRecord | Add-Member -NotePropertyName xmu_reset_error -NotePropertyValue ([pscustomobject]@{type=$_.Exception.GetType().FullName;message=$_.Exception.Message}) -Force
                }
            }
        }
        $overall.Stop()
    }

    $outcome = if ($null -ne $resultEvidence) { [string]$resultEvidence.value.results.outcome } else { $null }
    $infra = $null -ne $errorRecord
    $classification = if ($infra) { 'experiment_infrastructure_failure' } elseif ($outcome -ceq 'SUCCESS') { 'primary_scored_success' } else { 'primary_scored_failure' }
    if ($claimed) {
        $at = [DateTimeOffset]::UtcNow
        $stageRows.Add([pscustomobject]@{stage='STATUS';started_at=$at.ToString('o');completed_at=$at.ToString('o')})
    }
    $status = [ordered]@{
        schema_version=4;record_type='cell_status';written_at=[DateTimeOffset]::UtcNow.ToString('o')
        group_run_id=$GroupRunId;stage=$Cell.stage;schedule=[int]$Cell.schedule;group_id=$Cell.group_id;arm_id=$Cell.arm_id
        task_case=$Cell.task_case;repetition=[int]$Cell.repetition;result_run_id=$runId;session_id=$runId
        result_outcome=$outcome;classification=$classification;experiment_infrastructure_failure=$infra
        runner_exit_code=$runnerExitCode;elapsed_ms=[math]::Round($overall.Elapsed.TotalMilliseconds)
        stages=@($stageRows);result_evidence=if($null -ne $resultEvidence){[ordered]@{path=$resultEvidence.path;sha256=$resultEvidence.sha256}}else{$null}
        capture_files=@($captureFiles);capture_validation=$captureValidation;error=$errorRecord
        xmu_boundary=$xmuBoundary
    }
    if ($claimed) {
        $null = Write-V4JsonExclusive -Path $statusPath -Value $status
    }
    return [pscustomobject]$status
}

function Invoke-V4XmuCell {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [pscustomobject] $Config,
        [Parameter(Mandatory)] [pscustomobject] $Cell,
        [Parameter(Mandatory)] [string] $OutputRoot,
        [Parameter(Mandatory)] [string] $GroupRunId,
        [Parameter(Mandatory)] [string] $ExpectedBootId,
        [Parameter(Mandatory)] [string] $RouterToken,
        [Parameter(Mandatory)] [string] $RemoteCaptureRoot,
        [Parameter(Mandatory)] [string] $PythonPath,
        [Parameter(Mandatory)] [string] $ClawBenchRoot,
        [Parameter(Mandatory)] [string] $ExpectedModelId,
        [Parameter(Mandatory)] [int] $ExpectedContextWindow
    )
    return Invoke-V4Cell -Config $Config -Cell $Cell -OutputRoot $OutputRoot -GroupRunId $GroupRunId -ExpectedBootId $ExpectedBootId -RouterToken $RouterToken -RemoteCaptureRoot $RemoteCaptureRoot -PythonPath $PythonPath -ClawBenchRoot $ClawBenchRoot -ExpectedXmuModelId $ExpectedModelId -ExpectedXmuContextWindow $ExpectedContextWindow
}

Export-ModuleMember -Function Assert-V4Config,Get-V4Plan,Get-V4CellRoot,Invoke-V4Cell,Invoke-V4XmuCell
