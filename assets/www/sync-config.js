// Where peers find each other.
//
// This is the deployment of signalling/ — `cd signalling && npx wrangler deploy`
// puts a copy of your own at wss://shopnest-signalling.<subdomain>.workers.dev.
// If sync appears dead, whether this host is up is the first thing to check.
//
// It replaced the public y-webrtc demo servers, which are run by the library's
// author as a courtesy, carry no availability guarantee, and have been unreachable
// for long stretches. Falling back to them is a matter of adding them here, and
// costs nothing but the same unreliability.
//
// A signalling server only introduces peers: it sees a room's hash and relays
// connection offers that are encrypted with the room secret, never the room secret
// itself and never any list content.
//
// The page's Content-Security-Policy allows wss: only. Pointing this at a plaintext
// ws:// server for local testing means relaxing connect-src in index.html to match.
export const SIGNALING_SERVERS = [
  'wss://shopnest-signalling.shopitnest.workers.dev'
];

// Where changes wait for a device that is not awake.
//
// Peer sync only connects two devices that are both open at once, which for a
// shopping list is the wrong moment. This is the durable half: the same worker on
// /relay, holding updates until the other phone turns up. What it stores is
// encrypted with the room secret, which never reaches it — see relay-sync.js.
//
// Empty disables it and leaves the app exactly as peer-to-peer as it was.
export const RELAY_SERVER = 'wss://shopnest-signalling.shopitnest.workers.dev/relay';

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
export const PRICE_API_URL = 'https://shopnest-prices.shopitnest.workers.dev/';

// Whether the app asks for a passcode before it will start.
//
// It is checked against APP_PASSCODE on the price worker, so this flag and that
// secret go together: turn this on without setting the secret and the worker will
// wave everyone through, leaving a lock screen that any passcode opens.
//   wrangler secret put APP_PASSCODE
export const REQUIRE_PASSCODE = true;
