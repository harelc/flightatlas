#!/usr/bin/env python3
"""
FlightAtlas prototype data pipeline.

Sources (prototype only -- see README for accuracy limits):
  - OpenFlights airports.dat / routes.dat / airlines.dat (routes largely ~2014)

Output: public/data/atlas.json
  - airports: major airports (ranked by distinct nonstop destinations)
  - routes:   directed, nonstop, operating-carrier-only (codeshares dropped),
              aggregated per origin->destination pair
  - "volume" here is a PROXY: number of distinct operating airlines on the
    pair. OpenFlights has no frequency/seat data. Replace with OAG/Cirium
    flights-per-week + seats-per-week for a production build.
"""
import csv
import io
import json
import math
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict
from pathlib import Path

BASE = "https://raw.githubusercontent.com/jpatokal/openflights/master/data"
OURAIRPORTS = "https://davidmegginson.github.io/ourairports-data/airports.csv"
HEADERS = {"User-Agent": "FlightAtlas/0.1 (educational prototype; local dev)"}
ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "public" / "data" / "atlas.json"
MIN_DESTINATIONS = 1          # include every airport with a nonstop route;
                              # a "major hubs only" cutoff orphaned regional
                              # airports (e.g. RKV kept only 1 of its 5 routes)
MAX_AIRPORTS = 5000


def fetch(name: str) -> list[list[str]]:
    with urllib.request.urlopen(f"{BASE}/{name}", timeout=60) as r:
        text = r.read().decode("utf-8", errors="replace")
    return [row for row in csv.reader(io.StringIO(text)) if row]


def fetch_text(url: str) -> str:
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read().decode("utf-8", errors="replace")


def fetch_wiki_links() -> dict[str, str]:
    """IATA -> Wikipedia URL, from OurAirports (community-maintained)."""
    links: dict[str, str] = {}
    for row in csv.DictReader(io.StringIO(fetch_text(OURAIRPORTS))):
        iata, link = (row.get("iata_code") or "").strip(), (row.get("wikipedia_link") or "").strip()
        if len(iata) == 3 and link and iata not in links:
            links[iata] = link
    return links


def fetch_abstracts(urls: dict[str, str]) -> dict[str, str]:
    """Wikipedia URL -> short plain-text abstract (intro extract), batched."""
    by_host: dict[str, list[tuple[str, str]]] = defaultdict(list)  # host -> [(title, url)]
    for url in urls.values():
        parsed = urllib.parse.urlparse(url)
        if "/wiki/" not in parsed.path:
            continue
        title = urllib.parse.unquote(parsed.path.split("/wiki/", 1)[1])
        host = parsed.netloc.replace(".m.wikipedia.org", ".wikipedia.org")
        by_host[host].append((title, url))

    abstracts: dict[str, str] = {}
    for host, items in by_host.items():
        for i in range(0, len(items), 20):
            batch = items[i:i + 20]
            params = urllib.parse.urlencode({
                "action": "query", "prop": "extracts", "exintro": "1",
                "explaintext": "1", "exlimit": "max", "redirects": "1",
                "format": "json", "formatversion": "2",
                "titles": "|".join(t for t, _ in batch),
            })
            data = None
            for attempt, wait in enumerate((0, 5, 15, 30)):
                if wait:
                    time.sleep(wait)
                try:
                    data = json.loads(fetch_text(f"https://{host}/w/api.php?{params}"))
                    break
                except urllib.error.HTTPError as exc:
                    if exc.code != 429 or attempt == 3:  # one bad batch must not kill the build
                        print(f"  wiki batch failed ({host} #{i}): {exc}")
                        break
                    print(f"  wiki 429 ({host} #{i}), backing off…")
                except Exception as exc:
                    print(f"  wiki batch failed ({host} #{i}): {exc}")
                    break
            if data is None:
                continue
            time.sleep(1.2)  # stay under Wikimedia rate limits
            query = data.get("query", {})
            # Resolve normalized/redirected titles back to the requested title.
            alias: dict[str, str] = {}
            for kind in ("normalized", "redirects"):
                for entry in query.get(kind, []):
                    alias[entry["from"]] = entry["to"]
            pages = {p["title"]: p.get("extract", "") for p in query.get("pages", [])}
            for title, url in batch:
                resolved = title.replace("_", " ")
                seen = set()
                while resolved in alias and resolved not in seen:
                    seen.add(resolved)
                    resolved = alias[resolved]
                text = " ".join(pages.get(resolved, "").split())
                if len(text) > 40:
                    if len(text) > 650:
                        text = text[:620].rsplit(" ", 1)[0] + "…"
                    abstracts[url] = text
    return abstracts


def haversine_km(lat1, lon1, lat2, lon2) -> int:
    p = math.pi / 180
    a = (0.5 - math.cos((lat2 - lat1) * p) / 2
         + math.cos(lat1 * p) * math.cos(lat2 * p) * (1 - math.cos((lon2 - lon1) * p)) / 2)
    return int(12742 * math.asin(math.sqrt(max(0.0, a))))


def main() -> None:
    airports_raw = fetch("airports.dat")
    routes_raw = fetch("routes.dat")
    airlines_raw = fetch("airlines.dat")

    airline_name = {}
    for row in airlines_raw:  # id,name,alias,iata,icao,callsign,country,active
        if len(row) >= 8 and row[3] and row[3] != r"\N" and row[7] == "Y":
            airline_name[row[3]] = row[1]

    airports = {}
    for row in airports_raw:
        # id,name,city,country,iata,icao,lat,lon,...
        if len(row) < 8:
            continue
        iata = row[4]
        if not iata or iata == r"\N" or len(iata) != 3:
            continue
        try:
            lat, lon = float(row[6]), float(row[7])
        except ValueError:
            continue
        airports[row[0]] = {
            "iata": iata, "name": row[1], "city": row[2], "country": row[3],
            "lat": round(lat, 4), "lng": round(lon, 4),
        }
    by_iata = {a["iata"]: a for a in airports.values()}

    # Aggregate directed nonstop routes, operating carrier only.
    pair_airlines: dict[tuple[str, str], set[str]] = defaultdict(set)
    pair_equipment: dict[tuple[str, str], set[str]] = defaultdict(set)
    for row in routes_raw:
        # airline,airline_id,src,src_id,dst,dst_id,codeshare,stops,equipment
        if len(row) < 9 or row[7] != "0" or row[6] == "Y":
            continue
        src, dst = airports.get(row[3]), airports.get(row[5])
        if not src or not dst or src["iata"] == dst["iata"]:
            continue
        key = (src["iata"], dst["iata"])
        if row[0] and row[0] != r"\N":
            pair_airlines[key].add(row[0])
        for eq in row[8].split():
            pair_equipment[key].add(eq)

    # Curated routes missing from the ~2014 OpenFlights snapshot
    # (e.g. Israel-UAE services launched after the 2020 Abraham Accords).
    # Both directions; operating carriers + typical equipment.
    MANUAL_ROUTES = [
        ("TLV", "DXB", ["EK", "LY", "FZ"], ["77W", "789", "738"]),  # Emirates, El Al, flydubai
        ("TLV", "AUH", ["EY"], ["321", "789"]),                      # Etihad
        ("AUH", "TPE", ["EY"], ["77W", "789"]),                      # Etihad
    ]
    for src_iata, dst_iata, carriers, equipment in MANUAL_ROUTES:
        for s, d in ((src_iata, dst_iata), (dst_iata, src_iata)):
            if s in by_iata and d in by_iata:
                pair_airlines[(s, d)].update(carriers)
                pair_equipment[(s, d)].update(equipment)
    print(f"manual routes merged: {len(MANUAL_ROUTES)} pairs (bidirectional)")

    out_dests: dict[str, set[str]] = defaultdict(set)
    in_srcs: dict[str, set[str]] = defaultdict(set)
    for (s, d) in pair_airlines:
        out_dests[s].add(d)
        in_srcs[d].add(s)

    ranked = sorted(
        by_iata.values(),
        key=lambda a: len(out_dests.get(a["iata"], ())) + len(in_srcs.get(a["iata"], ())),
        reverse=True,
    )
    keep = {
        a["iata"] for a in ranked[:MAX_AIRPORTS]
        if len(out_dests.get(a["iata"], ())) >= MIN_DESTINATIONS
    }

    routes = []
    used_airlines: dict[str, str] = {}
    dest_count: dict[str, int] = defaultdict(int)
    route_count: dict[str, int] = defaultdict(int)
    for (s, d), codes in sorted(pair_airlines.items()):
        if s not in keep or d not in keep:
            continue
        a, b = by_iata[s], by_iata[d]
        codes = sorted(codes)
        for c in codes:
            if c in airline_name:
                used_airlines[c] = airline_name[c]
        routes.append({
            "s": s, "d": d, "n": max(1, len(codes)), "a": codes,
            "km": haversine_km(a["lat"], a["lng"], b["lat"], b["lng"]),
            "eq": sorted(pair_equipment[(s, d)])[:6],
        })
        dest_count[s] += 1
        route_count[s] += len(codes)

    airport_list = []
    for a in ranked:
        if a["iata"] not in keep:
            continue
        airport_list.append({
            **a,
            "dests": dest_count.get(a["iata"], 0),
            "services": route_count.get(a["iata"], 0),
        })
    airport_list.sort(key=lambda x: x["services"], reverse=True)

    # Wikipedia: store the article LINK for every airport here. Abstracts are
    # fetched lazily by the browser (Wikipedia REST summary API) when an
    # airport is viewed -- bulk-fetching 1,300 extracts hits HTTP 429 rate
    # limits (see fetch_abstracts, kept for small-batch/offline use).
    print("fetching Wikipedia links…")
    wiki_links = fetch_wiki_links()
    kept_urls = {a["iata"]: wiki_links[a["iata"]] for a in airport_list if a["iata"] in wiki_links}
    abstracts: dict[str, str] = {}
    wiki_count = 0
    for a in airport_list:
        url = kept_urls.get(a["iata"])
        if url:
            a["wiki"] = url
            wiki_count += 1
    print(f"wikipedia: {wiki_count} links for {len(airport_list)} airports "
          f"(abstracts load lazily in the browser)")

    payload = {
        "meta": {
            "source": "OpenFlights (prototype; routes largely circa 2014, no frequency data)",
            "volumeMetric": "distinct operating airlines per route (proxy only)",
            "generatedFor": "FlightAtlas prototype",
            "airports": len(airport_list),
            "routes": len(routes),
            "wikipediaLinks": wiki_count,
            "wikipediaAbstracts": len(abstracts),
        },
        "airlines": used_airlines,
        "airports": airport_list,
        "routes": routes,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, separators=(",", ":"), ensure_ascii=False))
    print(f"airports={len(airport_list)} routes={len(routes)} airlines={len(used_airlines)}")
    print(f"wrote {OUT} ({OUT.stat().st_size / 1e6:.1f} MB)")
    print("top:", ", ".join(f"{a['iata']}({a['dests']})" for a in airport_list[:10]))


if __name__ == "__main__":
    main()
