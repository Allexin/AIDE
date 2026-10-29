# Unreal Engine actions for the AIDE toolbar and pipeline checks.
#   powershell -NoProfile -ExecutionPolicy Bypass -File aide/scripts/ue.ps1 <action>
# The engine is resolved from the .uproject's EngineAssociation, so the same
# command works on every machine and needs no ${unrealEngine} from the caller.
param([Parameter(Mandatory)][string]$Action)
$ErrorActionPreference = 'Stop'

$root = Split-Path (Split-Path $PSScriptRoot)
$uproject = Get-ChildItem $root -Filter *.uproject | Select-Object -First 1
if (-not $uproject) { throw "No .uproject in $root" }
$name = $uproject.BaseName

function Resolve-Engine {
    $assoc = (Get-Content $uproject.FullName -Raw | ConvertFrom-Json).EngineAssociation
    if ($assoc -match '^\d+\.\d+$') {
        $key = "HKLM:\SOFTWARE\EpicGames\Unreal Engine\$assoc"
        $dir = (Get-ItemProperty $key -Name InstalledDirectory -ErrorAction SilentlyContinue).InstalledDirectory
    } else {
        $dir = (Get-ItemProperty 'HKCU:\Software\Epic Games\Unreal Engine\Builds' -Name $assoc -ErrorAction SilentlyContinue).$assoc
    }
    if (-not $dir -or -not (Test-Path "$dir\Engine\Binaries\Win64")) { throw "Engine '$assoc' is not installed" }
    return $dir
}

function Run([string]$exe, [string[]]$argv) {
    Write-Host "> $exe $($argv -join ' ')"
    & $exe @argv
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

$proj = $uproject.FullName
switch ($Action) {
    'clean' {
        foreach ($d in 'Binaries', 'Intermediate', 'DerivedDataCache', 'Saved\Cooked', 'Build\Package', '.vs') {
            $p = Join-Path $root $d
            if (Test-Path $p) { Write-Host "removing $d"; Remove-Item -Recurse -Force $p }
        }
        Get-ChildItem $root -Filter *.sln | Remove-Item -Force
        Write-Host 'clean'
        exit 0
    }
    'log' {
        $log = Join-Path $root "Saved\Logs\$name.log"
        if (-not (Test-Path $log)) { throw "No log yet: $log" }
        Start-Process $log
        exit 0
    }
    'vs' {
        $sln = Get-ChildItem $root -Filter *.sln | Select-Object -First 1
        if (-not $sln) { throw 'No .sln yet: run Generate Project Files first' }
        Start-Process $sln.FullName
        exit 0
    }
}

$engine = Resolve-Engine
$bat = "$engine\Engine\Build\BatchFiles"
$editor = "$engine\Engine\Binaries\Win64\UnrealEditor.exe"
$editorCmd = "$engine\Engine\Binaries\Win64\UnrealEditor-Cmd.exe"

switch ($Action) {
    'genfiles'     { Run "$engine\Engine\Binaries\DotNET\UnrealBuildTool\UnrealBuildTool.exe" @('-projectfiles', "-project=$proj", '-game', '-rocket', '-progress') }
    'build-editor' { Run "$bat\Build.bat" @("${name}Editor", 'Win64', 'Development', "-Project=$proj", '-WaitMutex') }
    'build-game'   { Run "$bat\Build.bat" @($name, 'Win64', 'Development', "-Project=$proj", '-WaitMutex') }
    'editor'       { Start-Process $editor -ArgumentList "`"$proj`"" }
    'play'         { Start-Process $editor -ArgumentList "`"$proj`" -game -windowed -ResX=1280 -ResY=720 -log" }
    'tests'        { Run $editorCmd @($proj, "-ExecCmds=Automation RunTests $name;Quit", '-unattended', '-nullrhi', '-nopause', '-nosplash', '-stdout', '-FullStdOutLogOutput') }
    'cook'         { Run $editorCmd @($proj, '-run=cook', '-targetplatform=Windows', '-unattended', '-stdout') }
    'package'      { Run "$bat\RunUAT.bat" @('BuildCookRun', "-project=$proj", '-noP4', '-platform=Win64', '-clientconfig=Shipping', '-build', '-cook', '-stage', '-pak', '-archive', "-archivedirectory=$root\Build\Package", '-utf8output') }
    default        { throw "Unknown action '$Action'" }
}
