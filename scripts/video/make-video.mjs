#!/usr/bin/env node
/**
 * Cuts artifacts/video/raw.webm (from record.mjs) into agentx-docs/docs/video/agentx-demo.mp4
 * (the sibling docs repo; PACTORA_DOCS_DIR overrides where it is):
 * scene by scene from marks.json, the live run at 1.5×, 1920×1080 @ 30 fps,
 * H.264 + a silent AAC track (some upload forms reject video-only files),
 * fades in and out.
 *
 *   FFMPEG=/path/to/ffmpeg node scripts/video/make-video.mjs
 * (Playwright's bundled ffmpeg can only record; use a full build, e.g. the
 * `ffmpeg-static` npm package.)
 */
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const BACKEND = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const IN = join(BACKEND, 'artifacts', 'video');
const DOCS = resolve(process.env.PACTORA_DOCS_DIR ?? join(BACKEND, '..', 'agentx-docs'));
const OUT = join(DOCS, 'docs', 'video', 'agentx-demo.mp4');
const FFMPEG = process.env.FFMPEG ?? 'ffmpeg';

const m = Object.fromEntries(
  JSON.parse(readFileSync(join(IN, 'marks.json'), 'utf8')).map((x) => [x.name, x.t]),
);
const segs = [
  [0.3, m.problem, 1],
  [m.problem, m.landing, 1],
  [m.landing, m.demo, 1],
  [m.demo, m.run, 1],
  [m.run, m.finished, 1.5], // the live run, sped up; everything else is real time
  [m.finished, m.receipt, 1],
  [m.receipt, m.record, 1],
  [m.record, m.marketplace, 1],
  [m.marketplace, m.status, 1],
  [m.status, m.end, 1],
  [m.end, m.stop - 0.2, 1],
];
const parts = segs.map(
  ([a, b, k], n) =>
    `[0:v]trim=${a.toFixed(2)}:${b.toFixed(2)},setpts=(PTS-STARTPTS)/${k},fps=30,scale=1920:1080:flags=lanczos,setsar=1[v${n}];`,
);
const duration = segs.reduce((d, [a, b, k]) => d + (b - a) / k, 0);
const filter =
  parts.join('') +
  segs.map((_, n) => `[v${n}]`).join('') +
  `concat=n=${segs.length}:v=1:a=0[cat];[cat]fade=t=in:st=0:d=0.8,fade=t=out:st=${(duration - 1.2).toFixed(2)}:d=1.2[v]`;

execFileSync(
  FFMPEG,
  [
    '-loglevel',
    'error',
    '-y',
    '-i',
    join(IN, 'raw.webm'),
    '-f',
    'lavfi',
    '-i',
    'anullsrc=channel_layout=stereo:sample_rate=48000',
    '-filter_complex',
    filter,
    '-map',
    '[v]',
    '-map',
    '1:a',
    '-shortest',
    '-c:v',
    'libx264',
    '-preset',
    'slow',
    '-crf',
    '18',
    '-pix_fmt',
    'yuv420p',
    '-r',
    '30',
    '-c:a',
    'aac',
    '-b:a',
    '64k',
    '-movflags',
    '+faststart',
    OUT,
  ],
  {stdio: 'inherit'},
);
console.log(`wrote ${OUT} (${duration.toFixed(1)} s)`);
