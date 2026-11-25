// CoinPay OAuth 2.1 sign-in (authorization code + S256 PKCE, confidential client with
// client_secret_post) and crypto checkout for credit packs. Accounts bind to CoinPay `sub`
// only: CoinPay reports email_verified=false, so email is display data, never identity.
import { createHash, randomBytes } from 'node:crypto';
import { CoinPay, readWebhook, verifyWebhook } from '@profullstack/coinpay-onboard';
import { HttpError, newId } from './util.js';
import { TOPUPS, PLANS, PAID_PLANS } from './plans.js';

const b64url = (b) => Buffer.from(b).toString('base64url');

/** Everything the checkout sells: credit top-ups, then each paid plan by month and by year. */
export const PACKS = {
  ...TOPUPS,
  ...Object.fromEntries(
    PAID_PLANS.flatMap((id) =>
      ['month', 'year'].map((interval) => [`${id}-${interval}`, { credits: 0, usd: PLANS[id].usd[interval], name: `${PLANS[id].name} plan · 1 ${interval}`, plan: id, interval }]),
    ),
  ),
};

export function createCoinpay({ env, db, publicUrl, fetch: f = globalThis.fetch }) {
  const base = (env.COINPAY_URL || 'https://coinpayportal.com').replace(/\/$/, '');
  const clientId = env.COINPAY_OAUTH_CLIENT_ID;
  const clientSecret = env.COINPAY_OAUTH_CLIENT_SECRET;
  const redirectUri = `${publicUrl}/api/v1/coinpay/oauth/callback`;
  const cp = env.COINPAY_API_KEY ? new CoinPay({ token: env.COINPAY_API_KEY, base: env.COINPAY_API_URL || undefined }) : null;
  const secure = publicUrl.startsWith('https:');
  const STATE_COOKIE = 'ai_cp_state';

  function safeReturn(path) {
    const p = String(path ?? '/');
    return p.startsWith('/') && !p.startsWith('//') ? p : '/';
  }

  return {
    configured: Boolean(clientId),

    /** -> { location, cookie } */
    start(returnTo) {
      if (!clientId) throw new HttpError(503, 'CoinPay sign-in is not configured');
      const state = b64url(randomBytes(24));
      const verifier = b64url(randomBytes(32));
      db.saveState(state, verifier, safeReturn(returnTo));
      const q = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'openid profile email',
        state,
        code_challenge: b64url(createHash('sha256').update(verifier).digest()),
        code_challenge_method: 'S256',
      });
      return {
        location: `${base}/api/oauth/authorize?${q}`,
        cookie: `${STATE_COOKIE}=${state}; Path=/api/v1/coinpay; HttpOnly; SameSite=Lax; Max-Age=600${secure ? '; Secure' : ''}`,
      };
    },

    /** -> { account, returnTo, clearCookie } */
    async callback(params, stateCookie) {
      if (params.error) throw new HttpError(400, `CoinPay sign-in failed: ${params.error_description || params.error}`);
      if (!params.state || !params.code || params.state !== stateCookie) throw new HttpError(400, 'sign-in state mismatch; start again');
      const row = db.takeState(params.state);
      if (!row) throw new HttpError(400, 'sign-in expired; start again');
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code: params.code,
        redirect_uri: redirectUri,
        code_verifier: row.verifier,
        client_id: clientId,
        ...(clientSecret ? { client_secret: clientSecret } : {}),
      });
      const tr = await f(`${base}/api/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
      const tok = await tr.json().catch(() => ({}));
      if (!tr.ok || !tok.access_token) throw new HttpError(502, `CoinPay token exchange failed: ${tok.error_description || tok.error || tr.status}`);
      const ur = await f(`${base}/api/oauth/userinfo`, { headers: { authorization: `Bearer ${tok.access_token}` } });
      const info = await ur.json().catch(() => ({}));
      if (!ur.ok || !info.sub) throw new HttpError(502, 'CoinPay userinfo failed');
      const account = db.upsertCoinpayAccount({ sub: info.sub, email: info.email, name: info.name || info.preferred_username });
      return {
        account,
        returnTo: row.return_to || '/',
        clearCookie: `${STATE_COOKIE}=; Path=/api/v1/coinpay; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`,
      };
    },

    async checkout(account, packName) {
      const pack = PACKS[packName];
      if (!pack) throw new HttpError(400, `unknown pack (${Object.keys(PACKS).join(', ')})`);
      if (!cp) throw new HttpError(503, 'payments are not configured');
      const id = `chk_${newId(10)}`;
      const session = await cp.createCheckoutSession({
        amount: pack.usd,
        description: pack.plan ? `autoinfluencer: ${pack.name}` : `autoinfluencer: ${pack.credits} credits`,
        customerEmail: account.email || `${account.id}@users.influencer.marketing.pit.world`,
        accountId: account.id,
        property: 'influencer.marketing.pit.world',
        metadata: { checkout_id: id, account_id: account.id, pack: packName },
        successUrl: `${publicUrl}/?paid=1`,
        cancelUrl: `${publicUrl}/`,
        expiresInMinutes: 120,
        idempotencyKey: `autoinfluencer-${id}`,
      });
      db.createCheckout(id, account.id, packName, pack.credits);
      return { url: session.url, id };
    },

    /** Raw body + signature header -> credits applied once. */
    webhook(rawBody, signature) {
      if (!env.COINPAY_WEBHOOK_SECRET || !verifyWebhook(rawBody, signature, env.COINPAY_WEBHOOK_SECRET)) {
        throw new HttpError(401, 'bad signature');
      }
      const ev = readWebhook(JSON.parse(rawBody));
      if (!ev.paid) return { ignored: true };
      const chk = db.checkout(ev.metadata?.checkout_id);
      if (!chk) return { ignored: true, reason: 'unknown checkout' };
      const ref = ev.eventId || `${ev.checkoutSessionId}:${ev.paymentId}`;
      const plan = PACKS[chk.pack]?.plan;
      const applied = plan
        ? db.startPlan(chk.account_id, plan, PACKS[chk.pack].interval, ref)
        : db.addCredits(chk.account_id, chk.credits, ref, `pack ${chk.pack}`);
      db.markCheckout(chk.id, 'paid');
      return { ok: true, applied };
    },
  };
}
