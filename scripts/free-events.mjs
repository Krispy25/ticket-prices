// Pulls every upcoming US event from two free APIs and writes one file per state
// into data/free/, so the site can offer any state and city without spending credits.
//
//   Ticketmaster Discovery API  free key, 5,000 calls/day. Gives face-value price ranges.
//   SeatGeek Platform API       free client_id. Gives lowest / median / highest listed price.
//
// Neither API returns individual seats; for that, use scripts/capture.mjs (Tickets.dev).
//
// Env:
//   TM_API_KEY          Ticketmaster consumer key (optional, but at least one source is needed)
//   SEATGEEK_CLIENT_ID  SeatGeek client id (optional)
//   DAYS                How far ahead to look (default 60)
//   STATES              Comma list to limit the run, e.g. "TN,NV" (default: all 50 + DC)

import { writeFile, mkdir } from "node:fs/promises";

const TM_KEY = (process.env.TM_API_KEY || "").trim();
const SG_ID = (process.env.SEATGEEK_CLIENT_ID || "").trim();
const DAYS = Math.max(1, Number(process.env.DAYS || 60));
const ALL_STATES = "AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY".split(" ");
const STATES = (process.env.STATES || "").trim() ? process.env.STATES.split(",").map((s) => s.trim().toUpperCase()) : ALL_STATES;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

let tmCalls = 0, sgCalls = 0;

async function getJson(url, label, attempt = 1) {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (res.status === 429 && attempt < 4) {
    const wait = Number(res.headers.get("retry-after")) || 5 * attempt;
    console.warn(`  ${label}: rate limited, waiting ${wait}s`);
    await sleep(wait * 1000);
    return getJson(url, label, attempt + 1);
  }
  if (!res.ok) throw new Error(`${label} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// ---------- Ticketmaster ----------
// Deep paging stops at 1,000 results per query, so busy windows are split in half until they fit.
async function tmWindow(state, from, to, out, depth = 0) {
  const base = new URL("https://app.ticketmaster.com/discovery/v2/events.json");
  Object.entries({
    apikey: TM_KEY, countryCode: "US", stateCode: state, size: "200", sort: "date,asc", locale: "*",
    startDateTime: iso(from), endDateTime: iso(to),
  }).forEach(([k, v]) => base.searchParams.set(k, v));

  for (let page = 0; page < 5; page++) {
    base.searchParams.set("page", String(page));
    await sleep(260); // stay under 5 requests/second
    tmCalls++;
    const j = await getJson(base, `Ticketmaster ${state}`);
    const total = j.page?.totalElements ?? 0;
    if (page === 0 && total > 1000 && to - from > 864e5 && depth < 8) {
      const mid = new Date(from.getTime() + (to - from) / 2);
      await tmWindow(state, from, mid, out, depth + 1);
      await tmWindow(state, mid, to, out, depth + 1);
      return;
    }
    out.push(...(j._embedded?.events || []));
    if (page + 1 >= (j.page?.totalPages ?? 0)) break;
  }
}

const JUNK = /\b(parking|parking pass|lot [a-z0-9]+|shuttle|tailgate|locker|upgrade|add-on|gift card|merch)\b/i;

function fromTm(e) {
  const v = e._embedded?.venues?.[0] || {};
  const status = e.dates?.status?.code || "";
  if (status === "cancelled" || JUNK.test(e.name)) return null;
  const pr = (e.priceRanges || []).filter((p) => p.min > 0 || p.max > 0);
  return {
    name: e.name,
    date: e.dates?.start?.localDate || "",
    time: (e.dates?.start?.localTime || "").slice(0, 5),
    venue: v.name || "",
    city: v.city?.name || "",
    state: v.state?.stateCode || "",
    category: tmCategory(e.classifications?.[0]?.segment?.name),
    tm: {
      u: e.url,
      mn: pr.length ? Math.min(...pr.map((p) => p.min || p.max)) : null,
      mx: pr.length ? Math.max(...pr.map((p) => p.max || p.min)) : null,
      st: status && status !== "onsale" ? status : undefined,
    },
  };
}
function tmCategory(seg) {
  return { Music: "Concerts", Sports: "Sports", "Arts & Theatre": "Theater & comedy" }[seg] || "Other";
}

// ---------- SeatGeek ----------
async function sgState(state, from, to) {
  const out = [];
  const base = new URL("https://api.seatgeek.com/2/events");
  Object.entries({
    client_id: SG_ID, "venue.state": state, per_page: "500", sort: "datetime_utc.asc",
    "datetime_utc.gte": iso(from).slice(0, 19), "datetime_utc.lte": iso(to).slice(0, 19),
  }).forEach(([k, v]) => base.searchParams.set(k, v));
  for (let page = 1; page <= 40; page++) {
    base.searchParams.set("page", String(page));
    await sleep(150);
    sgCalls++;
    const j = await getJson(base, `SeatGeek ${state}`);
    out.push(...(j.events || []));
    if ((j.events || []).length < 500 || out.length >= (j.meta?.total ?? 0)) break;
  }
  return out;
}

const SPORTS = /nba|nfl|mlb|nhl|mls|wnba|ncaa|league|sports|soccer|football|baseball|basketball|hockey|wrestling|boxing|mma|ufc|racing|nascar|golf|tennis|rodeo|motocross|monster|horse|lacrosse|volleyball|softball/;
function sgCategory(e) {
  const t = `${e.type} ${(e.taxonomies || []).map((x) => x.name).join(" ")}`.toLowerCase();
  if (/concert|music_festival/.test(t)) return "Concerts";
  if (/theater|broadway|comedy|classical|opera|dance|cirque|magic/.test(t)) return "Theater & comedy";
  if (SPORTS.test(t)) return "Sports";
  return "Other";
}

function fromSg(e) {
  const v = e.venue || {};
  const s = e.stats || {};
  const dt = String(e.datetime_local || "");
  return {
    name: e.title || e.short_title,
    date: dt.slice(0, 10),
    time: e.datetime_tbd || e.time_tbd ? "" : dt.slice(11, 16),
    venue: v.name || "",
    city: v.city || "",
    state: v.state || "",
    category: sgCategory(e),
    sg: {
      u: e.url,
      lo: s.lowest_price || null,
      md: s.median_price || null,
      hi: s.highest_price || null,
      lc: s.listing_count || s.visible_listing_count || 0,
    },
  };
}

// ---------- Matching the same event across both sources ----------
const STOP = new Set("the at a an of and in on vs v presents with live tour tickets arena stadium center centre theatre theater hall amphitheatre amphitheater park field club ballroom auditorium music".split(" "));
const tokens = (s) => new Set(String(s).toLowerCase().normalize("NFKD").replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w)));
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n / (a.size + b.size - n);
}
const minutes = (t) => (t ? Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)) : null);

function merge(tmList, sgList) {
  const key = (e) => `${e.date}|${e.city.toLowerCase()}`;
  const buckets = new Map();
  for (const e of sgList) {
    if (!buckets.has(key(e))) buckets.set(key(e), []);
    buckets.get(key(e)).push({ e, used: false, vt: tokens(e.venue), nt: tokens(e.name) });
  }
  const out = [];
  for (const t of tmList) {
    const cands = buckets.get(key(t)) || [];
    const vt = tokens(t.venue), nt = tokens(t.name);
    let best = null, bestScore = 0;
    for (const c of cands) {
      if (c.used) continue;
      const a = minutes(t.time), b = minutes(c.e.time);
      if (a != null && b != null && Math.abs(a - b) > 180) continue;
      const score = jaccard(vt, c.vt) * 0.6 + jaccard(nt, c.nt) * 0.4;
      if (score > bestScore) { best = c; bestScore = score; }
    }
    if (best && bestScore >= 0.3) {
      best.used = true;
      out.push({ ...t, sg: best.e.sg, category: t.category === "Other" ? best.e.category : t.category });
    } else out.push(t);
  }
  for (const list of buckets.values()) for (const c of list) if (!c.used) out.push(c.e);
  return out;
}

function dedupe(list) {
  // Ticketmaster sometimes lists the same show twice (e.g. different ticket products).
  const seen = new Map();
  for (const e of list) {
    const k = `${e.date}|${e.time}|${e.venue.toLowerCase()}|${e.name.toLowerCase()}`;
    const prev = seen.get(k);
    if (!prev || (!prev.tm?.mn && e.tm?.mn)) seen.set(k, e);
  }
  return [...seen.values()];
}

// Compact keys keep the per-state files small.
const pack = (e) => ({
  n: e.name, d: e.date, t: e.time || undefined, v: e.venue, c: e.city, k: e.category,
  tm: e.tm && (e.tm.u ? { u: e.tm.u, mn: e.tm.mn ?? undefined, mx: e.tm.mx ?? undefined, st: e.tm.st } : undefined),
  sg: e.sg && { u: e.sg.u, lo: e.sg.lo ?? undefined, md: e.sg.md ?? undefined, hi: e.sg.hi ?? undefined, lc: e.sg.lc || undefined },
});

export { merge, fromTm, fromSg, pack, dedupe };

async function main() {
  if (!TM_KEY && !SG_ID) {
    console.log("No TM_API_KEY or SEATGEEK_CLIENT_ID set: skipping the free event listings.");
    return;
  }
  console.log(`Sources: ${[TM_KEY && "Ticketmaster", SG_ID && "SeatGeek"].filter(Boolean).join(" + ")}; next ${DAYS} days; ${STATES.length} state(s)`);
  const from = new Date(); from.setUTCMinutes(0, 0, 0);
  const to = new Date(from.getTime() + DAYS * 864e5);
  await mkdir("data/free", { recursive: true });

  const summary = { updatedAt: new Date().toISOString(), days: DAYS, sources: { ticketmaster: !!TM_KEY, seatgeek: !!SG_ID }, states: {} };
  for (const st of STATES) {
    let tm = [], sg = [];
    try { if (TM_KEY) { const raw = []; await tmWindow(st, from, to, raw); tm = raw.map(fromTm).filter(Boolean); } }
    catch (e) { console.error(`  ${st} Ticketmaster failed: ${e.message}`); }
    try { if (SG_ID) sg = (await sgState(st, from, to)).map(fromSg).filter((e) => e.date); }
    catch (e) { console.error(`  ${st} SeatGeek failed: ${e.message}`); }

    const events = dedupe(merge(tm, sg))
      .filter((e) => e.city && (e.state || st) === st)
      .sort((a, b) => (a.date + (a.time || "")).localeCompare(b.date + (b.time || "")));
    if (!events.length) { console.log(`${st}: no events`); continue; }

    const cities = {};
    for (const e of events) cities[e.city] = (cities[e.city] || 0) + 1;
    summary.states[st] = { events: events.length, cities };
    await writeFile(`data/free/${st}.json`, JSON.stringify({ updatedAt: summary.updatedAt, events: events.map(pack) }));
    const both = events.filter((e) => e.tm && e.sg).length;
    console.log(`${st}: ${events.length} events in ${Object.keys(cities).length} cities (TM ${tm.length}, SG ${sg.length}, matched ${both})`);
  }
  await writeFile("data/free/states.json", JSON.stringify(summary));
  console.log(`Done. Ticketmaster calls: ${tmCalls}, SeatGeek calls: ${sgCalls}.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
