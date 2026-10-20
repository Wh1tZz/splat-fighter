# Splat Fighter local server - serves this folder on http://localhost:8080
# Usage: powershell -ExecutionPolicy Bypass -File serve.ps1 [-Port 8080] [-Open]
#   -Open  opens the game in the default browser once the server is up
#   If the port is taken, the next free port (up to +10) is used.
param([int]$Port = 8080, [switch]$Open)

$root = [System.IO.Path]::GetFullPath($PSScriptRoot)
$mime = @{
  '.html' = 'text/html; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8'; '.mjs' = 'text/javascript; charset=utf-8'
  '.css' = 'text/css; charset=utf-8'; '.json' = 'application/json'; '.png' = 'image/png'; '.jpg' = 'image/jpeg'
  '.webp' = 'image/webp'; '.svg' = 'image/svg+xml'; '.wasm' = 'application/wasm'; '.glb' = 'model/gltf-binary'
  '.spz' = 'application/octet-stream'; '.vsplat' = 'application/octet-stream'; '.ply' = 'application/octet-stream'
  '.ico' = 'image/x-icon'; '.map' = 'application/json'}

$listener = $null
foreach ($p in $Port..($Port + 10)) {
  try {
    $l = New-Object System.Net.HttpListener
    $l.Prefixes.Add("http://localhost:$p/")
    $l.Start()
    $listener = $l; $Port = $p
    break
  } catch { }
}
if (-not $listener) { Write-Host "No free port between $Port and $($Port + 10)."; exit 1 }
Write-Host "Splat Fighter running at http://localhost:$Port/  (close this window to stop)"
if ($Open) { Start-Process "http://localhost:$Port/" }

try {
  while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    $res = $ctx.Response
    try {
      # dev-only: the page can POST a canvas capture here for debugging
      if ($ctx.Request.HttpMethod -eq 'POST' -and $ctx.Request.Url.AbsolutePath -eq '/__shot') {
        $dir = Join-Path $root '.debug'
        if (-not (Test-Path $dir)) { New-Item -ItemType Directory $dir | Out-Null }
        $name = $ctx.Request.QueryString['name']; if (-not $name -or $name -notmatch '^[\w-]+$') { $name = 'shot' }
        $fs = [System.IO.File]::Create((Join-Path $dir "$name.png"))
        $ctx.Request.InputStream.CopyTo($fs); $fs.Close()
        $bytes = [Text.Encoding]::UTF8.GetBytes('ok')
        $res.ContentLength64 = $bytes.Length
        $res.OutputStream.Write($bytes, 0, $bytes.Length)
        continue
      }
      $rel = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath.TrimStart('/'))
      if ($rel -eq '') { $rel = 'index.html' }
      $path = [System.IO.Path]::GetFullPath((Join-Path $root $rel))
      if (-not $path.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path $path -PathType Leaf)) {
        $res.StatusCode = 404
        $bytes = [Text.Encoding]::UTF8.GetBytes('Not found')
      } else {
        $ext = [System.IO.Path]::GetExtension($path).ToLower()
        $res.ContentType = if ($mime.ContainsKey($ext)) { $mime[$ext] } else { 'application/octet-stream' }
        $versionedAsset = $ctx.Request.QueryString['v'] -and $ext -in @('.glb', '.spz', '.vsplat', '.gz')
        if ($versionedAsset) {
          $res.Headers.Add('Cache-Control', 'public, max-age=31536000, immutable')
        } else {
          $res.Headers.Add('Cache-Control', 'no-cache')
        }
        $bytes = [System.IO.File]::ReadAllBytes($path)
      }
      $res.ContentLength64 = $bytes.Length
      if ($ctx.Request.HttpMethod -ne 'HEAD') { $res.OutputStream.Write($bytes, 0, $bytes.Length) }
    } catch {
      $res.StatusCode = 500
    } finally {
      $res.OutputStream.Close()
    }
  }
} finally {
  $listener.Stop()
}
