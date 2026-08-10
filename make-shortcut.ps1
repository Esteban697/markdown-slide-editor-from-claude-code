# Creates (or refreshes) a "Markdown Viewer" shortcut on the Desktop.
# Re-run this if you move the project folder.

$project  = $PSScriptRoot
$electron = Join-Path $project 'node_modules\electron\dist\electron.exe'

if (-not (Test-Path $electron)) {
    throw "Electron not found at $electron - run 'npm install' first."
}

$desktop  = [Environment]::GetFolderPath('Desktop')
$linkPath = Join-Path $desktop 'Markdown Viewer.lnk'

$shell = New-Object -ComObject WScript.Shell
$link  = $shell.CreateShortcut($linkPath)
$link.TargetPath       = $electron
$link.Arguments        = '"' + $project + '"'
$link.WorkingDirectory = $project
$link.IconLocation     = "$electron,0"
$link.Description      = 'Dark-mode markdown viewer'
$link.Save()

"Created: $linkPath"
"Target:  $electron"
"Args:    `"$project`""
