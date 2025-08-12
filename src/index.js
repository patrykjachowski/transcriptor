// Node.js standard libs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

// If you use a .env file, uncomment the line below and ensure the "dotenv" package is installed
// import 'dotenv/config';

import OpenAI from 'openai';

/**
 * Transcriptor CLI
 * - Accepts a video URL as a positional argument.
 * - If --continue is passed, appends the new transcript to transcript.txt, separated by a line.
 * - Without --continue, it will fail if transcript.txt already exists (no prompts).
 *
 * Usage:
 *   npm run transcribe -- [--continue] [--title "<custom_title>"] "<video_url>"
 *
 * Note: When running via npm scripts, pass flags after a double dash:
 *   npm run transcribe -- --continue "https://example.com/video"
 */

const args = process.argv.slice(2);

// Flags
const hasFlag = (name) => args.includes(name);
const shouldContinue = hasFlag('--continue') || hasFlag('-c');

// Parse option values (supports --opt=val, --opt val, and -o val)
function getOption(longName, shortName) {
  const withEq = args.find(
    (a) => a.startsWith(`${longName}=`) || (shortName && a.startsWith(`${shortName}=`))
  );
  if (withEq) return withEq.split('=').slice(1).join('=');

  const longIdx = args.indexOf(longName);
  const shortIdx = shortName ? args.indexOf(shortName) : -1;
  const i = longIdx !== -1 ? longIdx : shortIdx;
  if (i !== -1 && args[i + 1] && !args[i + 1].startsWith('-')) return args[i + 1];

  return null;
}

// Custom title from CLI
const customTitle = getOption('--title', '-t');

// Determine the video URL while skipping the value provided for --title/-t
const videoUrl = (() => {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('-')) continue;
    const prev = i > 0 ? args[i - 1] : null;
    if (prev === '--title' || prev === '-t') continue; // skip the value provided for the title option
    return a;
  }
  return null;
})();

if (!videoUrl) {
  console.error(
'Usage:\n' +
      '  npm run transcribe -- [--continue|-c] [--title "\u003ccustom_title\u003e"] "\u003cvideo_url\u003e"\n\n' +
      'Examples:\n' +
      '  npm run transcribe -- "https://example.com/video"\n' +
      '  npm run transcribe -- --continue --title "My title" "https://example.com/video"'
  );
  process.exit(1);
}

if (!process.env.OPENAI_API_KEY) {
  console.error(
'Missing OPENAI_API_KEY. Set the environment variable or configure a .env file.\n' +
      'Example:\n' +
      '  OPENAI_API_KEY=\u003cYOUR_KEY\u003e npm run transcribe -- "\u003cvideo_url\u003e"'
  );
  process.exit(1);
}

// ===== Implementation steps 1–5 =====
const outFile = path.resolve(process.cwd(), 'transcript.txt');
const tmpRoot = path.join(os.tmpdir(), 'transcriptor-cli');

// Safe working directory name derived from title or timestamp
function slugify(s) {
  return String(s)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 80) || `job-${Date.now()}`;
}

// Simple spawn wrapper returning a Promise
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      if (code === 0) resolve({ code, stdout, stderr });
      else reject(Object.assign(new Error(`${cmd} exited with code ${code}\n${stderr || stdout}`), { code, stdout, stderr }));
    });
  });
}

// Check required binaries are available
async function ensureBinary(cmd, versionArg = ['--version']) {
  try {
    await run(cmd, versionArg);
  } catch (err) {
    if (err.code === undefined && err.message.includes('spawn')) {
      // ENOENT
      console.error(`Could not find tool "${cmd}" in PATH. Please install it and try again.`);
    } else {
      console.error(`Problem launching "${cmd}":\n${err.message}`);
    }
    process.exit(1);
  }
}

async function getRemoteTitle(url) {
  try {
    const { stdout } = await run('yt-dlp', ['-e', url]);
    const title = stdout.trim().split('\n').filter(Boolean)[0];
    return title || null;
  } catch {
    return null;
  }
}

async function downloadVideo(url, workDir) {
// Save as video.<ext>, then detect the actual file
  const outTpl = path.join(workDir, 'video.%(ext)s');
  const args = [
    '--no-playlist',
    '--restrict-filenames',
    '-o',
    outTpl,
    url,
  ];
  // Quiet logging without losing errors
  args.push('--no-warnings', '-q');

  console.log('1/5 Downloading video (yt-dlp)...');
  await run('yt-dlp', args);

  // Find the downloaded file matching "video.*"
  const files = fs.readdirSync(workDir).filter((f) => f.startsWith('video.'));
  if (!files.length) throw new Error('Failed to identify the downloaded video file.');
  return path.join(workDir, files[0]);
}

async function extractAudio(inputVideoPath, outputAudioPath) {
  console.log('2/5 Extracting audio (ffmpeg)...');
  // PCM WAV mono 16k – transcription-friendly format
  const args = [
    '-y',
    '-i',
    inputVideoPath,
    '-ac',
    '1',
    '-ar',
    '16000',
    '-vn',
    '-f',
    'wav',
    outputAudioPath,
  ];
  await run('ffmpeg', args);
}

function chunkString(str, size) {
  const chunks = [];
  for (let i = 0; i < str.length; i += size) chunks.push(str.slice(i, i + size));
  return chunks;
}

async function summarizeText(openai, text, langPrompt = 'in Polish') {
  // Simple length-robust approach: chunked summaries + final merge
  const model = 'gpt-4o-mini';
  const maxChunk = 15000; // characters; safe context buffer
  if (text.length <= maxChunk) {
    const r = await openai.chat.completions.create({
      model,
      temperature: 0.3,
      messages: [
        { role: 'system', content: `You are a helpful assistant creating concise summaries ${langPrompt} as a bullet list. Return only bullets starting with '- ', with no preface or conclusion.` },
        { role: 'user', content: `List the most important points from the transcript as a bullet list (each bullet starts with '- '):\n\n${text}` },
      ],
    });
    return (r.choices?.[0]?.message?.content || '').trim();
  }

  const chunks = chunkString(text, maxChunk);
  const partials = [];
  for (let i = 0; i < chunks.length; i++) {
    const r = await openai.chat.completions.create({
      model,
      temperature: 0.3,
      messages: [
        { role: 'system', content: `Summarize content ${langPrompt} as a bullet list. Return only bullets starting with '- '.` },
        { role: 'user', content: `Summarize part ${i + 1}/${chunks.length} as a bullet list (each bullet starts with '- '):\n\n${chunks[i]}` },
      ],
    });
    partials.push((r.choices?.[0]?.message?.content || '').trim());
  }

  const final = await openai.chat.completions.create({
    model,
    temperature: 0.3,
    messages: [
      { role: 'system', content: `Combine the partial summaries ${langPrompt} into one concise, logically ordered bullet list. Deduplicate. Return only bullets, each line starting with '- '.` },
      { role: 'user', content: partials.join('\n\n') },
    ],
  });
  return (final.choices?.[0]?.message?.content || '').trim();
}

async function transcribeAudio(openai, audioPath) {
  console.log('3/5 Transcription (OpenAI Whisper)...');
  const res = await openai.audio.transcriptions.create({
    file: fs.createReadStream(audioPath),
    model: 'whisper-1',
    temperature: 0,
  });
  const text = (res?.text || '').trim();
  if (!text) throw new Error('Received empty transcription.');
  return text;
}

function buildOutputBlock({ titleIfProvided, summary, transcript }) {
  const lines = [];
  if (titleIfProvided) {
    lines.push(`## ${titleIfProvided}`);
    lines.push('');
  }
  lines.push('### Summary');
  lines.push(summary || '(none)');
  lines.push('');
  lines.push('### Transcript');
  lines.push(transcript);
  lines.push('');
  return lines.join('\n');
}

async function main() {
  // Required CLI tools
  await ensureBinary('yt-dlp');
  // ffmpeg uses single-dash options; use -version instead of --version
  await ensureBinary('ffmpeg', ['-version']);

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  // Output file check
  if (!shouldContinue && fs.existsSync(outFile)) {
    console.error(
      `File ${path.basename(outFile)} already exists. Use --continue to append another transcription,\n` +
        'or remove/move the existing file.'
    );
    process.exit(1);
  }

  // Prepare working directory
  const suggestTitle = customTitle || (await getRemoteTitle(videoUrl)) || `Transcription ${new Date().toISOString().slice(0, 19)}`;
  const workDir = path.join(tmpRoot, `${slugify(suggestTitle)}-${Date.now()}`);
  fs.mkdirSync(workDir, { recursive: true });

  try {
    // 1. Download video
    const videoPath = await downloadVideo(videoUrl, workDir);

    // 2. Extract audio
    const audioPath = path.join(workDir, 'audio.wav');
    await extractAudio(videoPath, audioPath);

    // 3. Transcription
    const transcript = await transcribeAudio(openai, audioPath);

    // 4. Summarization
    console.log('4/5 Summarizing (OpenAI)...');
    const summary = await summarizeText(openai, transcript, 'in Polish');

    // 5. Write to transcript.txt
    console.log('5/5 Writing to transcript.txt...');
    const block = buildOutputBlock({
      titleIfProvided: customTitle || null,
      summary,
      transcript,
    });

    if (shouldContinue && fs.existsSync(outFile)) {
      const existing = fs.readFileSync(outFile, 'utf8');
      const needsNl = existing.endsWith('\n') ? '' : '\n';
      const separator = '---\n\n';
      fs.appendFileSync(outFile, needsNl + separator + block + '\n', 'utf8');
    } else {
      fs.writeFileSync(outFile, block + '\n', { flag: 'w', encoding: 'utf8' });
    }

    console.log('Done! Output saved to:', outFile);
  } catch (err) {
    console.error('Error:', err.message || err);
    process.exit(1);
  } finally {
    // Optional cleanup (we keep working files on error for diagnostics)
    // If you want to always remove the working directory, uncomment below:
    // try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
  }
}

main();