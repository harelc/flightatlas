# Schedule data sources — trial findings (checked 2026-11-17)

## OAG

- **Free tier exists, no credit card:** sign up at https://developers.oag.com/,
  generate an API key, subscribe to the **Schedules API** in the Developer Portal.
  Published free limits reset every 30 days (e.g. Flight Info: 1,000 calls/month,
  10 results per call). A separate 14-day evaluation license exists for Flight Info.
- **Critical limit:** OAG's evaluation terms allow internal evaluation/testing only
  and prohibit copying data into a secondary database, distributing it, or creating
  derivative products from it. So the free tier is for validating response shape and
  spot-checking a handful of airports — **not** for populating this atlas.
- The product an atlas actually needs is OAG's bulk schedules feed
  (flights/week, seats, equipment, effective dates) under a commercial license.
  Pricing is quote-only.

## Cirium

- **30-day free Evaluation plan** on signup at https://developer.cirium.com/:
  20,000 total requests, with caps — Scheduled Flights by Airport 1,000 requests,
  Connections API 500 requests.
- Post-trial: pay-as-you-go covers Schedules *by flight*; Schedules *by airport/route*
  (what bulk atlas ingestion wants) require a **contract plan**, quote-only pricing.
- Same caution as OAG: evaluation data is for evaluation, not redistribution.

## Recommended trial plan (no license risk)

1. Create OAG free-tier + Cirium evaluation accounts (use your own credentials;
   never paste API keys into chat — keep them in a local `.env` outside git).
2. Pick 5 reference airports (e.g. LHR, JFK, TLV, DXB, HND) and pull one week of
   schedules from each. ~10-25 API calls total, far inside trial caps.
3. Compare against the OpenFlights snapshot: routes gained/lost since ~2014,
   flights/week distribution, equipment mix. This sizes the real-data delta.
4. Use the trial responses to finalize the production schema
   (`flights_per_week`, `seats_per_week`, `effective_from/to`, `operating_carrier`)
   and to get an informed quote for the bulk feed.

## Newer APIs — trial terms (checked 2026-11-17)

- **Cirium Sky API** (current generation, `api.sky.cirium.com`, replaces the older
  FlightStats Flex APIs): **14-day free trial, max 1,000 queries per API**,
  and crucially the trial *includes* Schedules by Airport and by Route — the exact
  endpoints an atlas needs. After the trial, Schedules by Flight moves to
  pay-as-you-go, but **by Airport/Route revert to contract-only**. Note the
  by-airport endpoints are per date *and hour*, so one airport-day can cost up to
  ~24-48 queries; 1,000 queries ≈ a few dozen airport-days of sampling.
  The older Flex evaluation (30 days / 20,000 requests) still exists but is the
  legacy platform.
- **OAG Developer Portal** (current Flight Info / Schedules / Connections APIs):
  free tier, no credit card, limits reset every 30 days — published as 1,000
  calls/month for Flight Info and Connections, 100/month for Master Data. The
  **Schedules API free quota is not published**; you only see it in the portal
  after subscribing. A separate 14-day evaluation licence covers fuller access.

## Not viable for this product

- Per-airport API crawling of all ~1,300 airports × many dates: blows through
  trial/commercial caps and, for bulk-compiled display, breaches redistribution
  terms on every cheap tier checked. Bulk feed license is the only clean path.
