// The credits checkout page (@profullstack/checkout): the three packs as one radio group,
// prefilled from its link (/checkout?option=creator), one button, then the same CoinPay
// session POST /api/v1/credits/checkout opens. Prices come from PACKS and nowhere else.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createCheckout } from '@profullstack/checkout';
import { PACKS } from './coinpay.js';

const require = createRequire(import.meta.url);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const CHECKOUT_PATH = '/checkout';
export const SIGN_IN_PATH = '/api/v1/coinpay/oauth/start';

/** The packs as checkout options, in the order the app lists them. */
export function packOptions(packs = PACKS) {
  return Object.entries(packs).map(([id, p]) => ({ id, name: `${p.credits.toLocaleString('en-US')} credits`, price: p.usd }));
}

/**
 * @param {object} args
 * @param {string} args.publicUrl the public origin (the app sits behind the c0mpute edge)
 * @param {(cookieHeader: string | null) => ({ id: string, email?: string | null } | null)} args.account the signed-in account for a Cookie header
 * @param {(accountId: string, pack: string) => Promise<{ url: string, id: string }>} args.start opens the CoinPay session (coinpay.checkout)
 * @param {object} [args.packs]
 */
export function creditsCheckout({ publicUrl, account, start, packs = PACKS }) {
  return createCheckout({
    site: 'autoinfluencer',
    title: 'Buy credits',
    subtitle: '1 credit = 1 generation.',
    optionsLabel: 'Pack',
    processor: 'Packs are paid in crypto through CoinPay.',
    action: CHECKOUT_PATH,
    page: CHECKOUT_PATH,
    siteUrl: publicUrl,
    options: packOptions(packs),
    requireAccount: true,
    signIn: SIGN_IN_PATH,
    // Who pays is the session cookie, never the link or the form.
    account: (request) => {
      const a = account(request?.headers?.get('cookie') ?? null);
      return a ? { id: a.id, email: a.email || '' } : null;
    },
    pay: async (order) => {
      const pack = Object.hasOwn(packs, order.option.id) ? packs[order.option.id] : null;
      if (!pack) throw new Error(`checkout: unknown pack ${order.option.id}`);
      // The page must never show one amount and charge another.
      const cents = Math.round(pack.usd * 100);
      if (order.quantity !== 1 || order.totalCents !== cents) {
        throw new Error(`checkout amount changed: the page showed ${order.totalCents} cents, pack ${order.option.id} is ${cents}`);
      }
      return start(order.account.id, order.option.id);
    },
    onError: (error, order) => console.error(`[checkout] pack ${order?.option?.id}: ${error?.message ?? error}`),
  });
}

// The page's stylesheet and script, read once and served from our own origin.
function asset(spec, type) {
  const body = readFileSync(require.resolve(spec));
  return { body, type, v: createHash('sha256').update(body).digest('hex').slice(0, 10) };
}

export const CHECKOUT_ASSETS = {
  '/assets/checkout.css': asset('@profullstack/checkout/checkout.css', 'text/css; charset=utf-8'),
  '/assets/checkout.js': asset('@profullstack/checkout/browser.bundle.js', 'text/javascript; charset=utf-8'),
};

/** The whole page. `form` is checkout.html() (already escaped); `footers` is allFooters(). */
export function checkoutPage({ form, footers = '', who = '' }) {
  const a = CHECKOUT_ASSETS;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Buy credits · autoinfluencer</title>
  <meta name="robots" content="noindex">
  <meta name="theme-color" content="#111111">
  <link rel="manifest" href="/manifest.webmanifest">
  <link rel="icon" href="/icon.svg" type="image/svg+xml">
  <link rel="apple-touch-icon" href="/icon-192.png">
  <link rel="stylesheet" href="/style.css">
  <link rel="stylesheet" href="/assets/checkout.css?v=${a['/assets/checkout.css'].v}">
</head>
<body>
  <header class="top">
    <a class="brand" href="/"><img src="/icon.svg" alt="" width="28" height="28"> autoinfluencer</a>
    <nav>
      <a href="/">Back to the app</a>
      <span class="who">${esc(who)}</span>
    </nav>
  </header>

  <main class="checkout">
    ${form}
  </main>

  ${footers}
  <script type="module" src="/assets/checkout.js?v=${a['/assets/checkout.js'].v}"></script>
</body>
</html>
`;
}

/** A node request as the web Request the checkout handler takes. */
export function toWebRequest(req, publicUrl, body) {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v == null || k === 'content-length' || k === 'transfer-encoding' || k === 'connection') continue;
    headers.set(k, Array.isArray(v) ? v.join(', ') : String(v));
  }
  return new Request(new URL(req.url, publicUrl), { method: req.method, headers, body });
}
