# Transcriptor CLI (MVP)

A small CLI to download a video, extract audio, and transcribe it with OpenAI Whisper. It writes a Markdown summary (bulleted) and full transcript to transcript.txt.

## Requirements
- Node.js 18+
- yt-dlp on PATH
- ffmpeg on PATH
- OPENAI_API_KEY with access to Whisper

## Setup
1) Install deps:

   npm install

2) Provide your API key:

   export OPENAI_API_KEY="<YOUR_KEY>"

## Usage
- Basic:

  npm run transcribe -- "https://example.com/video"

- Append to existing file (adds a separator automatically):

  npm run transcribe -- --continue "https://example.com/video"

- With a custom title (rendered as "## <title>"):

  npm run transcribe -- --title "My Session" "https://example.com/video"

- Short flag for continue:

  npm run transcribe -- -c "https://example.com/video"

Default output language: Polish (change in src/index.js if needed).
