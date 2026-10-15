// Build example.json: the worked example the page opens on, run once and served
// static, so a first visit renders instantly instead of waiting ~15 s on eight
// live registers. It is the FREE SLICE only (api/_lib/rsra.js freeSlice): the full
// draft never ships as a static file (README "## The paywall").
//
// Run: node scripts/build_example.mjs
import { writeFileSync } from "node:fs";
import { buildReport, freeSlice } from "../api/_lib/rsra.js";
import { subjectKey } from "../api/_lib/pay.js";

export const EXAMPLE = "2125 Hennepin Ave E, Minneapolis, MN";
const r = await buildReport(EXAMPLE, {});
if (r.error || r.choose || r.errors?.length) { console.error(r.error || r.errors || "address needs a parcel choice"); process.exit(1); }
const slice = { ...freeSlice(r), key: subjectKey(r.subject) };
const js = JSON.stringify(slice);
if (slice.findings || js.includes('"timeline"') || r.findings.some((f) => f.name && js.includes(JSON.stringify(f.name)))) throw new Error("free slice leaked the paid draft");
writeFileSync(new URL("../example.json", import.meta.url), JSON.stringify(slice));
console.log(`example.json (free slice): ${r.findings.length} findings counted, searched ${r.generated}`);
