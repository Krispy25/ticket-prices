# Ticket Prices

Pick a city and state, pick an event, and see the best seat for the money across
**SeatGeek, StubHub, TickPick, Ticketmaster, Vivid Seats and Gametime**. Listings
come from the [Tickets.dev](https://tickets.dev) capture API.

**Live site:** https://krispy25.github.io/ticket-prices/

## What the page shows

- **City and state picker**, then the events captured there.
- **Best seat for the money** across all six marketplaces, with the reasons it won,
  next to the cheapest way in and the best seat available.
- **Lowest price on each marketplace** for the number of tickets you need.
- **Seat quality vs. price** chart. The orange line is the best-value frontier: no
  listing on it has another listing that is both better and cheaper.
- Filters for tickets needed (respects each listing's sellable quantities),
  max price, marketplaces, seating level, limited views and accessible seating.
- A sortable table of every listing. When the same section and row is listed
  cheaper on another marketplace, the table says where.

## How the value score works

1. **Seat quality (0–100)** from the seating level (floor/pit, lower 100s, club/200s,
   upper 300s–400s, plus keywords like "orchestra", "main level" or "balcony"),
   minus up to 16 points for distance from the front row, minus 20 for limited or
   obstructed views, plus a little for front rows and aisles.
2. **Value score** ranks each listing against every other listing for the event:
   55% seat quality, 45% low price (`totalPrice`: per ticket, fees included, before tax).

Marketplace deal scores use different scales (SeatGeek 1–10, StubHub decimals,
others none), so they aren't mixed into the score. Tweak `W` and `levelOf()` in
`index.html` to change the model.

## Adding a city

The API key never reaches the browser. A GitHub Action searches the Tickets.dev
catalog, captures each event on all six marketplaces, and commits the results to
`data/`. GitHub Pages serves the page.

1. Add your key as a repository secret named `TICKETS_DEV_KEY`
   (Settings → Secrets and variables → Actions). Without it the workflow uses the
   free sandbox key, which always returns the same sample event.
2. Actions → **Capture ticket prices** → Run workflow. Enter a city and state.
   Add a performer, team or venue in *query* to narrow it, or paste one event's URL
   in *event*.
3. Tick **dry run** first to see which events match and what it will cost.
   Each event on six marketplaces costs up to 6 credits.
4. Reload the site a minute or two after the run finishes.

Tick **refresh** to update prices for everything already on the site. Events that
have happened drop off automatically.

### Run locally

```bash
TICKETS_DEV_KEY=tk_live_... CITY=Nashville STATE=TN DRY_RUN=true node scripts/capture.mjs
python3 -m http.server 8000   # then open http://localhost:8000
```

Prices change quickly. Confirm the listing on the marketplace before buying.
