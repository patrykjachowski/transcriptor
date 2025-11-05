# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Transcriptor CLI is a Node.js tool that downloads videos, extracts audio, and transcribes them using OpenAI's Whisper API. It generates both a full transcript and an AI-generated summary in Polish (configurable).

## Key Dependencies

- **External tools (must be on PATH):**
  - `yt-dlp` - video downloading
  - `ffmpeg` - audio extraction and compression

- **Node.js packages:**
  - `openai` (v4.58.1+) - Whisper transcription and GPT summarization

- **Environment:**
  - Requires `OPENAI_API_KEY` environment variable

## Development Commands

### Running the transcriptor

```bash
# Basic usage
npm run transcribe -- "https://example.com/video"

# Append to existing transcript.txt
npm run transcribe -- --continue "https://example.com/video"
npm run transcribe -- -c "https://example.com/video"

# With custom title
npm run transcribe -- --title "Session Name" "https://example.com/video"
npm run transcribe -- -t "Session Name" "https://example.com/video"

# Combined flags
npm run transcribe -- --continue --title "My Session" "https://example.com/video"
```

## Architecture

The tool follows a linear 5-step pipeline implemented in `src/index.js`:

1. **Video Download** (`downloadVideo`)
   - Uses yt-dlp to download video to temp directory
   - Creates work directory in `os.tmpdir()/transcriptor-cli/`
   - Work dir named using slugified title + timestamp

2. **Audio Extraction** (`extractAudio`)
   - Converts video to Opus-encoded OGG file
   - Default: mono, 16kHz, 24 kbps for small file size
   - Can recompress at 16 kbps if needed

3. **Size Enforcement** (`ensureAudioUnderLimit`)
   - Checks audio file is under 25 MiB API limit
   - Automatically recompresses at lower bitrate if needed
   - Fails with helpful error if still too large

4. **Transcription** (`transcribeAudio`)
   - Calls OpenAI Whisper API with audio file
   - Uses `temperature: 0` for deterministic output

5. **Summarization** (`summarizeText`)
   - Uses GPT-4o-mini to create bulleted summary
   - Chunks large transcripts (>15k chars) for safety
   - Produces final merged summary from partial summaries
   - Default language: Polish (hardcoded in `langPrompt`)

6. **Output** (`buildOutputBlock`)
   - Formats as: Title (optional) → Transcript → Summary
   - Writes to `transcript.txt` in current working directory
   - `--continue` mode appends with `---` separator

## Key Implementation Details

### CLI Argument Parsing
- Custom argument parser in `src/index.js` (no external CLI library)
- Supports `--flag`, `-f`, `--opt=value`, and `--opt value` formats
- Video URL extracted as first non-flag argument (skipping title value)

### Error Handling
- Binary availability checked before execution (`ensureBinary`)
- File existence checked (blocks overwrite unless `--continue`)
- Audio size validated and auto-recompressed if needed
- All pipeline errors bubble up with descriptive messages

### Temporary File Management
- Work directory: `/tmp/transcriptor-cli/{slugified-title}-{timestamp}/`
- Files preserved on error for diagnostics (not auto-cleaned)
- Downloaded video: `video.{ext}`, audio: `audio.ogg`

### Language Configuration
To change output language, modify the `langPrompt` parameter in:
- `summarizeText()` calls (line 323: `'in Polish'`)
- System prompts within `summarizeText()` function

## Common Gotchas

1. **npm script syntax**: Flags must come after `--` when using npm scripts
   - Correct: `npm run transcribe -- --continue "url"`
   - Wrong: `npm run transcribe --continue "url"`

2. **OpenAI API limits**: Audio files must be ≤25 MiB. The tool auto-compresses, but very long videos may still fail.

3. **File overwrite protection**: Running without `--continue` on existing `transcript.txt` will error. This is intentional to prevent accidental data loss.

4. **Working directory**: Output always writes to `./transcript.txt` in current working directory, not the script location.

## Output Format

```markdown
## {custom title if provided}
### 📖 Transcript
{full transcription}

### 📋 Summary
- {bullet point 1}
- {bullet point 2}
...
```

When using `--continue`, entries are separated by `---`.
