#!/usr/bin/env node
// The installed entry point: a trampoline into cli/main.js. Keeping this file
// tiny matters — it is the only file with a shebang, and the only one npm
// links onto PATH.

import { main } from '../cli/main.js';

main().then(
  (code) => { if (code) process.exitCode = code; },
  (err) => {
    console.error('  ' + (err?.message || err));
    process.exitCode = 1;
  },
);
