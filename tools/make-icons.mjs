#!/usr/bin/env node
// Renders web-src/icon.svg and web-src/icon-maskable.svg into the PNG sizes the
// web app manifest asks for: `node tools/make-icons.mjs`.
//
// macOS only — it leans on qlmanage to rasterise the SVG and sips to resample.
// The PNGs are committed, so nothing else in the toolchain needs either.

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, copyFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);
const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, 'assets/www/icons');

// source svg -> [output name, pixel size]
const TARGETS = [
  ['icon.svg', [['icon-192.png', 192], ['icon-512.png', 512]]],
  ['icon-maskable.svg', [['icon-maskable-512.png', 512]]],
];

async function main() {
  if (process.platform !== 'darwin') {
    console.error('This script needs macOS (qlmanage). The PNGs it produces are committed.');
    process.exit(1);
  }

  await mkdir(OUT, { recursive: true });
  const work = await mkdtemp(join(tmpdir(), 'shopnest-icons-'));

  try {
    for (const [source, outputs] of TARGETS) {
      const svg = join(ROOT, 'web-src', source);
      // qlmanage always writes <name>.png into the directory it is given.
      await run('qlmanage', ['-t', '-s', '512', '-o', work, svg]);
      const master = join(work, `${source}.png`);

      for (const [name, size] of outputs) {
        const target = join(OUT, name);
        if (size === 512) {
          await copyFile(master, target);
        } else {
          await run('sips', ['-z', String(size), String(size), master, '--out', target]);
        }
        console.log(`  ${name.padEnd(24)} ${size}x${size}`);
      }
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
