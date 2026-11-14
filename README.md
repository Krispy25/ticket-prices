# Ticket Prices

Pick any state and city, browse every upcoming event there, and compare prices.
For events you capture seat by seat, see the best seat for the money across
**SeatGeek, StubHub, TickPick, Ticketmaster, Vivid Seats and Gametime**.

**Live site:** https://krispy25.github.io/ticket-prices/

## Two kinds of data

| | Free event listings | Seat-by-seat comparison |
|---|---|---|
| Source | Ticketmaster Discovery API + SeatGeek Platform API | [Tickets.dev](https://tickets.dev) capture API |
| Cost | Free | One credit per event per marketplace (paid plans) |
| Coverage | Every US event in the next 60 days, refreshed twice a day | Events you choose |
| Prices | Ticketmaster face-value range (before fees); SeatGeek lowest and median listed price | Every listing: section, row, all-in price, from six marketplaces |
| Secrets | `TM_API_KEY`, `SEATGEEK_CLIENT_ID` | `TICKETS_DEV_KEY` |

Add secrets under Settings → Secrets and variables → Actions. API keys never reach the browser:
GitHub Actions calls the APIs and publishes the results with the site.

## Setting up the free listings

1. **Ticketmaster:** create an app at https://developer.ticketmaster.com and copy the
   Consumer Key. Save it as the secret `TM_API_KEY`. (Free: 5,000 calls/day; a full refresh uses a few hundred.)
2. **SeatGeek:** register an app at https://seatgeek.com/account/develop and copy the
   Client ID. Save it as `SEATGEEK_CLIENT_ID`.
3. Actions → **Build and deploy site** → Run workflow. After that it runs on its own twice a day
   and after every push.

Either key works on its own; with both, events listed on both sites are matched up
so you can compare them side by side.

## Adding a city

Every city with upcoming events shows up automatically once the free keys are in.
To get the seat-by-seat comparison for specific events:

1. Save your Tickets.dev key as `TICKETS_DEV_KEY`.
2. Actions → **Capture ticket prices** → Run workflow. Enter a city and state, and optionally a
   performer, team or venue (for example *Nissan Stadium*), or paste one event's URL.
3. Tick **dry run** first to see which events match and what it will cost.
   Each event on six marketplaces costs up to 6 credits.

Captured events get a **Best seats** button in the city list.

## How the seat value score works

1. **Seat quality (0–100)** from the seating level (floor/pit, lower 100s, club/200s,
   upper 300s–400s, plus keywords like "orchestra", "main level" or "balcony"),
   minus up to 16 points for distance from the front row, minus 20 for limited or
   obstructed views, plus a little for front rows and aisles.
2. **Value score** ranks each listing against every other listing for the event:
   55% seat quality, 45% low price (per ticket, fees included, before tax).

Tweak `W` and `levelOf()` in `index.html` to change the model.

## Run locally

```bash
TM_API_KEY=... SEATGEEK_CLIENT_ID=... STATES=TN node scripts/free-events.mjs
TICKETS_DEV_KEY=tk_live_... CITY=Nashville STATE=TN DRY_RUN=true node scripts/capture.mjs
python3 -m http.server 8000   # then open http://localhost:8000
```

Prices change quickly. Confirm on the marketplace before buying.
