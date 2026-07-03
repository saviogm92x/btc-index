#!/usr/bin/env node
/* geo-feed.js — refresh the dashboard's geopolitical overlay.
 *
 * Pulls a few RSS feeds (no key needed), asks Claude to distill the current
 * geopolitical/macro backdrop for Bitcoin, and writes geo.json in the exact
 * shape renderGeo() expects. Place geo.json next to the dashboard HTML on
 * whatever host serves it; the page fetches it same-origin on each refresh.
 *
 * Run once (cron-friendly):   ANTHROPIC_API_KEY=sk-ant-... node geo-feed.js
 * Long-running loop:          WATCH_MS=3600000 ANTHROPIC_API_KEY=... node geo-feed.js
 *
 * Env:
 *   ANTHROPIC_API_KEY   required — your Anthropic key (stays server-side)
 *   GEO_OUT             output path for geo.json (default ./geo.json)
 *   GEO_MODEL           model (default claude-haiku-4-5-20251001 — cheap & fast)
 *   WATCH_MS            if set, re-run on this interval instead of exiting
 *
 * Node 18+. No dependencies.
 */

const fs = require('fs');
const path = require('path');

// Edit this list freely. Feeds are read newest-first; dead feeds are skipped.
const FEEDS = [
  ['BBC World',     'http://feeds.bbci.co.uk/news/world/rss.xml'],
  ['Al Jazeera',    'https://www.aljazeera.com/xml/rss/all.xml'],
  ['CoinDesk',      'https://www.coindesk.com/arc/outboundfeeds/rss/'],
  ['Cointelegraph', 'https://cointelegraph.com/rss'],
];
const PER_FEED = 8;          // headlines taken per feed (newest first)
const TOTAL_CAP = 28;        // overall cap sent to the model
const OUT = process.env.GEO_OUT || path.join(process.cwd(), 'geo.json');
const MODEL = process.env.GEO_MODEL || 'claude-haiku-4-5-20251001';
const WATCH_MS = Number(process.env.WATCH_MS) || 0;

const RISK = ['low', 'medium', 'high', 'severe'];
const LEAN = ['bullish', 'bearish', 'neutral', 'mixed'];

const strip = s => s
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/<[^>]+>/g, '')
  .replace(/&amp;/g, '&').replace(/&#0?39;|&apos;/g, "'")
  .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/\s+/g, ' ').trim();

function parseFeed(xml, source) {
  const blocks = xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) || [];
  const pick = (b, tag) => {
    const m = b.match(new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)<\\/' + tag + '>', 'i'));
    return m ? strip(m[1]) : '';
  };
  return blocks.map(b => ({ source, title: pick(b, 'title'), desc: pick(b, 'description') || pick(b, 'summary') }))
    .filter(x => x.title);
}

async function fetchFeeds() {
  const results = await Promise.allSettled(FEEDS.map(async ([name, url]) => {
    const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 12000);
    try {
      const r = await fetch(url, { signal: ac.signal, headers: { 'User-Agent': 'btc-geo/1.0' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return parseFeed(await r.text(), name).slice(0, PER_FEED);
    } finally { clearTimeout(t); }
  }));
  const items = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') items.push(...r.value);
    else console.error(`[geo] feed failed: ${FEEDS[i][0]} (${r.reason.message})`);
  });
  return items.slice(0, TOTAL_CAP);
}

const SYSTEM = `You are a geopolitical and macro risk analyst for a Bitcoin market dashboard. You read recent world-news and crypto headlines and distill the current backdrop as it bears on Bitcoin.

Output ONLY a single JSON object — no markdown, no code fences, no commentary — with exactly these fields:
- "risk_level": one of "low","medium","high","severe" — overall geopolitical/macro risk in the world right now.
- "crypto_lean": one of "bullish","bearish","neutral","mixed" — net directional pressure these events imply for Bitcoin over the coming weeks. Risk-off shocks and regulatory crackdowns lean bearish; monetary easing, institutional adoption, safe-haven demand and currency debasement lean bullish; conflicting signals are "mixed".
- "headline": one or two plain-language sentences summarizing the backdrop, grounded in the supplied headlines.
- "drivers": an array of 3 to 5 short strings, each a specific current factor and its relevance to BTC (e.g. "Middle East escalation lifts safe-haven demand", "Fresh US spot-ETF outflows pressure price"). Keep each under ~12 words.
- "as_of": today's date as YYYY-MM-DD.

Ground everything strictly in the supplied headlines. Do NOT invent events that are not present. If the headlines are sparse or conflicting, prefer "medium" risk and "neutral" or "mixed" lean. Be sober and factual, not hyperbolic.`;

async function curate(items) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');
  const today = new Date().toISOString().slice(0, 10);
  const list = items.map((it, i) => `${i + 1}. [${it.source}] ${it.title}${it.desc ? ' — ' + it.desc.slice(0, 160) : ''}`).join('\n');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 700,
      system: SYSTEM,
      messages: [{ role: 'user', content: `Today is ${today}. Recent headlines:\n\n${list}\n\nReturn the JSON object now.` }],
    }),
  });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
  const text = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
  const m = text.match(/\{[\s\S]*\}/);          // tolerate stray prose/fences
  if (!m) throw new Error('model did not return JSON: ' + text.slice(0, 120));
  const g = JSON.parse(m[0]);

  // validate + coerce to the renderGeo schema
  if (!RISK.includes(g.risk_level)) g.risk_level = 'medium';
  if (!LEAN.includes(g.crypto_lean)) g.crypto_lean = 'neutral';
  g.headline = String(g.headline || '').trim();
  g.drivers = Array.isArray(g.drivers) ? g.drivers.map(d => String(d).trim()).filter(Boolean).slice(0, 5) : [];
  g.as_of = String(g.as_of || today).slice(0, 10);
  if (!g.headline || !g.drivers.length) throw new Error('curated object missing headline/drivers');
  return g;
}

async function once() {
  const items = await fetchFeeds();
  if (!items.length) throw new Error('no headlines fetched from any feed');
  const geo = await curate(items);
  const tmp = OUT + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(geo, null, 2));
  fs.renameSync(tmp, OUT);                        // atomic — page never reads a half-written file
  console.log(`[geo] ${new Date().toISOString()} wrote ${OUT} — risk ${geo.risk_level}, lean ${geo.crypto_lean}, ${geo.drivers.length} drivers`);
}

if (require.main === module) {
  if (WATCH_MS) {
    const run = () => once().catch(e => console.error('[geo] update failed:', e.message));
    run();
    setInterval(run, WATCH_MS);
  } else {
    once().catch(e => { console.error('[geo] update failed:', e.message); process.exit(1); });
  }
}

module.exports = { fetchFeeds, curate, once };
                                 
