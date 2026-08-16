# Diver TTS helper (Windows SAPI via PowerShell).
# NOTE: keep this file pure ASCII. PowerShell 5.1 reads .ps1 sources
# without BOM as ANSI (GBK on zh-CN), so any UTF-8 Chinese bytes in
# comments would corrupt parsing of the statements below.
# Usage:
#   speak.ps1 [-Voice <name>]          # read text from stdin and speak
#   speak.ps1 -ListVoices              # print installed voice names, one per line

param(
    [string]$Voice = "",
    [switch]$ListVoices
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer

try {
    if ($ListVoices) {
        $synth.GetInstalledVoices() | ForEach-Object {
            if ($_.Enabled) { $_.VoiceInfo.Name }
        }
        exit 0
    }

    if ($Voice -ne "") {
        try { $synth.SelectVoice($Voice) } catch { }
    }

    # The Rust side writes UTF-8 bytes to stdin. Decode as UTF-8
    # explicitly, otherwise the text is read as the system ANSI codepage
    # (gb2312 on zh-CN) and comes out as garbage.
    [Console]::InputEncoding = [System.Text.Encoding]::UTF8
    $text = [Console]::In.ReadToEnd()
    if ($text -and $text.Trim() -ne "") {
        $synth.Speak($text)
    }
}
finally {
    $synth.Dispose()
}
