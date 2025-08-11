#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { basename, resolve, extname } from 'node:path';
import OpenAI from 'openai';

// Simple arg parsing
const args = process.argv.slice(2);
let url = null;
let filePath = null;
let outPath = 'transcript.txt';
let clean = true; // default to cleaning artifacts before running

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (!a.startsWith('--')) {
    // first non-flag is URL
    if (!url && !a.startsWith('-')) url = a;
    continue;
  }
  if (a === '--file') {
    filePath = args[i + 1];
    i++;
  } else if (a === '--out') {
    outPath = args[i + 1];
    i++;
  } else if (a === '--clean') {
    clean = true;
  } else if (a === '--no-clean') {
    clean = false;
  } else if (a === '--help' || a === '-h') {
    printHelp();
    process.exit(0);
  }
}

function printHelp() {
  console.log(`Transcriptor CLI

Usage:
  transcriptor "\u003cvideo_url\u003e" [--no-clean] [--out <file>]
  transcriptor --file ./video.mp4 [--no-clean] [--out <file>]

Options:
  --out <file>  Output transcript filename (default: transcript.txt)
  --clean       Force cleaning (default behavior)
  --no-clean    Skip removing video.mp4, audio.m4a, and transcript.txt before running

Env:
  OPENAI_API_KEY required
`);
}

if (process.env.OPENAI_API_KEY == null) {
  console.error('Error: OPENAI_API_KEY is not set');
  process.exit(1);
}

if (!url && !filePath) {
  printHelp();
  console.error('\nError: Provide a video URL or --file path');
  process.exit(1);
}

const client = new OpenAI();

async function cleanArtifacts() {
  const targets = ['video.mp4', 'audio.m4a', 'transcript.txt'];
  for (const name of targets) {
    const p = resolve(name);
    try {
      await fs.unlink(p);
      console.log(`Removed ${name}`);
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        // ignore missing
      } else {
        console.warn(`Could not remove ${name}: ${err.message || err}`);
      }
    }
  }
}

async function run() {
  if (clean) {
    await cleanArtifacts();
  }

  let mediaPath = filePath;

  if (url) {
    // Download using the exact approach requested
    // yt-dlp -f mp4 -o "<FILENAME>" "<URL>"
    const outFile = 'video.mp4';
    console.log(`Downloading video to ${outFile} ...`);
    await execFilePromise('yt-dlp', ['-f', 'mp4', '-o', outFile, url]);
    mediaPath = resolve(outFile);
  }

  if (!existsSync(mediaPath)) {
    console.error(`File not found: ${mediaPath}`);
    process.exit(1);
  }

  // If input looks like a video container, extract audio first for best stability
  const ext = extname(mediaPath).toLowerCase();
  const looksLikeVideo = ['.mp4', '.mov', '.mkv', '.webm'].includes(ext);
  if (looksLikeVideo) {
    const audioOut = resolve('audio.m4a');
    console.log(`Extracting audio with ffmpeg -> ${basename(audioOut)} ...`);
    // -vn: drop video, -c:a aac keeps audio only in m4a container
    await execFilePromise('ffmpeg', ['-y', '-i', mediaPath, '-vn', '-c:a', 'aac', '-b:a', '128k', audioOut]);
    mediaPath = audioOut;
  }

  // Transcribe using official OpenAI SDK per docs
  // https://platform.openai.com/docs/guides/speech-to-text
  console.log('Transcribing with OpenAI Whisper ...');

  // The SDK accepts a file stream or blob
  const getStream = () => createReadStream(mediaPath);

  const maxAttempts = 3;
  let transcription;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      transcription = await client.audio.transcriptions.create({
        file: getStream(),
        model: 'gpt-4o-mini-transcribe'
      });
      break;
    } catch (err) {
      const msg = String(err?.message || err);
      const isConn = /ECONN|ENOTFOUND|ETIMEDOUT|ECONNRESET|EAI_AGAIN|Network|fetch failed/i.test(msg);
      const isBadReq = /400|Bad Request|something went wrong reading your request/i.test(msg);
      if (isBadReq) {
        console.error('OpenAI API returned 400. Ensure the file exists and is a supported audio/video format (mp3, mp4, m4a, wav).');
      }
      if (!isConn || attempt === maxAttempts) {
        throw err;
      }
      const delay = 500 * attempt;
      console.error(`Transient connection issue, retrying in ${delay}ms (attempt ${attempt}/${maxAttempts})...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }

  const text = transcription.text ?? (typeof transcription === 'string' ? transcription : JSON.stringify(transcription));

  await fs.writeFile(resolve(outPath), text, 'utf8');
  console.log(`Saved transcript to ${outPath}`);
}

function execFilePromise(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { ...opts });
    child.stdout?.on('data', (d) => process.stdout.write(d));
    child.stderr?.on('data', (d) => process.stderr.write(d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with code ${code}`));
    });
  });
}

run().catch((err) => {
  console.error('Failed:', err.message || err);
  process.exit(1);
});

