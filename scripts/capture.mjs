// Finds events in a city/state through the Tickets.dev catalog, then captures every
// listing on each of six marketplaces and writes the results into data/ for the
// static site. Runs in GitHub Actions so the API key never reaches the browser.
//
// Env (all optional unless noted):
//   TICKETS_DEV_KEY   API key. Falls back to the free sandbox key (sample data only).
//   CITY, STATE       Where to look, e.g. "Nashville" and "TN" (or "Tennessee").
//   QUERY             Narrow the search: performer, team, venue or event name.
//   EVENT             One event instead: a marketplace event URL, a Tickets.dev event ID, or a name.
//   FROM, TO          Date window (YYYY-MM-DD). FROM defaults to today.
//   MAX_EVENTS        Cap on events captured per run (default 3).
//   MARKETPLACES      Comma list (default: all six below).
//   DRY_RUN           "true" = list matching events and the credit cost, capture nothing.
//   REFRESH           "true" = re-capture every event already on the site.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";

const BASE = "https://api.tickets.dev/v1";
const ALL_MARKETS = ["seatgeek", "stubhub", "tickpick", "ticketmaster", "vividseats", "gametime"];

const env = (k, d = "") => (process.env[k] ?? "").trim() || d;
const KEY = env("TICKETS_DEV_KEY", "tk_test_sandbox");
const SANDBOX = KEY === "tk_test_sandbox";
const CITY = env("CITY");
const STATE = env("STATE");
const QUERY = env("QUERY");
const EVENT = env("EVENT");
const FROM = env("FROM", new Date().toISOString().slice(0, 10));
const TO = env("TO");
const MAX_EVENTS = Math.max(1, Number(env("MAX_EVENTS", "3")) || 3);
const DRY_RUN = env("DRY_RUN") === "true";
const REFRESH = env("REFRESH") === "true";
const MARKETS = env("MARKETPLACES", ALL_MARKETS.join(","))
  .split(",").map((s) => s.trim().toLowerCase()).filter((s) => ALL_MARKETS.includes(s));

const STATES = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut",
  DE: "Delaware", DC: "District of Columbia", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois",
  IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
  MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana",
  NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York",
  NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania",
  RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah",
  VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
};
const stateCode = (s) => {
  const v = String(s || "").trim();
  if (!v) return "";
  if (STATES[v.toUpperCase()]) return v.toUpperCase();
  const hit = Object.entries(STATES).find(([, name]) => name.toLowerCase() === v.toLowerCase());
  return hit ? hit[0] : v;
};
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

async function api(path, params = {}, attempt = 1) {
  const u = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) if (v !== "" && v != null) u.searchParams.set(k, v);
  const res = await fetch(u, { headers: { "x-api-key": KEY } });
  const body = await res.json().catch(() => ({}));
  if (res.ok) return body;
  const err = body.error || {};
  if ((res.status === 429 || err.retryable) && attempt < 4) {
    const wait = Number(res.headers.get("retry-after")) || 5 * attempt;
    console.warn(`    ${res.status} ${err.code || ""}, retrying in ${wait}s`);
    await new Promise((r) => setTimeout(r, wait * 1000));
    return api(path, params, attempt + 1);
  }
  const e = new Error(`${res.status} ${err.code || ""} ${err.message || ""}`.trim());
  e.status = res.status;
  throw e;
}

async function readJson(path, fallback) {
  return existsSync(path) ? JSON.parse(await readFile(path, "utf8")) : fallback;
}

// ---------- Event discovery ----------
function inPlace(ev) {
  const v = ev.venue || {};
  if (CITY && norm(v.city) !== norm(CITY)) return false;
  if (STATE && stateCode(v.state) !== stateCode(STATE)) return false;
  return true;
}

async function searchPages(params, maxPages) {
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    const res = await api("/events", { ...params, page: String(page), pageSize: "100" });
    out.push(...(res.events || []));
    if (!res.hasMore) break;
  }
  return out;
}

async function discover() {
  if (EVENT) {
    const params = /^[0-9A-HJKMNP-TV-Z]{26}$/.test(EVENT) ? { eventId: EVENT } : { query: EVENT };
    const res = await api("/events", params);
    return (res.events || []).slice(0, 1);
  }
  if (!CITY && !STATE && !QUERY) throw new Error("Give a CITY and STATE, a QUERY, or an EVENT.");
  const window = { from: FROM, to: TO };
  const seen = new Map();
  const add = (list) => list.filter(inPlace).forEach((e) => seen.set(e.id, e));

  // The catalog search matches event, performer and venue names; try the most specific text first.
  const queries = [QUERY, !QUERY && CITY, !QUERY && STATES[stateCode(STATE)]].filter(Boolean);
  for (const q of queries) {
    add(await searchPages({ ...window, query: q }, 5));
    if (seen.size >= MAX_EVENTS * 3) break;
  }
  // Fall back to scanning the date window and filtering by venue location.
  if (!seen.size && !QUERY) add(await searchPages(window, 20));

  return [...seen.values()]
    .filter((e) => (e.sources || []).some((s) => MARKETS.includes(s.marketplace)))
    .sort((a, b) => String(a.eventDateUtc).localeCompare(String(b.eventDateUtc)))
    .slice(0, MAX_EVENTS);
}

// ---------- Capture ----------
async function captureEvent(ev) {
  const sources = (ev.sources || []).filter((s) => MARKETS.includes(s.marketplace));
  const captures = {}, errors = {};
  for (const s of sources) {
    process.stdout.write(`    ${s.marketplace.padEnd(13)}`);
    try {
      const snap = await api(`/capture/${s.marketplace}`, { url: s.url });
      captures[s.marketplace] = snap;
      console.log(`${String(snap.listings?.length ?? 0).padStart(4)} listings, from $${snap.stats?.getInPrice ?? "?"}`);
    } catch (e) {
      errors[s.marketplace] = e.message;
      console.log(`failed: ${e.message}`);
      if (e.status === 401 || e.status === 402) throw e; // bad key or out of credits: stop the run
    }
  }
  return { captures, errors };
}

function summarize(ev, captures) {
  const markets = Object.entries(captures).map(([m, s]) => ({
    marketplace: m,
    url: s.sourceUrl,
    listingCount: s.listings?.length ?? 0,
    getInPrice: s.stats?.getInPrice || null,
  }));
  const prices = markets.map((m) => m.getInPrice).filter(Boolean);
  return {
    id: ev.id,
    name: ev.name,
    date: ev.eventDateLocal,
    dateUtc: ev.eventDateUtc,
    venue: ev.venue?.name || "",
    city: ev.venue?.city || "",
    state: stateCode(ev.venue?.state),
    markets,
    listingCount: markets.reduce((a, m) => a + m.listingCount, 0),
    getInPrice: prices.length ? Math.min(...prices) : null,
    capturedAt: new Date().toISOString(),
    sandbox: SANDBOX,
  };
}

async function main() {
  console.log(`Key: ${SANDBOX ? "sandbox (sample data, free)" : "live"}`);
  console.log(`Marketplaces: ${MARKETS.join(", ")}`);
  const index = await readJson("data/index.json", { events: [] });

  let events;
  if (REFRESH) {
    events = [];
    for (const e of index.events) {
      const res = await api("/events", { eventId: e.id }).catch(() => ({ events: [] }));
      if (res.events?.[0]) events.push(res.events[0]);
    }
    console.log(`Refreshing ${events.length} event(s) already on the site.`);
  } else {
    const where = [QUERY && `"${QUERY}"`, CITY, STATE].filter(Boolean).join(", ");
    console.log(`Searching ${EVENT ? `for "${EVENT}"` : where} from ${FROM}${TO ? ` to ${TO}` : ""}`);
    events = await discover();
  }
  if (!events.length) {
    console.error("No matching events found. Check the city and state spelling, widen the dates, or drop the query.");
    process.exit(1);
  }

  const cost = events.reduce((n, e) => n + (e.sources || []).filter((s) => MARKETS.includes(s.marketplace)).length, 0);
  console.log(`\n${events.length} event(s), ${cost} capture(s)${SANDBOX ? " (free in sandbox)" : ` = ${cost} credit(s)`}:`);
  for (const e of events) {
    const m = (e.sources || []).map((s) => s.marketplace).filter((s) => MARKETS.includes(s));
    console.log(`  ${e.eventDateLocal?.slice(0, 10)}  ${e.name} @ ${e.venue?.name}, ${e.venue?.city} ${e.venue?.state}  [${m.join(", ")}]`);
  }
  if (DRY_RUN) return console.log("\nDry run: nothing captured.");

  await mkdir("data/events", { recursive: true });
  let ok = 0;
  for (const ev of events) {
    console.log(`\n→ ${ev.name}`);
    const { captures, errors } = await captureEvent(ev);
    if (!Object.keys(captures).length) continue;
    ok++;
    await writeFile(`data/events/${ev.id}.json`, JSON.stringify({ event: ev, captures, errors, capturedAt: new Date().toISOString(), sandbox: SANDBOX }, null, 1));
    index.events = index.events.filter((e) => e.id !== ev.id);
    index.events.push(summarize(ev, captures));
  }

  // Drop events that have already happened.
  const cutoff = Date.now() - 12 * 3600e3;
  index.events = index.events
    .filter((e) => !e.dateUtc || Date.parse(e.dateUtc) > cutoff)
    .sort((a, b) => String(a.dateUtc).localeCompare(String(b.dateUtc)));
  index.updatedAt = new Date().toISOString();
  await writeFile("data/index.json", JSON.stringify(index, null, 2) + "\n");
  console.log(`\nSaved ${ok} event(s). The site now lists ${index.events.length}.`);
  if (!ok) process.exit(1);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
