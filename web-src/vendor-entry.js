// Single entry point for every third-party module the app needs at runtime.
//
// They must share one bundle: y-webrtc and y-indexeddb both depend on yjs, and two
// copies of Yjs in one page break the identity checks it does internally. Built to
// assets/www/vendor/sync.js by `npm run build:vendor`.

import * as Y from 'yjs';

export { Y };
export { WebrtcProvider } from 'y-webrtc';
export { IndexeddbPersistence } from 'y-indexeddb';
