# Transcriptor CLI

A tiny CLI to download a video, extract audio, and transcribe it to text using OpenAI.

What it does
- Downloads video via yt-dlp
- Extracts audio with ffmpeg
- Sends audio to OpenAI Speech-to-Text and saves the transcript locally

Requirements
- Node.js 18+
- yt-dlp installed and on PATH
- ffmpeg installed and on PATH
- OpenAI API key exported: `export OPENAI_API_KEY=...`

Quick start
- URL input (preferred):
  npm run transcribe -- "<video_url>"
- Local file input (mp4/mp3/wav):
  npm run transcribe -- --file ./video.mp4

Defaults
- Output file: transcript.txt (override with --out <file>)
- Cleaning: removes video.mp4, audio.m4a, and transcript.txt before each run by default (disable with --no-clean)

Examples
- Transcribe a remote URL and write to default transcript.txt:
  npm run transcribe -- "https://example.com/video.mp4"
- Transcribe a local file and write to notes.txt:
  npm run transcribe -- --file ./talk.mp4 --out notes.txt

Alternative invocation
- You can also run via npx (uses the "bin" entry):
  npx transcriptor "<video_url>"

Notes
- Download command used: yt-dlp -f mp4 -o video.mp4 <url>
- For video inputs (.mp4/.mov/.mkv/.webm), audio is extracted to audio.m4a before transcription.
- Model: gpt-4o-mini-transcribe (official OpenAI SDK)
