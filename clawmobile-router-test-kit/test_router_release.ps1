[CmdletBinding()]
param(
    [string] $PythonPath,
    [switch] $SkipNodeTests
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$configRoot = Join-Path $PSScriptRoot 'configs'
$runnerRoot = Join-Path $PSScriptRoot 'five-group-v4'
$powerShellFiles = @(
    (Join-Path $PSScriptRoot 'Run-RouterCampaign.ps1'),
    (Join-Path $runnerRoot 'run_campaign.ps1'),
    (Join-Path $runnerRoot 'ExperimentCore.psm1'),
    (Join-Path $runnerRoot 'PhoneEnvironment.psm1'),
    (Join-Path $runnerRoot 'Evidence.psm1')
)
foreach ($path in $powerShellFiles) {
    $errors = $null
    [void][Management.Automation.Language.Parser]::ParseFile($path, [ref]$null, [ref]$errors)
    if ($errors.Count -ne 0) {
        throw "$path has PowerShell parse errors: $($errors.Message -join '; ')"
    }
}

Import-Module (Join-Path $runnerRoot 'ExperimentCore.psm1') -Force

$configFiles = @(
    'unified-five-group-experiment-v4.json',
    'router-r1-r2-matched5-experiment-v1.json',
    'router-rm-matched5-experiment-v1.json',
    'router-rm-expanded15-experiment-v1.json',
    'router-r2-fsm-paired-experiment-v1.json',
    'router-r2-fsm-expanded15-paired-experiment-v1.json',
    'router-fsm-scoped-repair-expanded15-experiment-v1.json',
    'router-fsm-scoped-repair-qwen-router-expanded15-experiment-v1.json',
    'router-binary-tool-expanded15-experiment-v1.json',
    'router-explicit-binary-tool-expanded15-experiment-v1.json',
    'router-route-flex-tiny-preliminary-v1.json',
    'router-capability-suppression-experiment-v1.json',
    'router-capability-suppression-full-dsv4-comparator-v1.json',
    'router-binary-efficiency-tiny-experiment-v1.json'
)

$observedRouterConfigFiles = @(
    Get-ChildItem -LiteralPath $configRoot -File -Filter 'router-*.json' |
        Sort-Object Name |
        ForEach-Object Name
)
$expectedRouterConfigFiles = @($configFiles | Where-Object { $_ -like 'router-*.json' })
if (($observedRouterConfigFiles -join "`n") -cne (($expectedRouterConfigFiles | Sort-Object) -join "`n")) {
    throw 'The release does not contain exactly the frozen Router config set.'
}
if (-not (Test-Path -LiteralPath (Join-Path $configRoot 'unified-five-group-experiment-v4.json') -PathType Leaf)) {
    throw 'The release is missing the frozen four-group Full/Filter baseline config.'
}

$planSummary = [Collections.Generic.List[object]]::new()
foreach ($name in $configFiles) {
    $path = Join-Path $configRoot $name
    $config = Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json
    $null = Assert-V4Config -Config $config

    $smoke = @(Get-V4Plan -Config $config -Stage Smoke)
    if ($smoke.Count -eq 0) { throw "$name produced an empty Smoke plan." }

    $formal = @()
    $formalCount = $null
    if ([string]$config.design_id -ceq 'phone-a-router-route-flex-tiny-preliminary-v1') {
        try {
            $null = Get-V4Plan -Config $config -Stage Formal
            throw "$name unexpectedly exposed a Formal plan."
        } catch {
            if ($_.Exception.Message -notlike '*only its fresh 12-cell Smoke stage*') { throw }
        }
    } else {
        $formal = @(Get-V4Plan -Config $config -Stage Formal)
        if ($formal.Count -eq 0) { throw "$name produced an empty Formal plan." }
        if (@($formal.schedule | Sort-Object -Unique).Count -ne $formal.Count) {
            throw "$name produced duplicate Formal schedule numbers."
        }
        $formalCount = $formal.Count
    }

    $planSummary.Add([pscustomobject][ordered]@{
        config = $name
        design_id = [string]$config.design_id
        smoke_cells = $smoke.Count
        formal_cells = $formalCount
        groups = @(if ($formal.Count -gt 0) { $formal.group_id | Select-Object -Unique } else { $smoke.group_id | Select-Object -Unique })
    })
}

if ([string]::IsNullOrWhiteSpace($PythonPath)) {
    $pythonCommand = @(
        Get-Command python.exe, python -All -ErrorAction SilentlyContinue |
            Where-Object Source -NotMatch '[\\/]WindowsApps[\\/]' |
            Select-Object -First 1
    )
    if ($pythonCommand.Count -eq 0) { throw 'Python was not found on PATH; pass -PythonPath explicitly.' }
    $PythonPath = $pythonCommand[0].Source
}

$pythonSyntaxCheck = @'
import ast
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
files = sorted(root.rglob("*.py"))
for path in files:
    ast.parse(path.read_text(encoding="utf-8-sig"), filename=str(path))
'@
& $PythonPath -B -c $pythonSyntaxCheck $PSScriptRoot
if ($LASTEXITCODE -ne 0) { throw 'ClawBench Python syntax validation failed.' }
$pythonFileCount = @(Get-ChildItem -LiteralPath $PSScriptRoot -File -Recurse -Filter '*.py' | Where-Object FullName -NotMatch '[\\/]__pycache__[\\/]').Count

Push-Location $PSScriptRoot
try {
    & $PythonPath -B -m unittest discover -s tests -p 'test_phone_*.py' -q
    if ($LASTEXITCODE -ne 0) { throw 'Phone-native controller tests failed.' }
} finally {
    Pop-Location
}

if (-not $SkipNodeTests) {
    $npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if ($null -eq $npmCommand) { $npmCommand = Get-Command npm -ErrorAction SilentlyContinue }
    Push-Location (Join-Path $PSScriptRoot 'clawmobile-router-proxy')
    try {
        if ($null -ne $npmCommand) {
            & $npmCommand.Source test
        } else {
            $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
            if ($null -eq $nodeCommand) { $nodeCommand = Get-Command node -ErrorAction SilentlyContinue }
            if ($null -eq $nodeCommand) { throw 'Node.js was not found; use -SkipNodeTests only for a syntax-only review.' }
            & $nodeCommand.Source --test
        }
        if ($LASTEXITCODE -ne 0) { throw 'Router Proxy unit tests failed.' }
    } finally {
        Pop-Location
    }
}

[pscustomobject][ordered]@{
    validation = 'passed'
    frozen_config_count = $planSummary.Count
    router_config_count = $observedRouterConfigFiles.Count
    powershell_parse_count = $powerShellFiles.Count
    python_ast = 'passed'
    python_ast_files = $pythonFileCount
    phone_native_tests = 'passed'
    node_tests = if ($SkipNodeTests) { 'skipped' } else { 'passed' }
    plans = $planSummary
} | ConvertTo-Json -Depth 8
