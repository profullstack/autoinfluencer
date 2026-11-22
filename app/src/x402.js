// Per-call x402 payments for generation, settled by CoinPay (USDC on Base, Polygon,
// Ethereum; CoinPay's relayer pays gas). Built on @profullstack/x402-gateway's low-level
// helpers: the gateway's createGateway() only sells crawler day passes.
import { buildOffer, decodePayment, expectedFor, verifyAndSettle, paymentRequiredHeader, paymentResponseHeader } from '@profullstack/x402-gateway';

export const PRICE_CENTS = 5;

export function createX402({ env, publicUrl, fetch: f = globalThis.fetch }) {
  const coinpay = { apiKey: env.COINPAY_X402_KEY, baseUrl: (env.COINPAY_URL || 'https://coinpayportal.com').replace(/\/$/, '') };
  let payTo = env.X402_PAY_TO || '';
  let payToAt = 0;

  async function currentPayTo() {
    if (env.X402_PAY_TO) return env.X402_PAY_TO;
    if (payTo && Date.now() - payToAt < 3_600_000) return payTo;
    try {
      const r = await f(`${coinpay.baseUrl}/api/x402/pay-to`, { headers: { 'x-api-key': coinpay.apiKey } });
      const j = await r.json();
      if (j.pay_to) {
        payTo = j.pay_to;
        payToAt = Date.now();
      }
    } catch {
      /* keep the last known wallet */
    }
    return payTo;
  }

  const enabled = () => Boolean(coinpay.apiKey);

  return {
    enabled,
    async offer(tool) {
      const resource = `${publicUrl}/api/${tool}`;
      const description = `autoinfluencer ${tool}: one generation`;
      const to = await currentPayTo();
      if (!to) return null;
      return { offer: buildOffer({ payTo: to, priceCents: PRICE_CENTS, resource, description }), resource, description };
    },

    /** Write a 402 with the offer. */
    async deny(res, tool, error) {
      const o = enabled() ? await this.offer(tool) : null;
      const headers = { 'content-type': 'application/json', 'access-control-expose-headers': 'PAYMENT-REQUIRED, PAYMENT-RESPONSE' };
      if (o) headers['payment-required'] = paymentRequiredHeader(o.offer, { url: o.resource, description: o.description, error });
      res.writeHead(402, headers);
      res.end(JSON.stringify({ ...(o?.offer ?? {}), error: error ?? 'payment required', buy_credits: `${publicUrl}/#credits` }));
      return false;
    },

    /** Verify and settle an attached payment. -> { ok, payer?, reason? } and sets PAYMENT-RESPONSE. */
    async settle(req, res, tool) {
      const proof = req.headers['payment-signature'] || req.headers['x-payment'];
      if (!proof || !enabled()) return { ok: false, reason: 'no payment' };
      const o = await this.offer(tool);
      if (!o) return { ok: false, reason: 'payments unavailable' };
      const payment = decodePayment(proof);
      if (!payment) return { ok: false, reason: 'bad payment header' };
      const expected = expectedFor(payment, o.offer);
      if (!expected) return { ok: false, reason: 'unsupported network or amount' };
      const r = await verifyAndSettle(payment, expected, { ...coinpay, metadata: { property: 'influencer.marketing.pit.world', resourcePath: `/api/${tool}` } });
      if (!r.ok) return { ok: false, reason: r.reason };
      res.setHeader('payment-response', paymentResponseHeader({ transaction: r.txHash, network: r.network, payer: r.payer }));
      return { ok: true, payer: r.payer, tx: r.txHash };
    },
  };
}
