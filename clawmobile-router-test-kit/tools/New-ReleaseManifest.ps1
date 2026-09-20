[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$manifestPath = Join-Path $root 'RELEASE-MANIFEST.json'
$sumsPath = Join-Path $root 'SHA256SUMS.txt'
$excludedNames = @('RELEASE-MANIFEST.json', 'SHA256SUMS.txt')
$excludedRelativePaths = @(
    'clawmobile-router-proxy/parameter-schema-corpus-manifest.json',
    'phone/phone-site.json',
    'phone/phone.env'
)

$files = @(
    Get-ChildItem -LiteralPath $root -File -Recurse |
        Where-Object {
            $relative = [IO.Path]::GetRelativePath($root, $_.FullName).Replace('\', '/')
            $_.Name -cnotin $excludedNames -and
            $relative -cnotin $excludedRelativePaths -and
            $_.FullName -notmatch '[\\/]__pycache__[\\/]' -and
            $_.Extension -cne '.pyc'
        } |
        Sort-Object FullName
)

$entries = @(
    foreach ($file in $files) {
        $relative = [IO.Path]::GetRelativePath($root, $file.FullName).Replace('\', '/')
        [ordered]@{
            path = $relative
            bytes = [int64]$file.Length
            sha256 = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        }
    }
)

$manifest = [ordered]@{
    schema_version = 1
    package = 'clawmobile-router-test-kit'
    generated_at = [DateTimeOffset]::UtcNow.ToString('o')
    file_count = $entries.Count
    total_bytes = [int64](($files | Measure-Object Length -Sum).Sum)
    exclusions = @('__pycache__/', '*.pyc', 'clawmobile-router-proxy/parameter-schema-corpus-manifest.json', 'phone/phone-site.json', 'phone/phone.env', 'RELEASE-MANIFEST.json', 'SHA256SUMS.txt')
    files = $entries
}

$utf8NoBom = [Text.UTF8Encoding]::new($false)
$manifestJson = ($manifest | ConvertTo-Json -Depth 6).Replace("`r`n", "`n")
[IO.File]::WriteAllText($manifestPath, $manifestJson.TrimEnd() + "`n", $utf8NoBom)
$sumLines = @($entries | ForEach-Object { '{0}  {1}' -f $_.sha256, $_.path })
[IO.File]::WriteAllText($sumsPath, ($sumLines -join "`n") + "`n", $utf8NoBom)

[pscustomobject]@{
    manifest = $manifestPath
    sums = $sumsPath
    file_count = $entries.Count
    total_bytes = $manifest.total_bytes
} | ConvertTo-Json -Compress
