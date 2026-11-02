# 架空シナリオ（eval/scenarios/*/*.json）から、架空の通話音声（WAV, 16kHz モノラル）を作る。
# Windows 標準の音声合成をオフラインで使う。実在の人の声・通話は使わない。
# 使い方: pwsh scripts/make-fake-call.ps1 eval/scenarios/tuning/t7-son-unknown.json audio/t7.wav
param(
  [Parameter(Mandatory)] [string] $Scenario,
  [Parameter(Mandatory)] [string] $Out,
  [int] $PauseMs = 900
)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Speech

$data = Get-Content -Raw -Encoding utf8 $Scenario | ConvertFrom-Json
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$voice = $synth.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -eq "ja-JP" } | Select-Object -First 1
if (-not $voice) { throw "日本語の音声合成ボイスが見つかりません" }
$synth.SelectVoice($voice.VoiceInfo.Name)

# 相手と本人の声を、高さと速さで分ける（同じボイスしかないため）
$style = @{
  caller  = @{ pitch = "low";  rate = "medium" }
  user    = @{ pitch = "high"; rate = "slow" }
  unknown = @{ pitch = "medium"; rate = "medium" }
}
$parts = foreach ($u in $data.utterances) {
  $s = $style[$u.speaker]
  $text = [System.Security.SecurityElement]::Escape($u.text)
  "<prosody pitch=`"$($s.pitch)`" rate=`"$($s.rate)`">$text</prosody><break time=`"$($PauseMs)ms`"/>"
}
$ssml = "<speak version=`"1.0`" xmlns=`"http://www.w3.org/2001/10/synthesis`" xml:lang=`"ja-JP`"><break time=`"500ms`"/>$($parts -join '')</speak>"

$dir = Split-Path -Parent $Out
if ($dir) { New-Item -ItemType Directory -Force $dir | Out-Null }
$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$synth.SetOutputToWaveFile((Resolve-Path -LiteralPath . ).Path + "\" + $Out, $format)
$synth.SpeakSsml($ssml)
$synth.SetOutputToNull()
$synth.Dispose()
Write-Output "作成: $Out （$($data.utterances.Count) 発話, ボイス: $($voice.VoiceInfo.Name)）"
