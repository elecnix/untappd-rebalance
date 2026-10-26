#!/usr/bin/env node
// Rebalance your Untappd ratings onto a distribution you choose.
//
//   login    pull untappd.com cookies out of Chrome (one prompt, then Chrome is free)
//   fetch    download every check-in into data/checkins.jsonl
//   propose  work out a mapping, print it, write data/plan.json
//   apply    write the mapping to the account, one check-in at a time, with a ledger
//   reverse  put every rewritten rating back
//   apk      read the app's OAuth client out of an Untappd APK
//
// Two separate auth mechanisms are involved, and it matters which is which:
//
//   the website   cookie session, used by fetch (read-only, the profile's own feed)
//   the app API   client credentials + an access token, used by apply/reverse
//
// The app API is not the public v4 API. It is the surface the mobile app itself talks to,
// reached with the app's own OAuth client, and Untappd does not document or license it for
// third parties. See README.md before pointing this at an account you care about.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  readSync,
  realpathSync,
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  appendFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = 'https://untappd.com';
const API = 'https://api.untappd.com/v4';
const WEB_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const APP_UA = 'Untappd/3.5.3 (Linux; Android 14)';
const SNAP = 0.25; // Untappd stores quarter points and nothing finer
const FLOOR = 0.25; // lowest rating the site accepts; 0 means "unrated"
const CEILING = 5;

const CONFIG = resolve(homedir(), '.config/untappd-rebalance');
const COOKIES = join(CONFIG, 'cookies.json');
const APP_CLIENT = join(CONFIG, 'app-client.json');
const APP_TOKEN = join(CONFIG, 'token.json');

// ---------------------------------------------------------------- argv

const [command, ...rest] = process.argv.slice(2);
const argv = rest;
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  if (i === -1) return d;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? d : v;
};
// Positional arguments, skipping the values of the options that take one.
const positional = (withValue = []) => {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      if (withValue.includes(argv[i].slice(2))) i++;
      continue;
    }
    out.push(argv[i]);
  }
  return out;
};

const USER = String(opt('user', ''));
const repo = resolve(opt('repo', process.cwd()));
const checkinsPath = resolve(repo, opt('in', 'data/checkins.jsonl'));
const planPath = resolve(repo, opt('plan', 'data/plan.json'));
const ledgerPath = resolve(repo, opt('ledger', 'data/applied.jsonl'));
const delayMs = Number(opt('delay', '1200'));
const batch = Number(opt('batch', '50'));

const die = (msg, code = 1) => {
  console.error(msg);
  process.exit(code);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const usage = () => {
  console.log(`usage: rebalance.mjs <command> [options]

  login                 pull untappd.com cookies out of Chrome (one debugging prompt)
  fetch                 download every check-in → data/checkins.jsonl
  propose               compute a mapping and print it → data/plan.json
  apply                 write the mapping to the account (needs --yes)
  reverse               put every rewritten rating back (needs --yes)
  apk <file.apk>        print the app's OAuth client, read from a Cordova APK

common options
  --repo PATH           directory holding data/ (default: cwd)
  --user NAME           Untappd username (default: the name in the cookie file)

fetch options
  --cookies PATH        cookie jar (default ${COOKIES})
  --delay MS            pause between feed pages (default 700)
  --max-pages N         safety stop (default 500)

propose options
  --target N            median you want after the rewrite (default 2.5)
  --strategy NAME       shift | quantile | compress (default quantile)
  --no-pin-top          quantile only: let the best rating float instead of pinning it to 5

apply / reverse options
  --yes                 actually write to the account; without it, print the plan
  --limit N             stop after N writes
  --delay MS            pause between writes (default 1200)
  --max-failures N      stop after N consecutive failures (default 5)
  --batch N             commit + push the ledger every N writes (default 50; 0 = never)
  --dry-run             print what would be written, change nothing`);
  process.exit(command ? 2 : 0);
};

// ---------------------------------------------------------------- website (read)

function loadCookies(file = COOKIES) {
  if (!existsSync(file)) {
    die(
      `no cookie file at ${file}\n` +
        'run: rebalance.mjs login\n' +
        'or paste a Cookie request header into that file as {"header": "…"}',
    );
  }
  const jar = JSON.parse(readFileSync(file, 'utf8'));
  if (jar.header) return { header: jar.header, expiresAt: null };
  const now = Date.now() / 1000;
  const live = (jar.cookies || []).filter((c) => !c.expires || c.expires < 0 || c.expires > now);
  if (!live.length) die(`every cookie in ${file} has expired — run: rebalance.mjs login`);
  return {
    header: live.map((c) => `${c.name}=${c.value}`).join('; '),
    expiresAt: live.find((c) => /untappd_session/.test(c.name))?.expires ?? null,
  };
}

let cookieHeader = '';

async function webRequest(path, { xhr = false, retries = 3 } = {}) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(BASE + path, {
        headers: {
          cookie: cookieHeader,
          'user-agent': WEB_UA,
          accept: 'text/html,application/xhtml+xml',
          'accept-language': 'en-CA,en;q=0.9',
          referer: `${BASE}/user/${USER}`,
          ...(xhr ? { 'x-requested-with': 'XMLHttpRequest' } : {}),
        },
        redirect: 'follow',
      });
    } catch (e) {
      if (attempt >= retries) throw new Error(`${path}: ${e.message}`);
      await sleep(1000 * (attempt + 1));
      continue;
    }
    const body = await res.text();
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      await sleep(2000 * (attempt + 1));
      continue;
    }
    return { status: res.status, body };
  }
}

// ---------------------------------------------------------------- parsing

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#x27': "'", '#039': "'" };
const decode = (s) =>
  s
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-z]+|#\d+);/gi, (m, name) => ENTITIES[name] ?? m);
const text = (s) => decode(s.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

const ITEM_START = /<div class="item[^"]*"[^>]*\bid="checkin_(\d+)"/g;

// Two link shapes for a brewery: the legacy `/SomeBrewery` slug and the newer
// `/w/some-brewery/434394`. Only the second carries a numeric id.
function breweryOf(href) {
  if (!href) return { slug: null, id: null };
  const modern = href.match(/^\/w\/([^/]+)\/(\d+)$/);
  if (modern) return { slug: modern[1], id: Number(modern[2]) };
  const legacy = href.match(/^\/([^/]+)$/);
  return { slug: legacy ? legacy[1] : null, id: null };
}

export function parseItems(html) {
  const starts = [...html.matchAll(ITEM_START)];
  const out = [];
  for (let i = 0; i < starts.length; i++) {
    const m = starts[i];
    const chunk = html.slice(m.index + m[0].length, starts[i + 1]?.index ?? html.length);
    const rec = parseItem(Number(m[1]), chunk);
    if (rec) out.push(rec);
  }
  return out;
}

function parseItem(id, chunk) {
  const pick = (re, group = 1) => {
    const m = chunk.match(re);
    return m ? m[group] : null;
  };
  const when = pick(/class="time[^"]*"[^>]*>([^<]+)</);
  const created = when ? new Date(when.trim()) : null;
  if (created && Number.isNaN(created.getTime())) return null;

  const beerLink = chunk.match(/<a\s+href="\/b\/([^"/]+)\/(\d+)"/);
  // "is drinking a Talas" but "is drinking The Answer" — the article is not always there.
  const drinking = chunk.match(
    /is drinking\s+(?:an?\s+)?<a\s+href="\/b\/[^"]*">([^<]*)<\/a>\s*by\s*<a[^>]*href="(\/[^"]+)"[^>]*>([^<]*)<\/a>(?:\s*at\s*<a[^>]*href="\/v\/([^"/]+)\/(\d+)"[^>]*>([^<]*)<\/a>)?/,
  );
  const ratingRaw = pick(/class="caps[^"]*"\s*data-rating="([0-9.]+)"/);
  const comment = pick(/class="comment-text"[^>]*>([\s\S]*?)<\/p>/);
  const serving = pick(/class="serving">[\s\S]*?<span>([^<]*)<\/span>/);
  const toasts = pick(/class="count">\s*<span>(\d+)</);

  return {
    checkin_id: id,
    url: `${BASE}/user/${USER}/checkin/${id}`,
    created_at: created ? created.toISOString() : null,
    rating: ratingRaw ? Number(ratingRaw) : null,
    comment: comment ? text(comment) || null : null,
    serving: serving ? text(serving) : null,
    beer: {
      name: drinking ? text(drinking[1]) : null,
      bid: beerLink ? Number(beerLink[2]) : null,
      slug: beerLink ? beerLink[1] : null,
    },
    brewery: { name: drinking ? text(drinking[3]) : null, ...breweryOf(drinking?.[2]) },
    venue: drinking && drinking[5] ? { name: text(drinking[6]), id: Number(drinking[5]) } : null,
    toasts: toasts ? Number(toasts) : 0,
  };
}

// ---------------------------------------------------------------- login

function devtoolsUrl() {
  if (process.env.CDP_BROWSER_WS) return process.env.CDP_BROWSER_WS;
  const candidates = [
    resolve(homedir(), '.config/google-chrome/DevToolsActivePort'),
    resolve(homedir(), 'Library/Application Support/Google/Chrome/DevToolsActivePort'),
  ];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    const [port, path] = readFileSync(file, 'utf8').trim().split('\n');
    if (!/^\d+$/.test(port || '')) continue;
    return `ws://127.0.0.1:${port}${path?.startsWith('/devtools/browser') ? path : '/devtools/browser'}`;
  }
  die(
    'Chrome is not reachable over DevTools.\n' +
      `looked in:\n  ${candidates.join('\n  ')}\n` +
      'open chrome://inspect/#remote-debugging, turn the switch on, retry.',
  );
}

// One attach, one cookie dump, done — Chrome shows its "Allow debugging" bar once, and a
// sync afterwards runs on plain fetch with no browser involved.
async function login() {
  const url = devtoolsUrl();
  const ws = new WebSocket(url);
  let id = 0;
  let session = null;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id !== undefined && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  };
  const send = (method, params = {}, timeoutMs = 60000) =>
    new Promise((res, rej) => {
      const i = ++id;
      const timer = setTimeout(() => {
        pending.delete(i);
        rej(new Error(`${method}: no reply from Chrome in ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(i, (m) => {
        clearTimeout(timer);
        if (m.error) rej(new Error(`${method}: ${m.error.message || JSON.stringify(m.error)}`));
        else res(m.result);
      });
      const msg = { id: i, method, params };
      if (session) msg.sessionId = session;
      ws.send(JSON.stringify(msg));
    });

  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error(`could not connect to Chrome at ${url}`));
  });
  try {
    const pages = (await send('Target.getTargets')).targetInfos.filter((t) => t.type === 'page');
    let tab = pages.find((t) => /untappd\.com/.test(t.url || ''));
    if (!tab) tab = { targetId: (await send('Target.createTarget', { url: `${BASE}/` })).targetId };
    session = (await send('Target.attachToTarget', { targetId: tab.targetId, flatten: true })).sessionId;
    await send('Network.enable', {});
    const jar = new Map();
    const users = new Set([`${BASE}/`, ...(USER ? [`${BASE}/user/${USER}`] : [])]);
    for (const u of users) {
      for (const c of (await send('Network.getCookies', { urls: [u] })).cookies || []) {
        jar.set(`${c.name}|${c.domain}`, c);
      }
    }
    const cookies = [...jar.values()].filter((c) => /untappd\.com$/.test(c.domain));
    if (!cookies.length) die('Chrome holds no untappd.com cookies — sign in to untappd.com first');
    mkdirSync(CONFIG, { recursive: true, mode: 0o700 });
    writeFileSync(
      COOKIES,
      JSON.stringify({ saved_at: new Date().toISOString(), cookies }, null, 2) + '\n',
      { mode: 0o600 },
    );
    const s = cookies.find((c) => /untappd_session/.test(c.name));
    const days = s?.expires ? Math.round((s.expires - Date.now() / 1000) / 86400) : null;
    console.log(`wrote ${COOKIES} (${cookies.length} cookies)`);
    console.log(days === null ? 'session cookie: session-only' : `session cookie: expires in ${days} day(s)`);
  } finally {
    ws.close();
  }
}

// ---------------------------------------------------------------- fetch

function writeAtomic(file, body) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, body);
  try {
    renameSync(tmp, file);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {}
    throw e;
  }
}

async function fetchAll() {
  const jar = loadCookies(opt('cookies', COOKIES));
  cookieHeader = jar.header;

  // The username has to be known before any request, and it is the thing the feed URL is
  // built from. Derive it from the profile page the session already points at.
  if (!USER) die('--user NAME is required (the Untappd username whose history to download)');

  const profile = await webRequest(`/user/${USER}`);
  if (profile.status !== 200) die(`GET /user/${USER} returned HTTP ${profile.status}`);
  if (!/\/logout/.test(profile.body)) die('the session cookie is not signed in (no Logout link)');

  const store = new Map();
  const absorb = (items) => {
    for (const rec of items) store.set(rec.checkin_id, rec);
  };
  const first = parseItems(profile.body);
  if (!first.length) die('the profile page returned no check-ins — markup changed?');
  absorb(first);

  // The full stream is behind the "Show More" button. Without the XHR header the server
  // returns the whole home page instead of a fragment.
  let cursor = Math.max(...first.map((r) => r.checkin_id));
  const delay = Number(opt('delay', '700'));
  const maxPages = Number(opt('max-pages', '500'));
  let pages = 0;
  while (pages < maxPages) {
    await sleep(delay);
    const r = await webRequest(`/profile/more_feed/${USER}/${cursor}?v2=true`, { xhr: true });
    pages++;
    if (r.status !== 200) die(`more_feed returned HTTP ${r.status} at cursor ${cursor}`);
    if (!r.body.trim()) break;
    const items = parseItems(r.body);
    if (!items.length) break;
    absorb(items);
    const min = Math.min(...items.map((x) => x.checkin_id));
    if (min >= cursor) die(`more_feed did not advance (cursor ${cursor}, page min ${min})`);
    cursor = min;
  }

  const records = [...store.values()].sort((a, b) => a.checkin_id - b.checkin_id);
  const rated = records.filter((r) => r.rating !== null).length;
  const body = records.map((r) => JSON.stringify(r) + '\n').join('');
  writeAtomic(checkinsPath, body);
  console.log(
    `${pages + 1} page(s): ${records.length} check-ins (${rated} rated) → ${checkinsPath} (${(body.length / 1024).toFixed(0)} KiB)`,
  );
}

// ---------------------------------------------------------------- propose

// Mid-rank percentile per rating level: a tie block maps to the middle of its own block,
// so 400 identical ratings get one value instead of a spread invented by tie-breaking.
function percentiles(rated) {
  const counts = new Map();
  for (const r of rated) counts.set(r.rating, (counts.get(r.rating) ?? 0) + 1);
  const levels = [...counts.keys()].sort((a, b) => a - b);
  const n = rated.length;
  let seen = 0;
  const p = new Map();
  for (const level of levels) {
    p.set(level, (seen + counts.get(level) / 2) / n);
    seen += counts.get(level);
  }
  return { counts, levels, percentiles: p, n };
}

const medianOf = (values) => {
  const v = [...values].sort((a, b) => a - b);
  const mid = (v.length - 1) / 2;
  const lo = Math.floor(mid);
  const hi = Math.ceil(mid);
  return (v[lo] + v[hi]) / 2;
};

const snap = (v) =>
  Math.min(CEILING, Math.max(FLOOR, Number((Math.round((v + Number.EPSILON) / SNAP) * SNAP).toFixed(2))));

// Three families, and the choice between them is a real trade-off, not a preference:
//
//   shift     translate by a constant so the median lands on the target. Preserves every
//             gap and the shape exactly; clips the top (a 5 becomes 5 - delta).
//   quantile  map by percentile, pinned at median→target and best→5. Spreads the crowded
//             middle, which is the only family that does; merges rare levels at the floor.
//   compress  linear from the minimum to the median. Keeps the bottom ordered and distinct
//             and never clips, but shrinks the range instead of spreading it.
//
// There is no fourth option that spreads *and* keeps every level: with 20 usable slots and
// 19 observed levels, pinning the median at 2.5 forces at least four of them to merge.
function buildMapping(rated, { target, strategy, pinTop }) {
  const { counts, levels, percentiles: p, n } = percentiles(rated);
  const med = medianOf(rated.map((r) => r.rating));
  const best = levels[levels.length - 1];
  let f;

  if (strategy === 'shift') {
    // A flat translation, full stop. Pinning the top here would leave a hole: 4.75 would
    // move to 3.25 while 5 stayed put. Clipping is what shift *does*.
    const delta = med - target;
    f = (level) => level - delta;
  } else if (strategy === 'compress') {
    const lo = levels[0];
    const slope = (target - lo) / (med - lo);
    f = (level) => lo + (level - lo) * slope;
  } else {
    const pMid = p.get(med);
    const pTop = pinTop ? p.get(best) : 1;
    const topValue = pinTop ? CEILING : Math.min(CEILING, target + (CEILING - target) * 0.8);
    const slope = (topValue - target) / (pTop - pMid);
    f = (level) => target + (p.get(level) - pMid) * slope;
  }

  const mapping = levels.map((level) => ({
    rating: level,
    checkins: counts.get(level),
    shifted: snap(f(level)),
  }));
  const byLevel = new Map(mapping.map((m) => [m.rating, m.shifted]));
  return {
    strategy,
    target,
    pin_top: pinTop,
    median_rating: med,
    best_rating: best,
    levels_in: levels.length,
    levels_out: new Set(mapping.map((m) => m.shifted)).size,
    mapping,
    byLevel,
    n,
  };
}

function propose() {
  if (!existsSync(checkinsPath)) die(`no ${checkinsPath} — run: rebalance.mjs fetch`);
  const records = readFileSync(checkinsPath, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
  const rated = records.filter((r) => typeof r.rating === 'number' && r.rating > 0);
  if (!rated.length) die('no rated check-ins in the archive');

  const target = Number(opt('target', '2.5'));
  const strategy = String(opt('strategy', 'quantile'));
  if (!['shift', 'quantile', 'compress'].includes(strategy)) die(`unknown strategy ${strategy}`);
  if (!Number.isFinite(target) || target < FLOOR || target > CEILING) {
    die(`--target must be between ${FLOOR} and ${CEILING}`);
  }
  const pinTop = !flag('no-pin-top');

  const plan = buildMapping(rated, { target, strategy, pinTop });
  const after = rated.map((r) => plan.byLevel.get(r.rating));
  const before = rated.map((r) => r.rating);
  const dist = [...new Set(after)].sort((a, b) => a - b).map((v) => ({
    rating: v,
    checkins: after.filter((x) => x === v).length,
  }));

  const width = Math.max(...dist.map((d) => d.checkins));
  console.log(`${rated.length} rated check-ins, ${plan.levels_in} distinct ratings → ${plan.levels_out}`);
  console.log(
    `median ${medianOf(before)} → ${medianOf(after)}   mean ${(before.reduce((a, b) => a + b, 0) / before.length).toFixed(2)} → ${(
      after.reduce((a, b) => a + b, 0) / after.length
    ).toFixed(2)}\n`,
  );
  console.log('  was                     new      count');
  for (const d of dist) {
    const was = plan.mapping.filter((m) => m.shifted === d.rating).map((m) => m.rating).join(' = ');
    console.log(
      `  ${was.padEnd(23)} ${String(d.rating).padStart(5)}  ${String(d.checkins).padStart(6)}  ${'█'.repeat(
        Math.round((d.checkins / width) * 30),
      )}`,
    );
  }

  const out = {
    generated_from: 'data/checkins.jsonl',
    source_sha256: createHash('sha256').update(readFileSync(checkinsPath)).digest('hex'),
    checkins: rated.length,
    strategy,
    target,
    pin_top: pinTop,
    median_before: medianOf(before),
    median_after: medianOf(after),
    mean_before: Number((before.reduce((a, b) => a + b, 0) / before.length).toFixed(3)),
    mean_after: Number((after.reduce((a, b) => a + b, 0) / after.length).toFixed(3)),
    levels_in: plan.levels_in,
    levels_out: plan.levels_out,
    mapping: plan.mapping,
    distribution_after: dist,
  };
  writeAtomic(planPath, JSON.stringify(out, null, 2) + '\n');
  console.log(`\nwrote ${planPath}`);
  console.log('next: rebalance.mjs apply            (prints what it would do)');
  console.log('      rebalance.mjs apply --yes      (writes it to the account)');
}

// ---------------------------------------------------------------- app API (write)

function loadAppClient() {
  if (process.env.UNTAPPD_CLIENT_ID && process.env.UNTAPPD_CLIENT_SECRET) {
    return {
      client_id: process.env.UNTAPPD_CLIENT_ID,
      client_secret: process.env.UNTAPPD_CLIENT_SECRET,
      app_version: process.env.UNTAPPD_APP_VERSION || '3.5.3',
    };
  }
  if (!existsSync(APP_CLIENT)) {
    die(
      `no app client at ${APP_CLIENT}\n` +
        'it holds the app\'s own OAuth client (client_id, client_secret, app_version).\n' +
        'see "Reading the credentials out of the APK" in README.md, or set\n' +
        'UNTAPPD_CLIENT_ID / UNTAPPD_CLIENT_SECRET.',
    );
  }
  return JSON.parse(readFileSync(APP_CLIENT, 'utf8'));
}

function loadToken() {
  if (!existsSync(APP_TOKEN)) return null;
  try {
    return JSON.parse(readFileSync(APP_TOKEN, 'utf8'));
  } catch {
    return null;
  }
}

// Read one line without echoing it: the password never enters argv, the environment or
// any file, and only the resulting token is stored.
function promptHidden(question) {
  if (!process.stdin.isTTY) die('no password available: run in a terminal, or set UNTAPPD_PASSWORD');
  process.stdout.write(question);
  const stty = (a) => {
    try {
      execFileSync('stty', [a], { stdio: ['inherit', 'inherit', 'inherit'] });
    } catch {}
  };
  stty('-echo');
  let out = '';
  const buf = Buffer.alloc(1);
  try {
    for (;;) {
      const n = readSync(0, buf, 0, 1, null);
      if (!n) break;
      const ch = buf.toString('utf8');
      if (ch === '\n' || ch === '\r') break;
      out += ch;
    }
  } finally {
    stty('echo');
    process.stdout.write('\n');
  }
  return out;
}

async function apiRequest(path, { form, token, client } = {}) {
  const params = new URLSearchParams({
    client_id: client.client_id,
    client_secret: client.client_secret,
    utv: client.app_version || '3.5.3',
  });
  if (token) params.set('access_token', token);
  const res = await fetch(`${API}${path}?${params}`, {
    method: 'POST',
    headers: {
      'user-agent': APP_UA,
      accept: 'application/json',
      'accept-language': 'en',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: form ? new URLSearchParams(form).toString() : '',
  });
  const raw = await res.text();
  let json = null;
  try {
    json = JSON.parse(raw);
  } catch {}
  return { status: res.status, json, raw };
}

// POST /v4/xauth — client credentials only, no token yet. `app_verison` is misspelled in
// the app itself and has to be sent that way.
async function appLogin({ user, password, client }) {
  const { status, json } = await apiRequest('/xauth', {
    client,
    form: {
      user_name: user,
      user_password: password,
      app_verison: client.app_version || '3.5.3',
      existing_device: 'old',
      device_name: 'sdk_gphone64_x86_64',
      device_udid: '7f3c1a9e52bd4c81',
      device_version: '14',
      device_platform: 'Android',
    },
  });
  const r = json?.response;
  if (status !== 200 || !r?.access_token) {
    die(
      `login failed (HTTP ${status}): ${json?.meta?.error_type ?? '?'} ${json?.meta?.error_detail ?? ''}`.trim(),
    );
  }
  mkdirSync(CONFIG, { recursive: true, mode: 0o700 });
  writeFileSync(
    APP_TOKEN,
    JSON.stringify({ access_token: r.access_token, username: r.username || user, saved_at: new Date().toISOString() }, null, 2) + '\n',
    { mode: 0o600 },
  );
  console.log(`wrote ${APP_TOKEN} (signed in as ${r.username || user})`);
  return r.access_token;
}

// The value the plan says a check-in should end up with, whatever its current rating is.
function targetFor(record, plan) {
  const row = plan.mapping.find((m) => m.rating === record.rating);
  return row ? row.shifted : record.rating;
}

function readLedger() {
  const last = new Map();
  let lines = 0;
  if (!existsSync(ledgerPath)) return { last, lines };
  for (const line of readFileSync(ledgerPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    lines++;
    const rec = JSON.parse(line);
    last.set(Number(rec.checkin_id), rec);
  }
  return { last, lines };
}

function gitCommitLedger(n, reverse) {
  if (batch <= 0 || !existsSync(join(repo, '.git'))) return;
  try {
    execFileSync('git', ['-C', repo, 'add', 'data/applied.jsonl'], { stdio: 'pipe' });
    execFileSync(
      'git',
      [
        '-C',
        repo,
        'commit',
        '-q',
        '-m',
        `chore(rebalance): ${reverse ? 'revert' : 'rewrite'} ${n} rating(s)\n\nLedger of the bulk rewrite: one line per check-in with the value before and after.\nIt is both the resume point and the undo log.\n`,
      ],
      { stdio: 'pipe' },
    );
    execFileSync('git', ['-C', repo, 'push', '-q', 'origin', 'HEAD'], { stdio: 'pipe' });
    console.log(`  … committed and pushed (${n} in this batch)`);
  } catch (e) {
    console.error(`  … git failed: ${String(e.stderr || e.message).trim().split('\n')[0]}`);
  }
}

async function write() {
  const reverse = command === 'reverse';
  if (!existsSync(planPath)) die(`no ${planPath} — run: rebalance.mjs propose`);
  if (!existsSync(checkinsPath)) die(`no ${checkinsPath} — run: rebalance.mjs fetch`);
  const plan = JSON.parse(readFileSync(planPath, 'utf8'));
  const records = new Map(
    readFileSync(checkinsPath, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l))
      .map((r) => [Number(r.checkin_id), r]),
  );
  const { last, lines: ledgerLines } = readLedger();

  // The account is the source of truth for a rating, but the archive is what we fetched;
  // if the plan was made from a different snapshot, the targets are wrong.
  if (!reverse && plan.source_sha256) {
    const now = createHash('sha256').update(readFileSync(checkinsPath)).digest('hex');
    if (now !== plan.source_sha256) {
      die(
        `the plan was computed from a different ${basename(checkinsPath)} (sha256 differs).\n` +
          're-run: rebalance.mjs propose',
      );
    }
  }

  const done = reverse ? 'reverted' : 'success';
  const queue = [];
  for (const [id, rec] of records) {
    if (typeof rec.rating !== 'number' || !rec.rating) continue;
    if (!rec.beer?.bid) continue;
    const prev = last.get(id);
    if (prev && (prev.result === done || prev.result === 'unchanged')) continue;
    if (reverse && !prev) continue;
    const to = reverse ? prev.from : targetFor(rec, plan);
    const from = reverse ? prev.to : rec.rating;
    if (!reverse && from === to) continue;
    queue.push({ id, bid: rec.beer.bid, beer: rec.beer.name ?? '', from, to });
  }

  const yes = flag('yes');
  const limit = Number(opt('limit', '0')) || Infinity;
  const dryRun = flag('dry-run') || !yes;
  const maxFailures = Number(opt('max-failures', '5'));
  const jobs = queue.slice(0, limit === Infinity ? queue.length : limit);

  if (!jobs.length) {
    console.log(reverse ? 'nothing to revert' : 'every check-in already matches the plan');
    return;
  }
  console.log(
    `${reverse ? 'REVERSING' : 'REBALANCING'} ${jobs.length} check-in(s)` +
      `  (ledger: ${ledgerLines} line(s), ${last.size} touched)` +
      (dryRun ? '  [dry run]' : ''),
  );

  if (dryRun) {
    for (const j of jobs) console.log(`  ${j.id}  ${j.beer}  ${j.from} → ${j.to}`);
    console.log(`\nnothing written. add --yes to apply.`);
    return;
  }

  const client = loadAppClient();
  let token = loadToken()?.access_token || null;
  if (!token) {
    const user = String(opt('user', ''));
    if (!user) die('--user NAME is required to sign in to the API');
    token = await appLogin({ user, password: process.env.UNTAPPD_PASSWORD || promptHidden('Untappd password: '), client });
  }

  let written = 0;
  let failed = 0;
  let streak = 0;
  let inBatch = 0;
  let stop = null;

  for (const [i, job] of jobs.entries()) {
    let attempt = 0;
    let out;
    for (;;) {
      try {
        out = await apiRequest(`/beer/rate/${job.bid}`, {
          client,
          token,
          form: { checkin_id_rate: String(job.id), rating_score: String(job.to) },
        });
      } catch (e) {
        out = { status: 0, json: null, raw: e.message };
      }
      if (out.status === 429 && attempt < 3) {
        const wait = 30000 * (attempt + 1);
        console.log(`  429, waiting ${wait / 1000}s`);
        await sleep(wait);
        attempt++;
        continue;
      }
      break;
    }

    const ok = out.json?.response?.result === 'success';
    appendFileSync(
      ledgerPath,
      JSON.stringify({
        checkin_id: job.id,
        beer: job.beer,
        from: job.from,
        to: job.to,
        result: ok ? (reverse ? 'reverted' : 'success') : 'error',
        status: out.status,
        at: new Date().toISOString(),
        ...(ok
          ? {}
          : { error: out.json?.meta?.error_type ?? `http_${out.status}`, detail: out.json?.meta?.error_detail ?? String(out.raw).slice(0, 160) }),
      }) + '\n',
    );
    inBatch++;

    if (ok) {
      written++;
      streak = 0;
      console.log(`  ${String(i + 1).padStart(4)}/${jobs.length}  ${job.beer}  ${out.json.response.old_score} → ${out.json.response.new_score}`);
    } else {
      failed++;
      streak++;
      console.log(`  ${String(i + 1).padStart(4)}/${jobs.length}  ${job.beer}  FAILED ${out.status}`);
      if (out.status === 401 || out.status === 403) {
        stop = 'auth rejected — re-run and sign in again';
        break;
      }
      if (streak >= maxFailures) {
        stop = `${streak} failures in a row`;
        break;
      }
    }
    if (batch > 0 && inBatch >= batch) {
      gitCommitLedger(inBatch, reverse);
      inBatch = 0;
    }
    if (i + 1 < jobs.length) await sleep(delayMs);
  }

  if (inBatch) gitCommitLedger(inBatch, reverse);
  console.log(`\n${reverse ? 'reverted' : 'rewritten'}: ${written}   failed: ${failed}`);
  if (stop) console.log(`stopped: ${stop}`);
  const left = queue.length - written;
  if (left > 0) console.log(`${left} still queued — rerun the same command to continue`);
}

// ---------------------------------------------------------------- apk credentials

// The Untappd app is Cordova/Ionic, so its whole network layer is plain JavaScript under
// assets/www. That is what makes this recoverable without an emulator: no root, no TLS
// interception, no certificate pinning to defeat. Read the bundle, not the binary.
function apkCreds(file) {
  if (!file) die('usage: rebalance.mjs apk <file.apk>');
  if (!existsSync(file)) die(`no such file: ${file}`);
  const dir = join(tmpdir(), `untappd-apk-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  // Only the web assets matter; extracting the whole APK is unnecessary.
  try {
    execFileSync('unzip', ['-q', '-o', file, 'assets/www/*', '-d', dir], { stdio: 'pipe' });
  } catch {
    die('unzip failed — is that an APK? (on a .xapk or .apkm, extract it first)');
  }

  let best = null;
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) {
        walk(p);
        continue;
      }
      if (!/\.js$/.test(name) || statSync(p).size > 4e6) continue;
      const src = readFileSync(p, 'utf8');
      // The bundles assign one client per platform inside a ternary chain:
      //   platform.is("ios") ? (this.clientId="…",this.clientSecret="…")
      //   : platform.is("android") ? (this.clientId="…",this.clientSecret="…")
      const platforms = {};
      const chain =
        /platform\.is\("([a-z]+)"\)[\s\S]{0,80}?this\.clientId\s*=\s*"([0-9a-f]{24,40})"[\s\S]{0,40}?this\.clientSecret\s*=\s*"([0-9a-f]{24,40})"/g;
      for (const m of src.matchAll(chain)) platforms[m[1]] = { client_id: m[2], client_secret: m[3] };
      const flat = src.match(/this\.clientId\s*=\s*"([0-9a-f]{24,40})"[\s\S]{0,40}?this\.clientSecret\s*=\s*"([0-9a-f]{24,40})"/);
      if (flat && !platforms.unknown) {
        platforms.unknown ??= { client_id: flat[1], client_secret: flat[2] };
      }
      const version = src.match(/this\.appVersion\s*=\s*"([0-9.]+)"/)?.[1] ?? null;
      if (Object.keys(platforms).length && (!best || Object.keys(platforms).length > Object.keys(best.platforms).length)) {
        best = { file: name, app_version: version, platforms };
      }
    }
  };
  walk(dir);

  if (!best) {
    die(
      'no client credentials found in assets/www.\n' +
        'If this build is React Native rather than Cordova, the bundle is assets/index.android.bundle —\n' +
        'search it for client_id instead. See README.md.',
    );
  }
  const wanted = ['android', 'ios', 'unknown'].filter((k) => best.platforms[k]);
  const out = {
    ...best,
    suggested_platform: wanted.includes('android') ? 'android' : wanted[0],
    suggested: best.platforms[wanted.includes('android') ? 'android' : wanted[0]],
  };
  console.log(JSON.stringify(out, null, 2));
  console.log(
    `\nUse the ${out.suggested_platform} pair. Write it to ~/.config/untappd-rebalance/app-client.json (0600):\n` +
      JSON.stringify({ ...out.suggested, app_version: best.app_version ?? '3.5.3' }, null, 2) +
      '\n\nThese are the *app\'s* credentials, not yours; your password is only used to obtain a token.',
  );
}

// ---------------------------------------------------------------- dispatch

// Compare realpaths: Node resolves a symlink for import.meta.url but leaves argv[1] alone,
// so a plain compare turns every command into a silent no-op when the script is symlinked.
const isEntry = (() => {
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();

if (isEntry) {
  if (command === 'login') await login();
  else if (command === 'fetch') await fetchAll();
  else if (command === 'propose') propose();
  else if (command === 'apply' || command === 'reverse') await write();
  else if (command === 'apk') apkCreds(positional(['repo'])[0]);
  else usage();
}
