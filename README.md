# Transcriptor CLI

A tiny CLI to download a video, extract audio, and transcribe it to text using OpenAI.

## What it does
- Downloads video via yt-dlp
- Extracts audio with ffmpeg
- Sends audio to OpenAI Speech-to-Text and saves the transcript locally

## Requirements
- Node.js 18+
- yt-dlp installed and on PATH
- ffmpeg installed and on PATH

## Setup
Create an .env file and paste your openAI API key
```
cp .env.dist .env

// .env
OPENAI_API_KEY=[your API key]
```

## Usage
```
  npm run transcribe -- "<video_url>"
```

The transcription will be put in the transcript.txt file.
