import { bundle } from '@remotion/bundler';
import { renderMedia, renderStill, selectComposition } from '@remotion/renderer';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const outDir = path.resolve(projectRoot, 'out');
const qaDir = path.resolve(outDir, 'qa-frames');

async function main() {
  console.log('[RENDER] Ensuring output directories...');
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(qaDir, { recursive: true });

  const entryPoint = path.resolve(projectRoot, 'src/index.ts');
  console.log(`[RENDER] Bundling Remotion project from ${entryPoint}...`);
  const bundleLocation = await bundle({
    entryPoint,
    webpackOverride: (config) => config,
  });
  console.log(`[RENDER] Bundle created at ${bundleLocation}`);

  console.log('[RENDER] Selecting composition "ChaosPilotOverview"...');
  const composition = await selectComposition({
    serveUrl: bundleLocation,
    id: 'ChaosPilotOverview',
  });

  console.log(`[RENDER] Composition loaded: ${composition.width}x${composition.height}, ${composition.fps}fps, ${composition.durationInFrames} frames (${composition.durationInFrames / composition.fps}s)`);

  const finalOutputLocation = path.resolve(outDir, 'chaospilot-overview.mp4');
  const tempOutputLocation = path.resolve(outDir, 'chaospilot-overview-raw.mp4');

  console.log(`[RENDER] Starting full media render to temporary file ${tempOutputLocation}...`);
  const startTime = Date.now();

  await renderMedia({
    composition,
    serveUrl: bundleLocation,
    codec: 'h264',
    outputLocation: tempOutputLocation,
    pixelFormat: 'yuv420p',
    enforceAudioTrack: false,
    muted: true,
    crf: 18,
    onProgress: ({ renderedFrames, progress }) => {
      if (renderedFrames % 300 === 0 || progress === 1) {
        const percent = (progress * 100).toFixed(1);
        console.log(`[RENDER PROGRESS] ${renderedFrames}/${composition.durationInFrames} frames (${percent}%)`);
      }
    },
  });

  console.log('[RENDER] Applying faststart flag with ffmpeg...');
  const { execSync } = await import('node:child_process');
  execSync(
    `npx remotion ffmpeg -y -i "${tempOutputLocation}" -c copy -movflags +faststart "${finalOutputLocation}"`,
    { cwd: projectRoot, stdio: 'inherit' }
  );

  if (fs.existsSync(tempOutputLocation)) {
    fs.unlinkSync(tempOutputLocation);
  }

  const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[RENDER] Video render complete in ${durationSec}s! Final MP4: ${finalOutputLocation}`);

  // Render poster / thumbnail
  const posterLocation = path.resolve(outDir, 'poster.png');
  console.log(`[RENDER] Rendering poster image to ${posterLocation}...`);
  await renderStill({
    composition,
    serveUrl: bundleLocation,
    output: posterLocation,
    frame: 150,
    imageFormat: 'png',
  });
  console.log('[RENDER] Poster rendered.');

  // Representative QA frames for all 14 scenes + opening + ending
  const representativeFrames = [
    { scene: 'scene01_title', frame: 150, desc: 'Scene 01: Product Title & Converging Stream' },
    { scene: 'scene02_order_of_events', frame: 510, desc: 'Scene 02: Order of Events Packets' },
    { scene: 'scene03_six_stage_flow', frame: 900, desc: 'Scene 03: Six-Stage Lifecycle Flow' },
    { scene: 'scene04_brief_requirements', frame: 1290, desc: 'Scene 04: Brief & Requirements Panel' },
    { scene: 'scene05_bounded_plan', frame: 1710, desc: 'Scene 05: Pinned Artifacts Plan' },
    { scene: 'scene06_propose_sequence', frame: 2130, desc: 'Scene 06: Propose Action Sequence' },
    { scene: 'scene07_execute_fresh_state', frame: 2580, desc: 'Scene 07: Fresh Test Instance Sandbox' },
    { scene: 'scene08_duplicate_not_twice', frame: 3030, desc: 'Scene 08: Duplicate Invariant Violation' },
    { scene: 'scene09_replay_compare', frame: 3450, desc: 'Scene 09: Replay vs Clean Control' },
    { scene: 'scene10_chain_of_evidence', frame: 3840, desc: 'Scene 10: Unbroken Chain of Evidence' },
    { scene: 'scene11_baselines_vs_explore', frame: 4200, desc: 'Scene 11: Known Baselines vs Exploration' },
    { scene: 'scene12_synthetic_adapters', frame: 4560, desc: 'Scene 12: Synthetic Execution Adapters' },
    { scene: 'scene13_evidence_limitations', frame: 4920, desc: 'Scene 13: Evidence Boundaries & Integrity' },
    { scene: 'scene14_outro', frame: 5250, desc: 'Scene 14: Terminal CTA & Web UI' },
    { scene: 'scene14_final_frame', frame: 5399, desc: 'Final Frame (frame 5399)' },
  ];

  console.log(`[RENDER] Rendering ${representativeFrames.length} QA frames...`);
  for (const rf of representativeFrames) {
    const framePath = path.resolve(qaDir, `${rf.scene}_f${rf.frame}.png`);
    await renderStill({
      composition,
      serveUrl: bundleLocation,
      output: framePath,
      frame: rf.frame,
      imageFormat: 'png',
    });
    console.log(`  ✓ Frame ${rf.frame} (${rf.scene}) -> ${path.basename(framePath)}`);
  }

  console.log('[RENDER] All media and QA frames successfully rendered!');
}

main().catch((err) => {
  console.error('[RENDER ERROR]', err);
  process.exit(1);
});
