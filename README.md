# FlightAtlas (prototype)

A rotating 3D globe showing nonstop flight destinations from major airports
worldwide. Pick an origin (code/city autocomplete, click a dot, or click a
destination in the list), then filter by direction, airline,
airlines-per-route, and distance. Arc width encodes route "volume".

Features: live day/night terminator + day/night earth views, four arc colour
modes, animated aircraft on the busiest routes, optional one-stop
reachability layer (violet dots; hover a row to trace origin → hub →
destination), and list↔globe hover highlighting.

Selecting a destination opens a **route detail card** (it no longer changes
the origin): nonstop status or best one-stop connections, distance, estimated
flight time and CO₂, airlines, aircraft types, the destination's Wikipedia
abstract + article link, a **"See live fares on KAYAK"** deep link (30 days
out, sorted by best flight), and an explicit "Explore from here" pivot
button. Double-clicking a row also pivots. Wikipedia links for 1,300 airports
come from OurAirports in `scripts/build_data.py`; abstracts load lazily in
the browser via Wikipedia's REST summary API (bulk-fetching them hits
HTTP 429). KAYAK's own Flights Search API is affiliate-gated — no self-serve
key — so the deep link is the no-approval integration; see
`docs/data-sources.md` for the OAG/Cirium trial findings and the path to
real frequency data.

## Run

```bash
pnpm install
pnpm data     # regenerate public/data/atlas.json (needs network, ~3s)
pnpm dev      # http://localhost:5173
```

## Data — read this before trusting the map

Prototype data is **OpenFlights** (`scripts/build_data.py`):

- 2,944 airports with at least one nonstop route, 33,637 directed nonstop
  routes, codeshare duplicates removed (operating carrier only). (An earlier
  ≥4-destination "major hubs" cutoff orphaned regional airports — e.g. RKV
  Reykjavík kept only 1 of its 5 routes — so inclusion is now ≥1 route.)
- OpenFlights route data is largely **circa 2014** and contains **no
  frequency or seat data**. Arc width therefore uses a proxy: the number of
  distinct operating airlines on the route. Do not present it as flight volume.

Production path: license **OAG or Cirium** schedules and replace the proxy
with flights/week and seats/week, aggregated by IATA season with effective
dates. See `scripts/build_data.py` header for the exact swap point.

Airport search data, globe textures (`three-globe` examples via unpkg), and
Google Fonts load from CDNs at runtime; the route data itself is a local
2.2 MB JSON snapshot.

## Next steps

1. OAG/Cirium feed → flights/week + seats/week, monthly refresh job.
2. Season switcher (summer/winter schedule) and "as of" date stamp.
3. Alliance filter, aircraft-type filter, passenger-volume layer (BTS /
   Eurocontrol) for US/EU validation.
4. Move the global view to pre-aggregated vector tiles if route count grows.
