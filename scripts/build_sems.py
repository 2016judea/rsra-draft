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
    need = [(r["epa_id"], r["street_addr_txt"] or "", r["city_name"] or "", r["zip_code"] or "")
            for r in raw if r["primary_latitude_decimal_val"] is None and r["street_addr_txt"]]
    geo = batch_geocode(need) if need else {}
    sites, unplaced = [], 0
    for r in raw:
        lat, lon, how = r["primary_latitude_decimal_val"], r["primary_longitude_decimal_val"], "EPA SEMS coordinate"
        if lat is None and r["epa_id"] in geo:
            (lat, lon), how = geo[r["epa_id"]], "Census geocode of the SEMS street address"
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
        "counts": counts, "unplaced": unplaced, "sites": sites,
    }
    OUT.write_text(json.dumps(doc, separators=(",", ":")))
    print(f"{len(sites)} SEMS sites, {unplaced} without a coordinate, by list {counts}")


if __name__ == "__main__":
    sys.exit(main())
