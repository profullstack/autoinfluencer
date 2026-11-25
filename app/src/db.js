import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { newId, sha256 } from './util.js';
import { COSTS, PLANS } from './plans.js';
import { platformDb, PLATFORM_SCHEMA } from './platform-db.js';

export const FREE_PER_DAY = 3;

const SCHEMA = `
pragma journal_mode = wal;
pragma busy_timeout = 5000;
create table if not exists accounts (
  id text primary key,
  coinpay_sub text unique not null,
  email text,
  name text,
  created_at integer not null
);
create table if not exists personas (
  account_id text primary key references accounts(id) on delete cascade,
  json text not null,
  updated_at integer not null
);
create table if not exists balances (
  account_id text primary key references accounts(id) on delete cascade,
  credits integer not null default 0,
  free_day text,
  free_used integer not null default 0
);
create table if not exists ledger (
  id text primary key,
  account_id text,
  delta integer not null,
  reason text not null,
  ref text unique,
  created_at integer not null
);
create table if not exists coinpay_states (
  state_hash text primary key,
  verifier text not null,
  return_to text,
  expires_at integer not null
);
create table if not exists checkouts (
  id text primary key,
  account_id text not null,
  pack text not null,
  credits integer not null,
  status text not null default 'open',
  created_at integer not null
);
create table if not exists jobs (
  id text primary key,
  account_id text,
  tool text not null,
  status text not null,
  charge text,
  result text,
  error text,
  created_at integer not null,
  updated_at integer not null
);
create table if not exists meta (
  key text primary key,
  value text not null
);
`;

export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const raw = new DatabaseSync(path);
  raw.exec(SCHEMA);
  raw.exec(PLATFORM_SCHEMA);
  const get = (sql, ...a) => raw.prepare(sql).get(...a);
  const run = (sql, ...a) => raw.prepare(sql).run(...a);
  const now = () => Date.now();
  const today = () => new Date().toISOString().slice(0, 10);
  const tx = (fn) => {
    raw.exec('begin immediate');
    try {
      const r = fn();
      raw.exec('commit');
      return r;
    } catch (e) {
      raw.exec('rollback');
      throw e;
    }
  };

  // v2 (2026-11-25): 1 credit = $0.01 instead of 1 generation ($0.05). Balances and checkouts
  // not yet paid are multiplied by the generation cost once, so nobody loses what they bought.
  if (!get("select 1 from meta where key = 'credits_v2'")) {
    tx(() => {
      run('update balances set credits = credits * ?', COSTS.generation);
      run("update checkouts set credits = credits * ? where status = 'open'", COSTS.generation);
      run("insert into meta (key, value) values ('credits_v2', ?)", String(now()));
    });
  }

  function balance(accountId) {
    run('insert into balances (account_id) values (?) on conflict do nothing', accountId);
    // The Free plan's one-time credits, once per account (also for accounts made before plans).
    if (PLANS.free.creditsOnce && !get('select 1 from ledger where ref = ?', `welcome:${accountId}`) && get('select 1 from accounts where id = ?', accountId)) {
      run('update balances set credits = credits + ? where account_id = ?', PLANS.free.creditsOnce, accountId);
      run('insert into ledger (id, account_id, delta, reason, ref, created_at) values (?, ?, ?, ?, ?, ?)', newId(), accountId, PLANS.free.creditsOnce, 'Free plan credits', `welcome:${accountId}`, now());
    }
    const b = get('select * from balances where account_id = ?', accountId);
    const freeUsed = b.free_day === today() ? b.free_used : 0;
    return { credits: b.credits, free_left: Math.max(0, FREE_PER_DAY - freeUsed) };
  }

  const api = {
    raw,
    accountById: (id) => get('select * from accounts where id = ?', id) ?? null,
    accountBySub: (sub) => get('select * from accounts where coinpay_sub = ?', sub) ?? null,

    /** Bind by CoinPay `sub` only; email and name are display data (CoinPay emails are unverified). */
    upsertCoinpayAccount({ sub, email, name }) {
      if (!sub) throw new Error('CoinPay userinfo had no sub');
      const existing = get('select * from accounts where coinpay_sub = ?', sub);
      if (existing) {
        run('update accounts set email = ?, name = ? where id = ?', email ?? existing.email, name ?? existing.name, existing.id);
        return get('select * from accounts where id = ?', existing.id);
      }
      const id = `acc_${newId(10)}`;
      run('insert into accounts (id, coinpay_sub, email, name, created_at) values (?, ?, ?, ?, ?)', id, sub, email ?? null, name ?? null, now());
      return get('select * from accounts where id = ?', id);
    },

    persona(accountId) {
      const r = get('select json from personas where account_id = ?', accountId);
      return r ? JSON.parse(r.json) : null;
    },
    savePersona(accountId, p) {
      run('insert into personas (account_id, json, updated_at) values (?, ?, ?) on conflict(account_id) do update set json = excluded.json, updated_at = excluded.updated_at', accountId, JSON.stringify(p), now());
    },

    balance,

    /**
     * Spend `cost` credits. Generations (`free: true`) use a free daily run first.
     * Returns 'free' | 'credit' | null (not enough).
     */
    spend(accountId, ref, cost = COSTS.generation, { free = true, reason = 'generation' } = {}) {
      return tx(() => {
        const b = balance(accountId);
        if (free && b.free_left > 0) {
          const row = get('select * from balances where account_id = ?', accountId);
          const used = row.free_day === today() ? row.free_used + 1 : 1;
          run('update balances set free_day = ?, free_used = ? where account_id = ?', today(), used, accountId);
          run('insert into ledger (id, account_id, delta, reason, ref, created_at) values (?, ?, 0, ?, ?, ?)', newId(), accountId, `free ${reason}`, ref, now());
          return 'free';
        }
        if (b.credits >= cost) {
          run('update balances set credits = credits - ? where account_id = ?', cost, accountId);
          run('insert into ledger (id, account_id, delta, reason, ref, created_at) values (?, ?, ?, ?, ?, ?)', newId(), accountId, -cost, reason, ref, now());
          return 'credit';
        }
        return null;
      });
    },

    /** Give back a spend whose work produced nothing (the amount comes from the ledger row). */
    refund(accountId, kind, ref) {
      tx(() => {
        if (get('select 1 from ledger where ref = ?', `refund:${ref}`)) return;
        const spent = get('select delta from ledger where ref = ? and account_id = ?', ref, accountId);
        const amount = kind === 'credit' ? Math.max(0, -(spent?.delta ?? 0)) : 0;
        if (amount) run('update balances set credits = credits + ? where account_id = ?', amount, accountId);
        if (kind === 'free') run('update balances set free_used = max(0, free_used - 1) where account_id = ? and free_day = ?', accountId, today());
        run('insert into ledger (id, account_id, delta, reason, ref, created_at) values (?, ?, ?, ?, ?, ?)', newId(), accountId, amount, 'refund', `refund:${ref}`, now());
      });
    },

    ledger: (accountId, limit = 50) => raw.prepare('select delta, reason, created_at from ledger where account_id = ? order by created_at desc limit ?').all(accountId, limit),

    /** Add credits once per payment reference. Returns false when already applied. */
    addCredits(accountId, credits, ref, reason = 'purchase') {
      return tx(() => {
        if (get('select 1 from ledger where ref = ?', ref)) return false;
        balance(accountId);
        run('update balances set credits = credits + ? where account_id = ?', credits, accountId);
        run('insert into ledger (id, account_id, delta, reason, ref, created_at) values (?, ?, ?, ?, ?, ?)', newId(), accountId, credits, reason, ref, now());
        return true;
      });
    },

    saveState(state, verifier, returnTo) {
      run('delete from coinpay_states where expires_at < ?', now());
      run('insert into coinpay_states (state_hash, verifier, return_to, expires_at) values (?, ?, ?, ?)', sha256(state), verifier, returnTo ?? null, now() + 600_000);
    },
    takeState(state) {
      const row = get('select * from coinpay_states where state_hash = ?', sha256(state));
      if (!row) return null;
      run('delete from coinpay_states where state_hash = ?', row.state_hash);
      return row.expires_at >= now() ? row : null;
    },

    createCheckout(id, accountId, pack, credits) {
      run('insert into checkouts (id, account_id, pack, credits, created_at) values (?, ?, ?, ?, ?)', id, accountId, pack, credits, now());
    },
    checkout: (id) => get('select * from checkouts where id = ?', id) ?? null,
    markCheckout: (id, status) => run('update checkouts set status = ? where id = ?', status, id),

    createJob(id, accountId, tool, charge) {
      run('insert into jobs (id, account_id, tool, status, charge, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)', id, accountId ?? null, tool, 'running', charge ?? null, now(), now());
    },
    finishJob(id, { result, error }) {
      run('update jobs set status = ?, result = ?, error = ?, updated_at = ? where id = ?', error ? 'failed' : 'done', result ? JSON.stringify(result) : null, error ?? null, now(), id);
    },
    job(id) {
      const j = get('select * from jobs where id = ?', id);
      if (!j) return null;
      return { id: j.id, account_id: j.account_id, tool: j.tool, status: j.status, result: j.result ? JSON.parse(j.result) : undefined, error: j.error ?? undefined };
    },
    /** Jobs that were running when the process died will never finish. */
    failOrphans() {
      run("update jobs set status = 'failed', error = 'interrupted by a restart; run it again (refunded)' where status = 'running'");
    },
  };
  return Object.assign(api, platformDb({ raw, get, run, tx, now, newId, balance }));
}
