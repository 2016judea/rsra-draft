// Build /for/<token>/ pages: one per outreach recipient, opening on THEIR OWN properties
// (their institution's SBA loans, or their own office) as pre-run free slices. Only the
// free slice ships (api/_lib/rsra.js freeSlice); the full draft stays behind the paywall.
//
// Run: node scripts/build_for.mjs outreach/round1/recipients.json
//   in:  recipients.json  [{ token, name, org, segment, items: [{ kind, street, city, zip, borrower, program, amount, approved }] }]
//   out: for/<token>/index.html, and <in>.built.json (what each page shows, for the drafts)
// Slices are cached in private/slices/ (gitignored), so a rerun only searches new addresses.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { buildReport, freeSlice } from "../api/_lib/rsra.js";
import { subjectKey } from "../api/_lib/pay.js";

const IN = process.argv[2];
if (!IN) { console.error("usage: node scripts/build_for.mjs <recipients.json>"); process.exit(1); }
const ROOT = new URL("../", import.meta.url);
const people = JSON.parse(readFileSync(IN, "utf8"));
const CACHE = new URL("private/slices/", ROOT);
mkdirSync(CACHE, { recursive: true });
const PAGE = readFileSync(new URL("index.html", ROOT), "utf8");

const titleCase = (s) => String(s || "").toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase()).replace(/\b(Ne|Nw|Se|Sw|Mn|Llc|Inc)\b/g, (m) => m.toUpperCase());
// FOIA streets carry lists and unit runs ("67, 79, and 91 Lake Street South", "24947 Larson Lane, Units 111, 112"):
// keep the first house number and the street. A redacted number ("XXXX Cree Street") cannot be searched.
function cleanStreet(st) {
  const s = String(st || "").replace(/\s+/g, " ").trim();
  const m = s.match(/^(\d+[A-Za-z]?)(?:\s*(?:,|-|&|and)\s*\d+[A-Za-z]?)*(?:,?\s*(?:and|&)\s*\d+[A-Za-z]?)?\s+([^,]+)/);
  return m ? `${m[1]} ${m[2]}`.replace(/\s+(Suite|Ste|Unit|Units|#).*$/i, "") : null;
}
const addressOf = (it) => {
  if (!it.city) return it.street;
  const st = cleanStreet(it.street);
  return st ? `${titleCase(st)}, ${titleCase(it.city)}, MN` : null;
};
const money = (n) => n >= 1e6 ? `$${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : `$${Math.round(n / 1e3)}k`;
const month = (d) => new Date(d + "T12:00:00Z").toLocaleString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });

async function slice(address) {
  const f = new URL(createHash("sha1").update(address).digest("hex").slice(0, 16) + ".json", CACHE);
  if (existsSync(f)) return JSON.parse(readFileSync(f, "utf8"));
  let r;
  for (let a = 0; a < 3; a++) {
    try { r = await buildReport(address, {}); } catch (e) { r = { error: e.message }; }
    // the geocoded point fell in the street: take the nearest parcel only if it carries the same house number
    if (r.choose) {
      const num = address.match(/^\d+/)?.[0];
      const c = r.choose.candidates.find((x) => num && String(x.address || "").startsWith(num + " ") && x.feet < 200);
      if (c) { try { r = await buildReport(address, { pin: c.pin }); } catch (e) { r = { error: e.message }; } }
    }
    if (!(r.errors?.length) && !(r.error && /fetch|abort|timed|did not answer|ECONN|5\d\d/i.test(r.error))) break;
    await new Promise((ok) => setTimeout(ok, 3000 * (a + 1)));
  }
  const out = r.error || r.choose ? { error: r.error || "needs a parcel choice" } : r.errors?.length ? { error: "source failed: " + r.errors.join("; ") } : { ...freeSlice(r), key: subjectKey(r.subject) };
  if (!out.error || !/source failed|did not answer|fetch/i.test(out.error)) writeFileSync(f, JSON.stringify(out));
  return out;
}

// run at most 3 searches at once
const queue = [...new Set(people.flatMap((p) => p.items.map(addressOf)).filter(Boolean))];
const done = {};
await Promise.all([0, 1].map(async () => { while (queue.length) { const a = queue.shift(); done[a] = await slice(a); if (done[a].error) console.log("x", a, "|", done[a].error.slice(0, 120)); else process.stdout.write("."); } }));
console.log();

const built = [];
for (const p of people) {
  const items = [];
  for (const it of p.items) {
    const s = addressOf(it) && done[addressOf(it)];
    if (!s || s.error || !s.subject) continue;
    const label = s.subject.parcel?.address || s.subject.matched;
    const note = it.kind === "office" ? "Your office" : `${it.borrower ? titleCase(it.borrower) + ": " : ""}${money(it.amount)} SBA ${it.program}, ${month(it.approved)}`;
    items.push({ label, note, address: addressOf(it), pin: s.subject.parcel?.pin || "", slice: s, src: it });
    if (items.length === 3) break;
  }
  if (!items.length) { console.warn(`no usable property for ${p.name}`); continue; }
  const hasOffice = items[0].src.kind === "office";
  const intro = p.segment === "consultant" && hasOffice
    ? "Your office parcel, then properties that got recent SBA 504 loans in the metro, each run through the draft. Type any MSP address above to run your own."
    : p.segment === "consultant" ? "Properties that got recent SBA 504 loans in the metro, each run through the draft. Type any MSP address above to run your own."
    : `Recent SBA ${items[0].src.program} loans from ${p.org}, each run through the draft. Type any MSP address above to run your own.`;
  const FOR = { token: p.token, name: p.name, org: p.org, intro, items: items.map(({ label, note, address, pin, slice }) => ({ label, note, address, pin, slice })) };
  const html = PAGE
    .replace("<head>", `<head>\n<meta name="robots" content="noindex">`)
    .replace(/<title>[^<]*<\/title>/, `<title>RSRA Draft Tool · for ${p.name}</title>`)
    .replace('<main id="out"></main>', `<main id="out"></main>\n<script>window.FOR=${JSON.stringify(FOR).replace(/</g, "\\u003c")};</script>`);
  mkdirSync(new URL(`for/${p.token}/`, ROOT), { recursive: true });
  writeFileSync(new URL(`for/${p.token}/index.html`, ROOT), html);
  built.push({ ...p, page_url: `https://rsra-draft.vercel.app/for/${p.token}/`, items: items.map(({ slice, ...x }) => ({ ...x,
    call: slice.risk.suggestion, rules_fired: slice.risk.rules.filter((r) => r.n).map((r) => `${r.id}:${r.n}`), findings: slice.totals.findings,
    on_subject: slice.totals.on_subject, open: slice.totals.open, earliest_year: slice.historical.earliest_year, year_built: slice.subject.parcel?.year_built || null, use: slice.subject.parcel?.use || null })) });
}
writeFileSync(IN.replace(/\.json$/, ".built.json"), JSON.stringify(built, null, 1));
console.log(`${built.length} pages in for/; ${Object.values(done).filter((s) => s.error).length} of ${Object.keys(done).length} addresses failed`);
