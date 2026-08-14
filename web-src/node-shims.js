// simple-peer (pulled in by y-webrtc) is written against Node globals. esbuild has no
// automatic polyfills, so inject the two it actually reaches for.

import { Buffer } from 'buffer';
import process from 'process';

export { Buffer, process };
