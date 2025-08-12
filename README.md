# Transcriptor CLI (MVP)

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
Create an .env file and paste your OpenAI API key