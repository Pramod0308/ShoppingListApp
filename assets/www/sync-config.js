// Where peers find each other.
//
// These are the public y-webrtc demo servers. They are run by the library's author
// as a courtesy, carry no availability guarantee, and have been unreachable for long
// stretches — if sync appears dead, this is the first thing to check.
//
// Run your own instead. The y-webrtc package ships one:
//
//     npx y-webrtc-signaling --port 4444
//
// then put your deployment's wss:// URL at the front of this list. A signalling
// server only introduces peers: it sees a room's hash and relays connection offers
// that are encrypted with the room secret, never the room secret itself and never
// any list content.
//
// The page's Content-Security-Policy allows wss: only. Pointing this at a plaintext
// ws:// server for local testing means relaxing connect-src in index.html to match.
export const SIGNALING_SERVERS = [
  'wss://y-webrtc-eu.fly.dev',
];

// Where the web build is published.
//
// Links are built against this rather than location.origin, because inside the
// mobile shell location.origin is http://localhost — a URL that means nothing on
// the device it gets sent to. Change it if the app moves, or if a custom domain is
// configured for the Pages site.
export const PUBLIC_BASE_URL = 'https://pramod0308.github.io/ShoppingListApp/';

// Where the price Worker in worker/ is deployed, e.g.
// 'https://shopnest-prices.<your-subdomain>.workers.dev'.
//
// Empty means the cost estimate is switched off and the button says so, rather than
// the app failing at a URL that was never set. Anything other than a *.workers.dev
// host also needs adding to connect-src in index.html, or the browser refuses it.
export const PRICE_API_URL = '';
