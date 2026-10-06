#!/usr/bin/env python3
"""Build data/sems_mn.json: every EPA SEMS site in Minnesota with a coordinate.

SEMS is the federal Superfund inventory. It answers four of the 40 CFR 312.26
lists at once: NPL (final), delisted NPL, active non-NPL SEMS sites, and the
SEMS archive (former CERCLIS sites with a No Further Remedial Action Planned
decision). It changes slowly and Minnesota has ~600 rows, so it is cached here
instead of queried per report.

Source: EPA Envirofacts, table sems.envirofacts_site (free, no key).
Archived sites mostly carry no coordinate, so they are geocoded with the
U.S. Census batch geocoder (free, no key). A site that will not geocode is
kept with `lat: null` and counted, never dropped in silence; the report lists
how many could not be placed.

Run: python3 scripts/build_sems.py
"""
import csv, io, json, sys, urllib.request, datetime, pathlib

OUT = pathlib.Path(__file__).resolve().parent.parent / "data" / "sems_mn.json"
SRC = "https://data.epa.gov/efservice/sems.envirofacts_site/fk_ref_state_code/equals/MN/JSON"
GEOCODER = "https://geocoding.geo.census.gov/geocoder/locations/addressbatch"


DISAGREE_MILES = 0.5


def miles(lat1, lon1, lat2, lon2):
    import math
    k = math.cos(math.radians((lat1 + lat2) / 2))
    return math.hypot((lon1 - lon2) * 69.172 * k, (lat1 - lat2) * 69.0)


def fetch(url):
    with urllib.request.urlopen(url, timeout=120) as r:
        return json.load(r)


def batch_geocode(rows):
    """rows: list of (id, street, city, zip). Returns {id: (lat, lon)}."""
    buf = io.StringIO()
    w = csv.writer(buf)
    for rid, street, city, z in rows:
        w.writerow([rid, street, city, "MN", z])
    body, boundary = buf.getvalue().encode(), "----rsra"
    parts = (
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"benchmark\"\r\n\r\nPublic_AR_Current\r\n"
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"addressFile\"; filename=\"a.csv\"\r\n"
        f"Content-Type: text/csv\r\n\r\n"
    ).encode() + body + f"\r\n--{boundary}--\r\n".encode()
    req = urllib.request.Request(GEOCODER, data=parts, headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    with urllib.request.urlopen(req, timeout=600) as r:
        text = r.read().decode("utf-8", "replace")
    out = {}
    for rec in csv.reader(io.StringIO(text)):
        if len(rec) >= 6 and rec[2] == "Match" and rec[5]:
            lon, lat = rec[5].split(",")
            out[rec[0]] = (float(lat), float(lon))
    return out


def main():
    raw = fetch(SRC)
    # Geocode EVERY site with a street address, not only those missing a
    # coordinate: EPA's own point is sometimes a city centroid (VA Medical
    # Center Minneapolis, 1 Veterans Drive, sits on City Hall) or simply wrong
    # (a Saint Paul address placed 40 miles away). Where the two disagree by
    # more than DISAGREE_MILES the address wins and the record says so.
    need = [(r["epa_id"], r["street_addr_txt"] or "", r["city_name"] or "", r["zip_code"] or "")
            for r in raw if r["street_addr_txt"]]
    geo = batch_geocode(need) if need else {}
    sites, unplaced, corrected = [], 0, 0
    for r in raw:
        lat, lon, how = r["primary_latitude_decimal_val"], r["primary_longitude_decimal_val"], "EPA SEMS coordinate"
        g = geo.get(r["epa_id"])
        if lat is None and g:
            (lat, lon), how = g, "Census geocode of the SEMS street address"
        elif lat is not None and g:
            off = miles(float(lat), float(lon), *g)
            if off > DISAGREE_MILES:
                corrected += 1
                (lat, lon), how = g, f"Census geocode of the SEMS street address (EPA's coordinate sits {off:.1f} mi from that address)"
            else:
                how = "EPA SEMS coordinate, agrees with its street address"
        if lat is None:
            unplaced += 1
        if r["npl_status_code"] == "F":
            lst = "npl"
        elif r["npl_status_code"] == "D":
            lst = "delisted_npl"
        elif r["archived_ind"] == "Y":
            lst = "sems_archive"
        else:
            lst = "sems"
        sites.append({
            "epa_id": r["epa_id"], "site_id": r["site_id"], "name": r["name"],
            "address": ", ".join(x for x in [r["street_addr_txt"], r["city_name"]] if x),
            "list": lst, "npl_status": r["npl_status_name"],
            "non_npl_status": r["non_npl_status_name"], "archived_date": (r["archived_date"] or "")[:10] or None,
            "lat": float(lat) if lat is not None else None, "lon": float(lon) if lon is not None else None,
            "coord_source": how if lat is not None else None,
            "url": f"https://cumulis.epa.gov/supercpad/cursites/csitinfo.cfm?id={r['site_id']}",
        })
    counts = {}
    for s in sites:
        counts[s["list"]] = counts.get(s["list"], 0) + 1
    doc = {
        "_comment": "Written by scripts/build_sems.py; do not hand-edit.",
        "source": SRC, "built_on": datetime.date.today().isoformat(),
        "counts": counts, "unplaced": unplaced, "epa_coordinate_replaced": corrected, "sites": sites,
    }
    OUT.write_text(json.dumps(doc, separators=(",", ":")))
    print(f"{len(sites)} SEMS sites, {unplaced} without a coordinate, {corrected} EPA coordinates replaced, by list {counts}")


if __name__ == "__main__":
    sys.exit(main())
