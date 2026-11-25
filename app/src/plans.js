// Plans, credit costs and top-ups: the one place prices live. The pricing page, the plan
// checkout, the limits checks and /api/v1/pricing all read these.
//
// 1 credit = $0.01. Credits pay only for AI work done on the c0mpute network (and for the
// desktop work an app capture does). Sites, forms, bookings, scheduling and publishing are free.

export const CREDIT_USD = 0.01;

/** Credits per action. */
export const COSTS = {
  generation: 5, // a draft, repurpose, reply, ideas list or filled calendar (same as x402 $0.05)
  blog_post: 60, // a blog post written on c0mpute
  translation: 10, // one post or page into one more language
  ad: 50, // one static ad, delivered in 1:1, 4:5 and 9:16
  reel: 500, // a short video made by c0mpute's promo pipeline
  app_capture: 200, // your web app recorded on your desktop environment, refunded if nothing usable comes back
  newsletter: 5, // a newsletter issue drafted on c0mpute
};

/** What `credits` buys, so people can read a balance. */
export function creditsIn(credits) {
  return {
    ads: Math.floor(credits / COSTS.ad),
    reels: Math.floor(credits / COSTS.reel),
    blog_posts: Math.floor(credits / COSTS.blog_post),
    generations: Math.floor(credits / COSTS.generation),
  };
}

export const PLANS = {
  free: {
    id: 'free',
    name: 'Free',
    usd: { month: 0, year: 0 },
    blurb: 'Try everything. No card, no wallet.',
    creditsOnce: 400,
    creditsMonthly: 0,
    limits: { sites: 1, pages: 5, deployMb: 5, filesPerDeploy: 150, versions: 10, forms: 3, languages: 2, seats: 1, domain: false, shop: false, bookings: false, reels: false, badge: true, watermark: true },
    features: [
      'Website at influencer.marketing.pit.world/site/yourname',
      'Blog, contact forms and newsletter sign-ups',
      'Schedule and publish to every network from your desktop environment',
      '400 credits once (about 6 ads and 1 blog post)',
      'Growth preview: 2 ads and 1 reel without a watermark, once',
      '1 brand, "Built with autoinfluencer" badge, ads watermarked after the preview',
    ],
  },
  solo: {
    id: 'solo',
    name: 'Solo',
    usd: { month: 49, year: 490 },
    blurb: 'One business, its own domain, a shop and bookings.',
    creditsOnce: 0,
    creditsMonthly: 3000,
    limits: { sites: 1, pages: 25, deployMb: 25, filesPerDeploy: 500, versions: 30, forms: 20, languages: 6, seats: 1, domain: true, shop: true, bookings: true, reels: true, badge: false, watermark: false },
    features: [
      'Everything in Free',
      'Your own domain (www, apex or blog.yourdomain.com)',
      'Bookings and an online shop (pay with CoinPay or arrange payment yourself)',
      'No badge, no watermark, reels',
      '3,000 credits every month (about 30 ads, 2 reels and 8 blog posts)',
    ],
  },
  studio: {
    id: 'studio',
    name: 'Studio',
    usd: { month: 149, year: 1490 },
    blurb: 'Three brands and a small team.',
    creditsOnce: 0,
    creditsMonthly: 10000,
    limits: { sites: 3, pages: 100, deployMb: 100, filesPerDeploy: 2000, versions: 50, forms: 100, languages: 20, seats: 3, domain: true, shop: true, bookings: true, reels: true, badge: false, watermark: false },
    features: [
      'Everything in Solo',
      '3 brands, each with its own domain',
      '3 team seats',
      '10,000 credits every month (about 100 ads, 6 reels and 33 blog posts)',
    ],
  },
  agency: {
    id: 'agency',
    name: 'Agency',
    usd: { month: 190, year: null },
    perClientUsd: 49,
    contact: true,
    blurb: 'Run client sites under your own name.',
    creditsOnce: 0,
    creditsMonthly: 0,
    limits: { sites: 100, pages: 100, deployMb: 100, filesPerDeploy: 2000, versions: 50, forms: 100, languages: 20, seats: 10, domain: true, shop: true, bookings: true, reels: true, badge: false, watermark: false },
    features: [
      'From $190/mo plus $49 per client site',
      'A workspace per client; clients edit by asking their own AI assistant',
      'Pooled monthly credits with a cap per client',
      'Your name and logo, no autoinfluencer badge',
      'Developer MCP, CLI, TUI and API for your team',
    ],
  },
};

export const PAID_PLANS = ['solo', 'studio'];
export const INTERVALS = { month: 30, year: 365 }; // days a payment covers

/** One-time credit top-ups (CoinPay). Credits never expire. */
export const TOPUPS = {
  t1000: { credits: 1000, usd: 10 },
  t2750: { credits: 2750, usd: 25 },
  t6000: { credits: 6000, usd: 50 },
  t13000: { credits: 13000, usd: 100 },
};

export function planFor(id) {
  return PLANS[id] ?? PLANS.free;
}

/** The public price sheet (served at /api/v1/pricing and rendered at /pricing). */
export function pricing() {
  return {
    credit_usd: CREDIT_USD,
    costs: COSTS,
    free_without_credits: ['websites and deploys', 'forms', 'bookings', 'newsletter sign-ups', 'shop orders', 'scheduling', 'publishing', 'brief mode (your own AI writes)', 'drafts by your own AI assistant'],
    free_generations_per_day: 3,
    plans: Object.values(PLANS).map((p) => ({ id: p.id, name: p.name, usd: p.usd, per_client_usd: p.perClientUsd, contact: !!p.contact, blurb: p.blurb, credits_once: p.creditsOnce, credits_monthly: p.creditsMonthly, limits: p.limits, features: p.features })),
    topups: Object.entries(TOPUPS).map(([id, t]) => ({ id, ...t })),
    payment: 'Crypto through CoinPay (plans and top-ups), or x402 per call for agents. No contract: a plan covers the period you paid for.',
  };
}
