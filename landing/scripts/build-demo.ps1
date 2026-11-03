# Rebuild the demo video from the recorded GIF.
#
#   pwsh landing/scripts/build-demo.ps1
#
# The source GIF is 15 MB. That is fine in a README and unacceptable on a
# landing page, so it is transcoded once here and committed: the site build
# never needs ffmpeg, and Cloudflare never sees a 15 MB first paint.
#
# Requires ffmpeg on PATH (winget install Gyan.FFmpeg) and runs from the repo
# root; paths below are relative to it.

$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$source = Join-Path $repo 'video/alnair.gif'
$out = Join-Path $repo 'landing/static/media'

if (-not (Test-Path $source)) {
    throw "missing source recording: $source"
}

New-Item -ItemType Directory -Force -Path $out | Out-Null

Write-Host 'Encoding MP4 (H.264)…'
# CRF 25 at 1112px is visually lossless for flat terminal colours and lands
# under 600 KB for the 27-second recording.
ffmpeg -y -v error -i $source `
    -vf "scale=1112:-2:flags=lanczos" `
    -c:v libx264 -crf 25 -preset slow -pix_fmt yuv420p `
    -movflags +faststart -an (Join-Path $out 'alnair-demo.mp4')

Write-Host 'Encoding WebM (VP9)…'
ffmpeg -y -v error -i $source `
    -vf "scale=1112:-2:flags=lanczos" `
    -c:v libvpx-vp9 -crf 34 -b:v 0 -row-mt 1 -an (Join-Path $out 'alnair-demo.webm')

Write-Host 'Extracting the poster…'
# The welcome screen: it names the product, and it is the frame that reads
# best as a still.
ffmpeg -y -v error -ss 6 -i $source -frames:v 1 -q:v 4 (Join-Path $out 'alnair-demo-poster.jpg')

Get-ChildItem $out | Select-Object Name, @{ n = 'KB'; e = { [math]::Round($_.Length / 1KB) } }
