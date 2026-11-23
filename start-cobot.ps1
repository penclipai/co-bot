# 启动或重启 co-bot 后台守护进程（跨平台通用逻辑在 scripts\daemon.js）。用法：.\start-cobot.ps1
$app = Split-Path -Parent $MyInvocation.MyCommand.Path
& node --no-deprecation "$app\scripts\daemon.js" restart @args
exit $LASTEXITCODE
