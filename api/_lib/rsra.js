// Draft Records Search with Risk Assessment (RSRA) for one Minnesota address.
// Every number on the report is computed here from a live or cached public
// record; nothing is typed. The risk call is a SUGGESTION produced by the
// rules in RULES, and the report prints which rule fired on which row.

import { readFileSync } from "node:fs";

function loadJson(rel) {
  for (const base of [new URL("../../", import.meta.url), `file://${process.cwd()}/`]) {
    try { return JSON.parse(readFileSync(new URL(rel, base), "utf8")); } catch {}
  }
  throw new Error(`cannot read ${rel}`);
}
const LISTS = loadJson("data/lists.json");
const SEMS = loadJson("data/sems_mn.json");

const MPCA = "https://enterprise.gisdata.mn.gov/aghost/rest/services/us_mn_state_pca/env_my_neighborhood/MapServer/0/query";
const PARCELS = "https://arcgis.metc.state.mn.us/data1/rest/services/parcels/Parcels/FeatureServer";
const EMEF_BF = "https://geopub.epa.gov/arcgis/rest/services/EMEF/efpoints/MapServer/5/query";
const ECHO = "https://echodata.epa.gov/echo/rcra_rest_services";
const GEOCODER = "https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress";
const TNM = "https://tnmaccess.nationalmap.gov/api/v1/products";
const LOC = "https://www.loc.gov/collections/sanborn-maps/";
// Met Council regional parcel layers, by county FIPS.
const COUNTY_LAYER = { "003": 0, "019": 1, "037": 2, "053": 3, "123": 4, "139": 5, "163": 6 };

const MI_FT = 5280;

// ---- search distances ------------------------------------------------------
export function searchMiles(list) {
  const v = (x) => (x === "adjoining" ? LISTS.adjoining_miles : x === "property" ? 0 : x == null ? 0 : x);
  return Math.max(v(list.cfr_miles), v(list.astm_miles));
}
const LIST_BY_ID = Object.fromEntries(LISTS.lists.map((l) => [l.id, { ...l, miles: searchMiles(l) }]));
const MAX_MILES = Math.max(...Object.values(LIST_BY_ID).map((l) => l.miles));

// ---- geometry --------------------------------------------------------------
// Local equirectangular projection to feet around a reference latitude: the
// error at 1 mile is well under a foot, which is below the precision of any
// address-matched coordinate in these registers.
function projector(lat0, lon0) {
  const kx = Math.cos((lat0 * Math.PI) / 180) * 69.172 * MI_FT;
  const ky = 69.0 * MI_FT;
  return ([lon, lat]) => [(lon - lon0) * kx, (lat - lat0) * ky];
}
function insideRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function segDist([px, py], [ax, ay], [bx, by]) {
  const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
  let t = L ? ((px - ax) * dx + (py - ay) * dy) / L : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
// Miles from a lon/lat to the subject: 0 inside the parcel, else to its edge.
export function makeDistance(subject) {
  const P = projector(subject.lat, subject.lon);
  if (!subject.rings) {
    return (lon, lat) => { const [x, y] = P([lon, lat]); return Math.hypot(x, y) / MI_FT; };
  }
  const rings = subject.rings.map((r) => r.map(P));
  return (lon, lat) => {
    const p = P([lon, lat]);
    let n = 0;
    for (const r of rings) if (insideRing(p, r)) n++;
    if (n % 2 === 1) return 0;
    let best = Infinity;
    for (const r of rings) for (let i = 1; i < r.length; i++) best = Math.min(best, segDist(p, r[i - 1], r[i]));
    return best / MI_FT;
  };
}

// ---- fetch helpers ---------------------------------------------------------
async function getJson(url, { timeout = 25000, headers } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { "User-Agent": "rsra-draft (open source)", ...headers } });
    if (!r.ok) throw new Error(`${new URL(url).host} answered HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}
const qs = (o) => new URLSearchParams(o).toString();

// ---- step 1: geocode + parcel ---------------------------------------------
const situs = (a) => [a.ANUMBER, a.ST_PRE_DIR, a.ST_NAME, a.ST_POS_TYP, a.ST_POS_DIR].filter((x) => x != null && x !== "").join(" ") + (a.CTU_NAME ? `, ${a.CTU_NAME}` : "");
export async function locate(address, pin, usePoint) {
  const g = await getJson(`${GEOCODER}?${qs({ address, benchmark: "Public_AR_Current", vintage: "Current_Current", layers: "Counties", format: "json" })}`);
  const m = g.result?.addressMatches?.[0];
  if (!m) return { error: "The Census geocoder could not find that address. Try the street number, street and city." };
  const state = m.addressComponents?.state;
  if (state !== "MN") return { error: `That address is in ${state || "another state"}. This tool covers Minnesota only.` };
  const county = m.geographies?.Counties?.[0];
  const subject = {
    input: address, matched: m.matchedAddress, lat: m.coordinates.y, lon: m.coordinates.x,
    county: county?.BASENAME || null, county_fips: county?.COUNTY || null,
    house_number: (m.addressComponents?.fromAddress && m.matchedAddress.split(" ")[0]) || null,
    street: m.addressComponents?.streetName || null, city: m.addressComponents?.city || null,
  };
  const layer = COUNTY_LAYER[subject.county_fips];
  if (layer == null) { subject.parcel_note = "Outside the seven-county metro: no parcel boundary, distances run from the address point."; return { subject }; }
  // The geocoder interpolates along the street centerline, so its point often
  // sits in the right-of-way or across the street. Match the county's own
  // situs address first (house number + street + city); only then fall back
  // to the parcel CONTAINING the point. Never the nearest parcel: a
  // contamination finding pinned to the neighbour's lot is a false statement.
  const OUT = "COUNTY_PIN,ANUMBER,ANUMBERSUF,ST_PRE_DIR,ST_NAME,ST_POS_TYP,ST_POS_DIR,CTU_NAME,OWNER_NAME,TAX_NAME,USECLASS1,YEAR_BUILT,ACRES_POLY,EMV_TOTAL,ABB_LEGAL";
  const num = String(subject.house_number || "").replace(/\D/g, "");
  const street = String(subject.street || "").toUpperCase().replace(/'/g, "''");
  const dist0 = (f) => makeDistance({ lat: subject.lat, lon: subject.lon, rings: f.geometry.rings })(subject.lon, subject.lat);
  let pick = null;
  if (pin) {
    const fq = await getJson(`${PARCELS}/${layer}/query?${qs({ f: "json", outSR: 4326, returnGeometry: true, outFields: OUT, where: `COUNTY_PIN = '${String(pin).replace(/[^0-9A-Za-z.-]/g, "")}'` })}`);
    const f = (fq.features || [])[0];
    if (f && dist0(f) < 0.25) pick = { f, how: "parcel chosen by the user from those near the geocoded point" };
  }
  if (!pick && num && street) {
    const fa = await getJson(`${PARCELS}/${layer}/query?${qs({ f: "json", outSR: 4326, returnGeometry: true, outFields: OUT,
      where: `ANUMBER = ${Number(num)} AND UPPER(ST_NAME) = '${street}'` })}`);
    const dir = (m.addressComponents?.preDirection || m.addressComponents?.suffixDirection || "").toUpperCase();
    const c = (fa.features || []).map((f) => ({ f, d: dist0(f), dirOk: !dir || [f.attributes.ST_PRE_DIR, f.attributes.ST_POS_DIR].some((x) => x && x.toUpperCase().startsWith(dir)) }))
      .filter((x) => x.d < 0.5).sort((x, y) => (y.dirOk - x.dirOk) || x.d - y.d);
    if (c[0]) pick = { f: c[0].f, how: "county situs address (house number and street)" };
  }
  if (!pick) {
    const fp = await getJson(`${PARCELS}/${layer}/query?${qs({ f: "json", geometry: `${subject.lon},${subject.lat}`, geometryType: "esriGeometryPoint", inSR: 4326,
      spatialRel: "esriSpatialRelIntersects", outSR: 4326, returnGeometry: true, outFields: OUT })}`);
    const f = (fp.features || [])[0];
    if (f) pick = { f, how: "parcel containing the geocoded point; the county lists a different situs address, confirm it is the subject" };
  }
  if (!pick && !usePoint) {
    // Hand the choice back: the parcels within 300 ft, nearest first.
    const fn = await getJson(`${PARCELS}/${layer}/query?${qs({ f: "json", geometry: `${subject.lon},${subject.lat}`, geometryType: "esriGeometryPoint", inSR: 4326,
      distance: 300, units: "esriSRUnit_Foot", spatialRel: "esriSpatialRelIntersects", outSR: 4326, returnGeometry: true, outFields: OUT })}`);
    const candidates = (fn.features || []).map((f) => ({ f, d: dist0(f) })).sort((x, y) => x.d - y.d).slice(0, 8).map(({ f, d }) => {
      const a = f.attributes;
      return { pin: a.COUNTY_PIN, address: situs(a), owner: a.OWNER_NAME || a.TAX_NAME, use: a.USECLASS1, feet: Math.round(d * MI_FT) };
    });
    return { choose: { matched: subject.matched, candidates } };
  }
  if (!pick) {
    subject.parcel_note = "No county parcel was chosen; distances run from the geocoded address point, not a property boundary.";
    return { subject };
  }
  const a = pick.f.attributes;
  subject.rings = pick.f.geometry.rings;
  subject.parcel = {
    address: situs(a),
    pin: a.COUNTY_PIN, owner: a.OWNER_NAME || a.TAX_NAME, use: a.USECLASS1, year_built: a.YEAR_BUILT || null,
    acres: a.ACRES_POLY, market_value: a.EMV_TOTAL, legal: (a.ABB_LEGAL || "").trim() || null,
    match: pick.how,
    source: `Metropolitan Council regional parcels (${subject.county} County layer)`,
    source_url: `${PARCELS}/${layer}`,
  };
  // Re-centre on the parcel so radius queries cover its far edge.
  let sx = 0, sy = 0, n = 0, maxd = 0;
  for (const [x, y] of subject.rings[0]) { sx += x; sy += y; n++; }
  subject.lon = sx / n; subject.lat = sy / n;
  const P = projector(subject.lat, subject.lon);
  for (const r of subject.rings) for (const pt of r) maxd = Math.max(maxd, Math.hypot(...P(pt)));
  subject.radius_miles = maxd / MI_FT;
  return { subject };
}

// ---- step 2: state registers ----------------------------------------------
// Release and cleanup files come from MPCA's remediation layer, which carries a
// status PER PROJECT. The What's In My Neighborhood layer only carries one
// active flag per SITE, so a site with a live hazardous-waste registration and
// a leak closed in 1995 reads "active" there. It is used only for the lists
// that have no project status anyway: tanks, generators and solid waste.
const REMED = "https://enterprise.gisdata.mn.gov/aghost/rest/services/us_mn_state_pca/env_remediation_sites/MapServer";
const REMED_TYPE = {
  "Leak Site": ["lust"], "Brownfield Site": [], "Superfund Site": ["state_superfund"], "Superfund sub-area": ["state_superfund"],
  "Site Assessment Site": ["state_site_assessment"], "RCRA Remediation Site": ["state_rcra_remediation"],
  "Emergency Response Site": ["state_spills"], "Integrated Remediation": ["state_site_assessment"],
};
function remedLists(a) {
  const out = new Set(REMED_TYPE[a.project_type] || []);
  if (a.project_type === "Brownfield Site") { out.add("brownfields_state"); if (a.bvic === "Y" || a.bpet === "Y") out.add("vic"); }
  if (a.ic === "Y") out.add("state_ic");
  return [...out];
}
function wimnLists(a) {
  const acts = (a.activity_list || "").split(";").map((s) => s.trim());
  const has = (re) => acts.some((x) => re.test(x));
  const out = [];
  if (has(/^Solid Waste/)) out.push("landfill");
  if (has(/Underground Tanks|Aboveground Tanks/)) out.push("tanks");
  if (has(/^Hazardous Waste/)) out.push("state_hw_gen");
  return out;
}

async function arcgisAll(base, params) {
  const rows = [];
  for (let offset = 0; offset < 20000; offset += 2000) {
    const d = await getJson(`${base}?${qs({ ...params, resultOffset: offset, resultRecordCount: 2000 })}`);
    if (d.error) throw new Error(d.error.message);
    rows.push(...(d.features || []));
    if (!d.exceededTransferLimit) break;
  }
  return rows;
}
async function arcgisPost(base, params) {
  const r = await fetch(base, { method: "POST", body: new URLSearchParams(params), headers: { "Content-Type": "application/x-www-form-urlencoded" } });
  const d = await r.json();
  if (d.error) throw new Error(d.error.message);
  return d.features || [];
}
const ymd = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : null);

async function searchRemediation(subject, dist) {
  const r = subject.radius_miles || 0;
  const feats = await arcgisAll(`${REMED}/0/query`, { f: "json", geometry: `${subject.lon},${subject.lat}`, geometryType: "esriGeometryPoint", inSR: 4326,
    units: "esriSRUnit_StatuteMile", distance: 1.0 + r, where: "1=1", returnGeometry: false,
    outFields: "item_id,ai_id,ai_name,project_id,project_type,project_name,address1,city,latitude,longitude,method_desc,status,npl,plp,bpet,bvic,sems,ic,wimn_url" });
  const hits = [];
  for (const { attributes: a } of feats) {
    if (a.latitude == null) continue;
    const d = dist(a.longitude, a.latitude);
    for (const id of remedLists(a)) {
      if (d > LIST_BY_ID[id].miles + 1e-9) continue;
      hits.push({
        list: id, name: a.project_name && a.project_name !== a.ai_name ? `${a.ai_name} (${a.project_name})` : a.ai_name,
        address: [a.address1, a.city].filter(Boolean).join(", "), miles: d,
        status: a.status || "Not recorded", open: a.status === "Active / Existing",
        detail: `${a.project_type}${a.plp === "Y" ? ", on the state PLP" : ""}${a.npl === "Y" ? ", on the NPL" : ""}`,
        ids: a.project_id, url: a.wimn_url, source: "MPCA Remediation Sites", located_by: a.method_desc, _item: a.item_id,
      });
    }
  }
  // Start and closure dates live in the activity table, one row per project.
  const items = [...new Set(hits.map((h) => h._item))];
  const dates = new Map();
  for (let i = 0; i < items.length; i += 150) {
    const rows = await arcgisPost(`${REMED}/1/query`, { f: "json", returnGeometry: "false", outFields: "item_id,site_start,leak_discovered,received,site_closed,nfa_decision",
      where: `item_id IN (${items.slice(i, i + 150).map((x) => `'${x.replace(/'/g, "''")}'`).join(",")})` });
    for (const { attributes: t } of rows) {
      const prev = dates.get(t.item_id) || {};
      const opened = t.leak_discovered || t.site_start || t.received;
      dates.set(t.item_id, { opened: prev.opened && prev.opened < opened ? prev.opened : opened, closed: t.site_closed || t.nfa_decision || prev.closed });
    }
  }
  for (const h of hits) {
    const t = dates.get(h._item);
    if (t) { h.opened = ymd(t.opened); h.closed = ymd(t.closed); }
    delete h._item;
  }
  return hits;
}

async function searchWimn(subject, dist) {
  const r = subject.radius_miles || 0;
  const feats = await arcgisAll(MPCA, { f: "json", geometry: `${subject.lon},${subject.lat}`, geometryType: "esriGeometryPoint", inSR: 4326, units: "esriSRUnit_StatuteMile",
    distance: 0.5 + r, returnGeometry: false,
    where: "activity_list LIKE '%Tanks%' OR activity_list LIKE '%Hazardous Waste%' OR activity_list LIKE '%Solid Waste%'",
    outFields: "site_id,name,active_flag,address_street,address_city,activity_list,mpca_id_list,latitude,longitude,site_url,coord_collect_method_name" });
  const hits = [];
  for (const { attributes: a } of feats) {
    if (a.latitude == null) continue;
    const d = dist(a.longitude, a.latitude);
    for (const id of wimnLists(a)) {
      if (d > LIST_BY_ID[id].miles + 1e-9) continue;
      const acts = a.activity_list.split(";").map((x) => x.trim()).filter((x) => id === "tanks" ? /Tanks/.test(x) : id === "landfill" ? /^Solid Waste/.test(x) : /^Hazardous Waste/.test(x));
      hits.push({
        list: id, name: a.name, address: [a.address_street?.trim(), a.address_city].filter(Boolean).join(", "), miles: d,
        status: a.active_flag === "Y" ? "Site active" : "Site inactive", open: id === "landfill" ? null : a.active_flag === "Y",
        detail: acts.join("; "), ids: a.mpca_id_list, url: a.site_url,
        source: "MPCA What's In My Neighborhood", located_by: a.coord_collect_method_name,
      });
    }
  }
  return hits;
}

async function searchEcho(subject, dist) {
  const r = subject.radius_miles || 0;
  const q = await getJson(`${ECHO}.get_facilities?${qs({ output: "JSON", p_lat: subject.lat.toFixed(6), p_long: subject.lon.toFixed(6), p_radius: (1 + r).toFixed(3) })}`, { timeout: 40000 });
  const qid = q.Results?.QueryID;
  const rows = Number(q.Results?.QueryRows || 0);
  const facs = [];
  for (let page = 1; qid && facs.length < rows && page < 20; page++) {
    const d = await getJson(`${ECHO}.get_qid?${qs({ output: "JSON", qid, pageno: page, responseset: 1000 })}`, { timeout: 40000 });
    const got = d.Results?.Facilities || [];
    facs.push(...got);
    if (!got.length) break;
  }
  const hits = [];
  for (const f of facs) {
    if (!f.FacLat) continue;
    const d = dist(Number(f.FacLong), Number(f.FacLat));
    const uni = f.RCRAUniverse || "";
    const base = {
      name: f.RCRAName, address: [f.RCRAStreet, f.RCRACity].filter(Boolean).join(", "), miles: d,
      status: (f.RCRAStatus || "").replace(/\(\s*\)/, "").replace(/\(\s*(\S+)\s*\)/, "($1)").trim() || "Unknown", ids: f.SourceID,
      url: `https://echo.epa.gov/detailed-facility-report?fid=${f.RegistryID}`, source: "EPA ECHO (RCRAInfo)",
    };
    base.open = /^Active/i.test(base.status);
    if (f.CleanupActionFlag === "Y" && d <= LIST_BY_ID.corracts.miles) hits.push({ ...base, list: "corracts", detail: `Corrective action flag; universe: ${uni}`, open: true });
    if (/TSDF/.test(uni) && d <= LIST_BY_ID.rcra_tsdf.miles) hits.push({ ...base, list: "rcra_tsdf", detail: uni });
    if (/\b(LQG|SQG|VSQG)\b/.test(uni) && d <= LIST_BY_ID.rcra_gen.miles) hits.push({ ...base, list: "rcra_gen", detail: uni });
  }
  return { hits, searched: facs.length };
}

async function searchBrownfields(subject, dist) {
  const r = subject.radius_miles || 0;
  const feats = await arcgisAll(EMEF_BF, { f: "json", geometry: `${subject.lon},${subject.lat}`, geometryType: "esriGeometryPoint", inSR: 4326, distance: 0.5 + r, units: "esriSRUnit_StatuteMile", outFields: "*", returnGeometry: false, where: "1=1" });
  return feats.map(({ attributes: a }) => ({
    list: "brownfields_fed", name: a.primary_name, address: [a.location_address, a.city_name].filter(Boolean).join(", "),
    miles: dist(a.longitude, a.latitude), status: "ACRES property", open: null, detail: `ACRES ${a.pgm_sys_id}`, ids: a.registry_id,
    url: a.facility_url, source: "EPA ACRES (EMEF Brownfields layer)",
  })).filter((h) => h.miles <= LIST_BY_ID.brownfields_fed.miles);
}

function searchSems(subject, dist) {
  const hits = [], unplaced = [];
  const city = (subject.city || "").toLowerCase();
  for (const s of SEMS.sites) {
    if (s.lat == null) { if (city && s.address.toLowerCase().endsWith(city)) unplaced.push(s); continue; }
    const d = dist(s.lon, s.lat);
    if (d > LIST_BY_ID[s.list].miles) continue;
    hits.push({
      list: s.list, name: s.name, address: s.address, miles: d,
      status: s.list === "sems_archive" ? `Archived ${s.archived_date || ""}`.trim() : s.npl_status,
      open: s.list === "npl" || s.list === "sems", detail: s.non_npl_status || s.npl_status, ids: s.epa_id,
      url: s.url, source: "EPA SEMS (Envirofacts)", located_by: s.coord_source,
    });
  }
  return { hits, unplaced: unplaced.map((s) => ({ name: s.name, address: s.address, epa_id: s.epa_id, list: s.list, url: s.url })) };
}

// ---- step 3: historical use ------------------------------------------------
async function historicalTopos(subject) {
  const d = 0.002;
  const bbox = [subject.lon - d, subject.lat - d, subject.lon + d, subject.lat + d].join(",");
  const j = await getJson(`${TNM}?${qs({ datasets: "Historical Topographic Maps", bbox, max: 200, outputFormat: "JSON" })}`, { timeout: 30000 });
  const seen = new Map();
  for (const i of j.items || []) {
    const year = Number((i.publicationDate || "").slice(0, 4));
    const scale = (i.title.match(/1:(\d+)/) || [])[1];
    if (!year || !scale || Number(scale) > 62500) continue; // 1:100k and 1:250k are too coarse to read a parcel
    const key = `${year}-${scale}`;
    if (!seen.has(key)) seen.set(key, { year, kind: "USGS topographic map", detail: i.title, url: i.downloadURL, source: "USGS National Map (TNM API)" });
  }
  return [...seen.values()];
}
async function sanborn(subject) {
  const city = (subject.city || "").toLowerCase();
  if (!city) return [];
  const j = await getJson(`${LOC}?${qs({ fa: `location_state:minnesota|location_city:${city}`, fo: "json", c: 150 })}`, { timeout: 30000 });
  const byYear = new Map();
  for (const r of j.results || []) {
    if (!(r.location_city || []).some((c) => c === city)) continue;
    const year = Number(String(r.date || "").slice(0, 4));
    if (!year) continue;
    if (!byYear.has(year)) byYear.set(year, { year, kind: "Sanborn fire insurance map", detail: `${r.title} (${String(r.date)}), ${0} volumes`, url: r.id.replace("http://", "https://"), source: "Library of Congress Sanborn Maps", volumes: 0 });
    byYear.get(year).volumes++;
  }
  return [...byYear.values()].map((v) => ({ ...v, detail: `${v.volumes} volume${v.volumes === 1 ? "" : "s"} for ${subject.city}; locate the subject block on the volume index sheet` }));
}

// ---- step 4: the suggested risk call ---------------------------------------
const RELEASE_LISTS = new Set(["npl", "delisted_npl", "sems", "sems_archive", "corracts", "brownfields_fed", "state_superfund", "state_site_assessment", "state_rcra_remediation", "landfill", "lust", "vic", "brownfields_state", "state_spills", "state_ic"]);
const OPEN_CLEANUP_LISTS = new Set(["npl", "sems", "corracts", "state_superfund", "state_site_assessment", "state_rcra_remediation", "lust", "vic", "brownfields_state"]);
export const RULES = [
  { id: "R1", text: "The subject parcel itself appears on any release, cleanup, landfill, spill or control list, open or closed.",
    test: (h) => h.miles === 0 && RELEASE_LISTS.has(h.list) },
  { id: "R2", text: "The subject parcel holds a registered storage tank or a hazardous waste generator record (a use of concern on the property).",
    test: (h) => h.miles === 0 && ["tanks", "rcra_gen", "state_hw_gen", "rcra_tsdf"].includes(h.list) },
  { id: "R3", text: "An ACTIVE NPL, Superfund, corrective action, leak site, voluntary cleanup or brownfield file sits within that list's search distance.",
    test: (h) => h.miles > 0 && OPEN_CLEANUP_LISTS.has(h.list) && h.open === true },
];
export function riskCall(hits) {
  const fired = RULES.map((r) => ({ id: r.id, text: r.text, rows: hits.filter(r.test).map((h) => h.key) }));
  const high = fired.some((r) => r.rows.length);
  return { suggestion: high ? "High risk" : "Low risk", rules: fired,
    basis: high ? "One or more rules fired. Under SBA SOP 50 10 8 a High Risk RSRA is followed by a Phase I ESA." : "No rule fired on any record found." };
}

// "1629 Hennepin Avenue, Minneapolis" and "1629 HENNEPIN AVE" -> "1629 hennepin"
export function addrKey(a) {
  const m = String(a || "").toLowerCase().match(/^\s*(\d+)[a-z]?\s+(?:(?:n|s|e|w|ne|nw|se|sw|north|south|east|west)\s+)?([a-z0-9]+)/);
  return m ? `${m[1]} ${m[2]}` : null;
}

// ---- main ------------------------------------------------------------------
export async function buildReport(address, { pin, usePoint } = {}) {
  const started = Date.now();
  const loc = await locate(address, pin, usePoint);
  if (loc.error || loc.choose) return loc;
  const { subject } = loc;
  const dist = makeDistance(subject);
  const errors = [];
  const settle = async (name, p) => { try { return await p; } catch (e) { errors.push(`${name}: ${e.message}`); return null; } };
  const [remed, wimn, echo, bf, topos, sb] = await Promise.all([
    settle("MPCA Remediation Sites", searchRemediation(subject, dist)),
    settle("MPCA What's In My Neighborhood", searchWimn(subject, dist)),
    settle("EPA ECHO RCRA", searchEcho(subject, dist)),
    settle("EPA ACRES brownfields", searchBrownfields(subject, dist)),
    settle("USGS historical topo maps", historicalTopos(subject)),
    settle("Library of Congress Sanborn maps", sanborn(subject)),
  ]);
  const sems = searchSems(subject, dist);
  const hits = [...(remed || []), ...(wimn || []), ...(echo?.hits || []), ...(bf || []), ...sems.hits]
    .sort((a, b) => a.miles - b.miles || a.list.localeCompare(b.list));
  // An agency point is usually address-matched and can land just outside the
  // lot it describes. A record whose own address is the subject's address is
  // the subject's record, wherever its point fell.
  const subj = addrKey(subject.parcel?.address || subject.matched);
  for (const h of hits) {
    if (h.miles > 0 && h.miles < 0.05 && subj && addrKey(h.address) === subj) {
      h.located_by = `${h.located_by ? h.located_by + "; " : ""}address on file is the subject's, point lies ${Math.round(h.miles * MI_FT)} ft outside the parcel`;
      h.miles = 0;
    }
  }
  hits.sort((a, b) => a.miles - b.miles || a.list.localeCompare(b.list));
  hits.forEach((h, i) => { h.key = `F${i + 1}`; h.miles = Math.round(h.miles * 1000) / 1000; });
  const failedSource = (src) => errors.some((e) => e.startsWith(src));
  const lists = LISTS.lists.map((l) => {
    const mine = hits.filter((h) => h.list === l.id);
    const src = l.source.startsWith("MPCA Remediation") ? "MPCA Remediation" : l.source.startsWith("MPCA") ? "MPCA What" : l.source.includes("ECHO") ? "EPA ECHO" : l.source.includes("ACRES") ? "EPA ACRES" : null;
    return { ...l, miles: searchMiles(l), count: mine.length, on_subject: mine.filter((h) => h.miles === 0).length,
      open: mine.filter((h) => h.open === true).length, failed: src ? failedSource(src) : false };
  });
  const timeline = [...(topos || []), ...(sb || [])];
  if (subject.parcel?.year_built) timeline.push({ year: subject.parcel.year_built, kind: "County record: current building built", detail: `${subject.parcel.use || "Use not recorded"}; PIN ${subject.parcel.pin}`, url: subject.parcel.source_url, source: subject.parcel.source });
  for (const h of hits.filter((h) => h.miles === 0)) timeline.push({ year: null, kind: "Regulatory record on the subject parcel", detail: `${h.name}: ${h.detail}`, url: h.url, source: h.source });
  timeline.sort((a, b) => (a.year ?? 9999) - (b.year ?? 9999));
  const earliest = timeline.filter((t) => t.year).map((t) => t.year)[0] || null;
  return {
    generated: new Date().toISOString(), elapsed_ms: Date.now() - started,
    subject: { ...subject, rings: undefined, has_boundary: !!subject.rings },
    lists, findings: hits, sems_unplaced: sems.unplaced, sems_built_on: SEMS.built_on,
    echo_rows_searched: echo?.searched ?? null,
    historical: { timeline, earliest_year: earliest, reaches_1940: earliest != null && earliest <= 1940,
      to_review: [
        { kind: "Historical aerial photographs", url: "https://geo.lib.umn.edu/MHAPO/", source: "University of Minnesota, Minnesota Historical Aerial Photographs Online (1920s onward)" },
        { kind: "Historical aerial photographs", url: "https://earthexplorer.usgs.gov/", source: "USGS EarthExplorer, Aerial Photo Single Frames (free account)" },
        { kind: "City directories", url: "https://digitalcollections.hclib.org/digital/collection/p17208coll3", source: "Hennepin County Library, Minneapolis city directories" },
      ] },
    risk: riskCall(hits), rules: RULES.map(({ id, text }) => ({ id, text })),
    citations: LISTS.citations, adjoining_miles: LISTS.adjoining_miles, errors,
  };
}
