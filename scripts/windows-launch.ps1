$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$ChromeProcess = $null
$WebSocket = $null
$script:MessageId = 0
$script:RoomReady = $false
$TemporaryProfile = $false
[Console]::Out.WriteLine('BOT_STAGE:script carregado')
[Console]::Out.Flush()

function Receive-Cdp {
  $buffer = New-Object byte[] 65536
  $stream = New-Object System.IO.MemoryStream
  do {
    $segment = [System.ArraySegment[byte]]::new($buffer)
    $result = $WebSocket.ReceiveAsync($segment, [System.Threading.CancellationToken]::None).GetAwaiter().GetResult()
    if ($result.MessageType -eq [System.Net.WebSockets.WebSocketMessageType]::Close) {
      throw 'Chrome DevTools disconnected'
    }
    $stream.Write($buffer, 0, $result.Count)
  } until ($result.EndOfMessage)
  return ([Text.Encoding]::UTF8.GetString($stream.ToArray()) | ConvertFrom-Json)
}

function Send-Cdp([string]$Method, [hashtable]$Params) {
  $script:MessageId++
  $id = $script:MessageId
  $json = @{ id = $id; method = $Method; params = $Params } | ConvertTo-Json -Compress -Depth 12
  $bytes = [Text.Encoding]::UTF8.GetBytes($json)
  $segment = [System.ArraySegment[byte]]::new($bytes)
  $WebSocket.SendAsync($segment, [System.Net.WebSockets.WebSocketMessageType]::Text, $true, [System.Threading.CancellationToken]::None).GetAwaiter().GetResult()
  while ($true) {
    $message = Receive-Cdp
    if ($message.method -eq 'Runtime.bindingCalled' -and $message.params.name -eq '__haxballBotReady' -and $message.params.payload -eq 'ready') {
      $script:RoomReady = $true
    }
    if ($message.id -eq $id) {
      if ($message.error) { throw $message.error.message }
      return $message.result
    }
  }
}

try {
  if (-not $BotProfileDir) {
    $BotProfileDir = Join-Path ([System.IO.Path]::GetTempPath()) ('bot-haxball-chrome-' + [Guid]::NewGuid().ToString('N'))
    $TemporaryProfile = $true
  }
  if ($BotPort -gt 0) {
    $endpoint = "http://127.0.0.1:$BotPort"
    try {
      $existing = Invoke-RestMethod "$endpoint/json/version" -TimeoutSec 2
      if ($existing) { throw "Port $BotPort is already used by Chrome" }
    } catch {
      if ($_.Exception.Message -like '*already used*') { throw }
    }
  }
  $arguments = @(
    '--remote-debugging-address=127.0.0.1',
    "--remote-debugging-port=$BotPort",
    ('--user-data-dir="' + $BotProfileDir + '"'),
    '--no-first-run'
  )
  if ($BotHeadless) { $arguments += '--headless=new' }
  $arguments += 'about:blank'
  $ChromeProcess = Start-Process -FilePath $BotChromePath -ArgumentList $arguments -PassThru
  [Console]::Out.WriteLine('BOT_STAGE:Chrome iniciado')
  [Console]::Out.Flush()

  $deadline = (Get-Date).AddSeconds(45)
  $version = $null
  while ((Get-Date) -lt $deadline) {
    if ($ChromeProcess.HasExited) { throw 'Chrome exited before DevTools became available' }
    if ($BotPort -eq 0) {
      # Chrome DevTools Protocol documents DevToolsActivePort for --remote-debugging-port=0.
      # https://chromedevtools.github.io/devtools-protocol/
      $portFile = Join-Path $BotProfileDir 'DevToolsActivePort'
      if (Test-Path $portFile) {
        try {
          $portLine = Get-Content $portFile -TotalCount 1
          if ($portLine -match '^\d+$') { $BotPort = [int]$portLine }
        } catch { Start-Sleep -Milliseconds 250 }
      }
    }
    if ($BotPort -eq 0) { Start-Sleep -Milliseconds 250; continue }
    $endpoint = "http://127.0.0.1:$BotPort"
    try { $version = Invoke-RestMethod "$endpoint/json/version" -TimeoutSec 2; break }
    catch { Start-Sleep -Milliseconds 250 }
  }
  if (-not $version) { throw 'Chrome did not open its DevTools port' }
  [Console]::Out.WriteLine('BOT_STAGE:DevTools conectado')
  [Console]::Out.Flush()
  # Windows PowerShell can keep a JSON array as one pipeline value. Parse the
  # response and select a single page object before reading its WebSocket URL.
  $targetListResponse = Invoke-WebRequest "$endpoint/json/list" -UseBasicParsing -TimeoutSec 5
  $targets = ConvertFrom-Json -InputObject $targetListResponse.Content
  $target = $null
  foreach ($candidate in $targets) {
    if ($candidate.type -eq 'page' -and $candidate.url -eq 'about:blank') {
      $target = $candidate
      break
    }
  }
  if (-not $target) { $target = Invoke-RestMethod -Method Put "$endpoint/json/new?about:blank" -TimeoutSec 5 }
  if ($target.webSocketDebuggerUrl -isnot [string] -or -not $target.webSocketDebuggerUrl) {
    throw 'Chrome did not return one page WebSocket URL'
  }

  $WebSocket = [System.Net.WebSockets.ClientWebSocket]::new()
  $WebSocket.ConnectAsync([Uri]$target.webSocketDebuggerUrl, [System.Threading.CancellationToken]::None).GetAwaiter().GetResult()
  [Console]::Out.WriteLine('BOT_STAGE:WebSocket conectado')
  [Console]::Out.Flush()
  $sourceLine = [Console]::In.ReadLine()
  if (-not $sourceLine) { throw 'Bootstrap source was not provided' }
  $source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($sourceLine))
  [Console]::Out.WriteLine('BOT_STAGE:bootstrap recebido')
  [Console]::Out.Flush()
  Send-Cdp 'Page.enable' @{} | Out-Null
  Send-Cdp 'Runtime.enable' @{} | Out-Null
  Send-Cdp 'Runtime.addBinding' @{ name = '__haxballBotReady' } | Out-Null
  Send-Cdp 'Page.addScriptToEvaluateOnNewDocument' @{ source = $source } | Out-Null
  [Console]::Out.WriteLine('BOT_STAGE:bootstrap injetado')
  [Console]::Out.Flush()
  $navigation = Send-Cdp 'Page.navigate' @{ url = 'https://html5.haxball.com/headless' }
  if ($navigation.errorText) { throw ('Headless navigation failed: ' + $navigation.errorText) }
  Send-Cdp 'Page.bringToFront' @{} | Out-Null
  [Console]::Out.WriteLine('BOT_PAGE')
  [Console]::Out.Flush()

  while (-not $script:RoomReady) {
    $message = Receive-Cdp
    if ($message.method -eq 'Runtime.bindingCalled' -and $message.params.name -eq '__haxballBotReady' -and $message.params.payload -eq 'ready') {
      $script:RoomReady = $true
    }
  }
  [Console]::Out.WriteLine('BOT_READY')
  [Console]::Out.Flush()
  while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line -or $line -eq 'stop') { break }
  }
} catch {
  $detail = [Text.Encoding]::UTF8.GetBytes([string]$_.Exception.Message)
  [Console]::Out.WriteLine('BOT_ERROR_B64:' + [Convert]::ToBase64String($detail))
  [Console]::Out.Flush()
  exit 1
} finally {
  if ($WebSocket -and $WebSocket.State -eq [System.Net.WebSockets.WebSocketState]::Open) {
    try { Send-Cdp 'Browser.close' @{} | Out-Null } catch {}
    $WebSocket.Dispose()
  }
  if ($ChromeProcess -and -not $ChromeProcess.HasExited) {
    try { Stop-Process -Id $ChromeProcess.Id -Force } catch {}
  }
  if ($TemporaryProfile -and (Test-Path $BotProfileDir)) {
    try { Remove-Item $BotProfileDir -Recurse -Force } catch {}
  }
}
