import { execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const outDir = path.resolve(projectRoot, 'out');
const mp4Path = path.resolve(outDir, 'chaospilot-overview.mp4');
const posterPath = path.resolve(outDir, 'poster.png');
const qaDir = path.resolve(outDir, 'qa-frames');
const reportPath = path.resolve(outDir, 'validation-report.json');

async function main() {
  console.log('[VALIDATE] Verifying rendered video artifacts...');

  if (!fs.existsSync(mp4Path)) {
    throw new Error(`MP4 file not found at ${mp4Path}`);
  }

  const stat = fs.statSync(mp4Path);
  console.log(`[VALIDATE] File size: ${(stat.size / (1024 * 1024)).toFixed(2)} MB`);

  // Probe using Remotion ffprobe
  console.log('[VALIDATE] Running ffprobe...');
  const probeCmd = `npx remotion ffprobe -v quiet -print_format json -show_format -show_streams "${mp4Path}"`;
  const probeRaw = execSync(probeCmd, { cwd: projectRoot, encoding: 'utf-8' });
  const probe = JSON.parse(probeRaw);

  const videoStream = probe.streams?.find((s: any) => s.codec_type === 'video');
  if (!videoStream) {
    throw new Error('No video stream found in rendered MP4');
  }

  const durationSec = parseFloat(probe.format.duration);
  const width = videoStream.width;
  const height = videoStream.height;
  const codecName = videoStream.codec_name;
  const pixFmt = videoStream.pix_fmt;
  const rFrameRate = videoStream.r_frame_rate; // e.g. "30/1"
  const nbFrames = videoStream.nb_frames ? parseInt(videoStream.nb_frames, 10) : Math.round(durationSec * 30);

  console.log(`[VALIDATE] Stream info:`);
  console.log(`  Codec: ${codecName}`);
  console.log(`  Pixel Format: ${pixFmt}`);
  console.log(`  Resolution: ${width}x${height}`);
  console.log(`  Frame Rate: ${rFrameRate}`);
  console.log(`  Duration: ${durationSec}s`);
  console.log(`  Frame Count: ${nbFrames}`);

  const checks = {
    exists: true,
    fileSizeMb: Number((stat.size / (1024 * 1024)).toFixed(2)),
    expectedWidth: 1920,
    actualWidth: width,
    widthPass: width === 1920,
    expectedHeight: 1080,
    actualHeight: height,
    heightPass: height === 1080,
    expectedFps: '30/1',
    actualFps: rFrameRate,
    fpsPass: rFrameRate === '30/1' || rFrameRate === '30',
    expectedDurationSec: 180,
    actualDurationSec: durationSec,
    durationPass: Math.abs(durationSec - 180) < 0.1,
    expectedFrames: 5400,
    actualFrames: nbFrames,
    framesPass: nbFrames === 5400,
    codecPass: codecName === 'h264',
    pixFmtPass: pixFmt === 'yuv420p' || pixFmt === 'yuvj420p',
    posterExists: fs.existsSync(posterPath),
    qaFramesCount: fs.existsSync(qaDir) ? fs.readdirSync(qaDir).length : 0,
    decodePass: false,
    decodeError: null as string | null,
  };

  // Run full decode test with ffmpeg
  console.log('[VALIDATE] Running full ffmpeg decode check...');
  try {
    const decodeCmd = `npx remotion ffmpeg -v error -i "${mp4Path}" -c:v rawvideo -f null -`;
    execSync(decodeCmd, { cwd: projectRoot, encoding: 'utf-8' });
    checks.decodePass = true;
    console.log('[VALIDATE] Full decode check passed with zero errors!');
  } catch (err: any) {
    checks.decodePass = false;
    checks.decodeError = err.message;
    console.error('[VALIDATE] Decode error:', err.message);
  }

  const allPassed =
    checks.widthPass &&
    checks.heightPass &&
    checks.fpsPass &&
    checks.durationPass &&
    checks.framesPass &&
    checks.codecPass &&
    checks.pixFmtPass &&
    checks.posterExists &&
    checks.qaFramesCount >= 14 &&
    checks.decodePass;

  const result = {
    timestamp: new Date().toISOString(),
    status: allPassed ? 'PASSED' : 'FAILED',
    mp4Path,
    posterPath,
    qaDir,
    checks,
  };

  fs.writeFileSync(reportPath, JSON.stringify(result, null, 2), 'utf-8');
  console.log(`[VALIDATE] Report saved to ${reportPath}`);

  if (!allPassed) {
    console.error('[VALIDATE] One or more checks FAILED:', result);
    process.exit(1);
  }

  console.log('[VALIDATE] All verification checks PASSED!');
}

main().catch((err) => {
  console.error('[VALIDATE ERROR]', err);
  process.exit(1);
});
