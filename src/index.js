// Node.js standard libs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

// .env file is loaded automatically via Node's --env-file flag in package.json

import OpenAI from 'openai';

/**
 * Transcriptor CLI
 * - Two modes: single file or batch queue
 *
 * BATCH MODE (Default):
 *   If no video argument provided, processes all .mp4 files in ./videos folder
 *   Skips files that are already transcribed or have existing output files
 *   Processes one by one sequentially
 *
 * SINGLE FILE MODE:
 *   npm run transcribe -- [--continue] [--title "<custom_title>"] "<video_url_or_path>"
 *   - Output filename is determined by: custom title > remote/local filename > timestamp
 *   - If --continue is passed, appends to existing file with that name
 *   - Without --continue, it will fail if the output file already exists
 *
 * Examples:
 *   npm run transcribe                                      → processes ./videos/*.mp4
 *   npm run transcribe -- "https://example.com/video"      → single file, uses remote title
 *   npm run transcribe -- "./my-video.mp4"                 → single file, outputs to my-video.txt
 *   npm run transcribe -- --title "Session 1" "url"        → outputs to session-1.txt
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

// Determine the video URL or file path while skipping the value provided for --title/-t
const videoInput = (() => {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('-')) continue;
    const prev = i > 0 ? args[i - 1] : null;
    if (prev === '--title' || prev === '-t') continue; // skip the value provided for the title option
    return a;
  }
  return null;
})();

// If no videoInput is provided and no OPENAI_API_KEY, show early error
// Otherwise will proceed to batch mode or validate single file mode later

if (!process.env.OPENAI_API_KEY) {
  console.error(
'Missing OPENAI_API_KEY. Set the environment variable or configure a .env file.\n' +
      'Example:\n' +
      '  OPENAI_API_KEY=\u003cYOUR_KEY\u003e npm run transcribe -- "\u003cvideo_url\u003e"'
  );
  process.exit(1);
}

// ===== Implementation steps 1–6 =====
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

function isLocalFile(input) {
  // Check if input looks like a file path (not a URL)
  return !input.match(/^https?:\/\//i) && (
    input.startsWith('/') ||
    input.startsWith('./') ||
    input.startsWith('../') ||
    input.match(/^[a-zA-Z]:[\\\/]/) // Windows absolute path
  );
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

async function getLocalTitle(filePath) {
  // Extract title from filename without extension
  const basename = path.basename(filePath);
  const title = basename.replace(/\.[^.]+$/, '');
  return title || null;
}

/**
 * Generate output filename based on title or video input
 * Priority: customTitle > remoteTitle/localTitle > fallback timestamp
 */
async function generateOutputFilename(titleOverride, videoInput, isLocal) {
  let filename;

  if (titleOverride) {
    // Use custom title if provided
    filename = slugify(titleOverride);
  } else if (isLocal) {
    // Use local filename without extension
    const basename = path.basename(videoInput);
    filename = basename.replace(/\.[^.]+$/, '') || 'transcription';
  } else {
    // Try to get remote title, fallback to timestamp
    const remoteTitle = await getRemoteTitle(videoInput);
    filename = remoteTitle ? slugify(remoteTitle) : `transcription-${Date.now()}`;
  }

  // Return with .txt extension
  return `${filename}.txt`;
}

/**
 * Scan ./videos folder for all .mp4 files
 * Returns array of absolute paths to .mp4 files
 */
function getVideosFromQueue() {
  const videosDir = path.resolve(process.cwd(), 'videos');

  // Check if videos directory exists
  if (!fs.existsSync(videosDir)) {
    return [];
  }

  try {
    const files = fs.readdirSync(videosDir);
    return files
      .filter(f => f.toLowerCase().endsWith('.mp4'))
      .map(f => path.join(videosDir, f))
      .sort(); // Sort for consistent order
  } catch (err) {
    console.error(`Error reading videos directory: ${err.message}`);
    return [];
  }
}

/**
 * Check if a video file has already been transcribed
 * Returns true if transcription file exists
 */
function isAlreadyTranscribed(videoPath) {
  const basename = path.basename(videoPath);
  const filenameWithoutExt = basename.replace(/\.[^.]+$/, '');
  const transcriptPath = path.resolve(process.cwd(), `${filenameWithoutExt}.txt`);
  return fs.existsSync(transcriptPath);
}

/**
 * Build a queue of videos to transcribe
 * Filters out already transcribed videos
 */
function buildTranscribeQueue(videoFiles) {
  return videoFiles.filter(videoPath => {
    if (isAlreadyTranscribed(videoPath)) {
      const basename = path.basename(videoPath);
      console.log(`⏭️  Skipping ${basename} (already transcribed)`);
      return false;
    }
    return true;
  });
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

  console.log('1/6 Downloading video (yt-dlp)...');
  await run('yt-dlp', args);

  // Find the downloaded file matching "video.*"
  const files = fs.readdirSync(workDir).filter((f) => f.startsWith('video.'));
  if (!files.length) throw new Error('Failed to identify the downloaded video file.');
  return path.join(workDir, files[0]);
}

async function prepareLocalVideo(filePath, workDir) {
  console.log('1/6 Preparing local video file...');

  // Resolve to absolute path
  const absolutePath = path.resolve(filePath);

  // Check if file exists
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Local video file not found: ${absolutePath}`);
  }

  // Copy file to work directory to maintain consistent workflow
  const ext = path.extname(absolutePath);
  const destPath = path.join(workDir, `video${ext}`);
  fs.copyFileSync(absolutePath, destPath);

  return destPath;
}

async function extractAudio(inputVideoPath, outputAudioPath, bitrateKbps = 24) {
  console.log('2/6 Extracting audio (ffmpeg)...');
  // Encode to Opus OGG mono 16k at a low bitrate to keep size small for API limits
  const args = [
    '-y',
    '-i',
    inputVideoPath,
    '-ac',
    '1',
    '-ar',
    '16000',
    '-vn',
    '-c:a',
    'libopus',
    '-b:a',
    `${bitrateKbps}k`,
    outputAudioPath,
  ];
  await run('ffmpeg', args);
}

function chunkString(str, size) {
  const chunks = [];
  for (let i = 0; i < str.length; i += size) chunks.push(str.slice(i, i + size));
  return chunks;
}

async function formatText(openai, text) {
  // Format the text by adding paragraph breaks for readability
  // No additional phrases, no cutting content - only splitting into paragraphs
  const model = 'gpt-4o-mini';
  const maxChunk = 15000; // characters; safe context buffer

  if (text.length <= maxChunk) {
    const r = await openai.chat.completions.create({
      model,
      temperature: 0,
      messages: [
        { role: 'system', content: 'You are a text formatter. Your only task is to add paragraph breaks (newlines) to make the text easier to read. DO NOT add, remove, or change any words. DO NOT add any phrases or commentary. Only add line breaks where natural paragraph breaks should occur. Return the exact same text with only whitespace modifications.' },
        { role: 'user', content: `Format this text by adding paragraph breaks for readability. Do not change any words:\n\n${text}` },
      ],
    });
    return (r.choices?.[0]?.message?.content || '').trim();
  }

  // For very long transcripts, process in chunks
  const chunks = chunkString(text, maxChunk);
  const formatted = [];
  for (let i = 0; i < chunks.length; i++) {
    const r = await openai.chat.completions.create({
      model,
      temperature: 0,
      messages: [
        { role: 'system', content: 'You are a text formatter. Your only task is to add paragraph breaks (newlines) to make the text easier to read. DO NOT add, remove, or change any words. DO NOT add any phrases or commentary. Only add line breaks where natural paragraph breaks should occur. Return the exact same text with only whitespace modifications.' },
        { role: 'user', content: `Format this text by adding paragraph breaks for readability. Do not change any words:\n\n${chunks[i]}` },
      ],
    });
    formatted.push((r.choices?.[0]?.message?.content || '').trim());
  }
  return formatted.join('\n\n');
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
  console.log('3/6 Transcription (OpenAI Whisper)...');
  const res = await openai.audio.transcriptions.create({
    file: fs.createReadStream(audioPath),
    model: 'whisper-1',
    temperature: 0,
  });
  const text = (res?.text || '').trim();
  if (!text) throw new Error('Received empty transcription.');
  return text;
}

function getFileSize(pathname) {
  try {
    const st = fs.statSync(pathname);
    return st.size;
  } catch {
    return 0;
  }
}

async function ensureAudioUnderLimit(inputPath, limitBytes = 26214400) {
  // If already small enough, return as-is
  let size = getFileSize(inputPath);
  if (size > 0 && size <= limitBytes) return inputPath;

  // Try to recompress at a lower bitrate
  const dir = path.dirname(inputPath);
  const base = path.basename(inputPath, path.extname(inputPath));
  const tmpOut = path.join(dir, `${base}.recompressed.ogg`);

  console.log('Audio exceeds API size limit. Recompressing at 16 kbps...');
  await extractAudio(inputPath, tmpOut, 16);

  const newSize = getFileSize(tmpOut);
  if (newSize > 0 && newSize <= limitBytes) {
    return tmpOut;
  }

  throw new Error(`Audio still exceeds size limit after recompression: ${(newSize / (1024 * 1024)).toFixed(2)} MB (limit ${(limitBytes / (1024 * 1024)).toFixed(2)} MB). Consider a shorter clip.`);
}

function buildOutputBlock({ titleIfProvided, summary, transcript }) {
  const lines = [];
  if (titleIfProvided) {
    lines.push(`## ${titleIfProvided}`);
  }
  // Put Summary first with an emoji
  lines.push('### 📋 Podsumowanie');
  lines.push(summary || '(none)');
  lines.push('');
  // Then Transcript with an emoji
  lines.push('### 📖 Transkrypt');
  lines.push(transcript);
  lines.push('');
  return lines.join('\n');
}

/**
 * Transcribe a single video file
 * Used for both batch mode and single file mode
 */
async function transcribeSingleFile(videoInputPath, openai, titleOverride = null) {
  const isLocal = isLocalFile(videoInputPath);

  // Generate output filename based on title or video input
  const outputFilename = await generateOutputFilename(titleOverride, videoInputPath, isLocal);
  const outFile = path.resolve(process.cwd(), outputFilename);

  // Output file check (in batch mode, skip instead of failing)
  if (fs.existsSync(outFile)) {
    if (!shouldContinue) {
      console.log(`⏭️  Skipping (output file already exists: ${path.basename(outFile)})`);
      return false;
    }
  }

  // Prepare working directory
  const suggestTitle = titleOverride ||
    (isLocal ? (await getLocalTitle(videoInputPath)) : (await getRemoteTitle(videoInputPath))) ||
    `Transcription ${new Date().toISOString().slice(0, 19)}`;
  const workDir = path.join(tmpRoot, `${slugify(suggestTitle)}-${Date.now()}`);
  fs.mkdirSync(workDir, { recursive: true });

  try {
    // 1. Download or prepare video
    const videoPath = isLocal
      ? await prepareLocalVideo(videoInputPath, workDir)
      : await downloadVideo(videoInputPath, workDir);

    // 2. Extract audio (compressed to OGG/Opus)
    let audioPath = path.join(workDir, 'audio.ogg');
    await extractAudio(videoPath, audioPath);

    // 2b. Ensure under API size limit (25 MiB)
    const limitedAudioPath = await ensureAudioUnderLimit(audioPath, 26214400);

    // 3. Transcription
    const transcript = await transcribeAudio(openai, limitedAudioPath);

    // 4. Format text for readability
    console.log('4/6 Formatting text (OpenAI)...');
    const formattedTranscript = await formatText(openai, transcript);

    // 5. Summarization
    console.log('5/6 Summarizing (OpenAI)...');
    const summary = await summarizeText(openai, formattedTranscript, 'in Polish');

    // 6. Write to output file
    console.log(`6/6 Writing to ${path.basename(outFile)}...`);
    const block = buildOutputBlock({
      titleIfProvided: titleOverride || null,
      summary,
      transcript: formattedTranscript,
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
    return true;
  } catch (err) {
    console.error('Error:', err.message || err);
    return false;
  } finally {
    // Optional cleanup (we keep working files on error for diagnostics)
    // If you want to always remove the working directory, uncomment below:
    // try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
  }
}

async function main() {
  // Required CLI tools
  await ensureBinary('ffmpeg', ['-version']);
  if (videoInput && !isLocalFile(videoInput)) {
    await ensureBinary('yt-dlp');
  }

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  // SINGLE FILE MODE: transcribe specific video
  if (videoInput) {
    console.log(`Processing: ${videoInput}\n`);
    await transcribeSingleFile(videoInput, openai, customTitle);
    return;
  }

  // BATCH MODE: process all .mp4 files in ./videos folder
  console.log('🎬 Batch mode: scanning ./videos folder for .mp4 files...\n');

  const allVideos = getVideosFromQueue();
  if (allVideos.length === 0) {
    console.log('No .mp4 files found in ./videos folder.');
    return;
  }

  const queue = buildTranscribeQueue(allVideos);
  if (queue.length === 0) {
    console.log('All videos in ./videos folder are already transcribed.');
    return;
  }

  console.log(`Found ${queue.length} video(s) to transcribe:\n`);
  queue.forEach((v, i) => {
    console.log(`  ${i + 1}. ${path.basename(v)}`);
  });
  console.log('');

  // Process queue sequentially
  let completed = 0;
  for (let i = 0; i < queue.length; i++) {
    const videoFile = queue[i];
    const basename = path.basename(videoFile);
    console.log(`\n[${i + 1}/${queue.length}] Processing: ${basename}`);
    console.log('─'.repeat(50));

    const success = await transcribeSingleFile(videoFile, openai);
    if (success) {
      completed++;
    }
  }

  console.log(`\n${'═'.repeat(50)}`);
  console.log(`✅ Batch complete: ${completed}/${queue.length} videos transcribed`);
}

main().catch(err => {
  console.error('Fatal error:', err.message || err);
  process.exit(1);
});