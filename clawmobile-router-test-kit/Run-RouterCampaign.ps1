[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateSet('Smoke', 'Formal')]
    [string] $Stage,

    [Parameter(Mandatory)]
    [string] $ConfigFile,

    [string] $GroupId,
    [string] $OutputRoot,
    [string] $GroupRunId,
    [string] $SmokeGatePath,
    [string] $PythonPath,
    [string] $ClawBenchRoot = (Join-Path $PSScriptRoot 'clawbench-runtime'),
    [string] $RemoteCaptureRoot,
    [ValidateRange(0, 240)] [int] $StartSchedule = 0,
    [ValidateRange(0, 240)] [int] $EndSchedule = 0,
    [switch] $ValidateOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$allowedConfigs = @(
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

$leafName = [IO.Path]::GetFileName($ConfigFile)
if ($leafName -cne $ConfigFile -or $leafName -cnotin $allowedConfigs) {
    throw "ConfigFile must be one of the frozen Router config filenames: $($allowedConfigs -join ', ')"
}

$configPath = Join-Path $PSScriptRoot $leafName
if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
    throw "Frozen Router config is missing: $configPath"
}

if (-not $ValidateOnly -and [string]::IsNullOrWhiteSpace($PythonPath)) {
    $pythonCommand = @(
        Get-Command python.exe, python -All -ErrorAction SilentlyContinue |
            Where-Object Source -NotMatch '[\\/]WindowsApps[\\/]' |
            Select-Object -First 1
    )
    if ($pythonCommand.Count -eq 0) {
        throw 'Python was not found on PATH; pass -PythonPath explicitly.'
    }
    $PythonPath = $pythonCommand[0].Source
}

$arguments = @{
    Stage = $Stage
    ConfigPath = $configPath
    ClawBenchRoot = $ClawBenchRoot
}
if ($ValidateOnly) { $arguments.ValidateOnly = $true }
if (-not [string]::IsNullOrWhiteSpace($GroupId)) { $arguments.GroupId = $GroupId }
if (-not [string]::IsNullOrWhiteSpace($OutputRoot)) { $arguments.OutputRoot = $OutputRoot }
if (-not [string]::IsNullOrWhiteSpace($GroupRunId)) { $arguments.GroupRunId = $GroupRunId }
if (-not [string]::IsNullOrWhiteSpace($SmokeGatePath)) { $arguments.SmokeGatePath = $SmokeGatePath }
if (-not [string]::IsNullOrWhiteSpace($PythonPath)) { $arguments.PythonPath = $PythonPath }
if (-not [string]::IsNullOrWhiteSpace($RemoteCaptureRoot)) { $arguments.RemoteCaptureRoot = $RemoteCaptureRoot }
if ($StartSchedule -gt 0) { $arguments.StartSchedule = $StartSchedule }
if ($EndSchedule -gt 0) { $arguments.EndSchedule = $EndSchedule }

& (Join-Path $PSScriptRoot 'five-group-v4\run_campaign.ps1') @arguments
