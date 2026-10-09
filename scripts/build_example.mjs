// Build example.json: the worked example the page opens on, run once and served
// static, so a first visit renders instantly instead of waiting ~15 s on eight
// live registers. The report keeps its own "records searched" date, so the
// snapshot says how old it is. Re-run when the sources or the report change.
//
// Run: node scripts/build_example.mjs
import { writeFileSync } from "node:fs";
import { buildReport } from "../api/_lib/rsra.js";

export const EXAMPLE = "2125 Hennepin Ave E, Minneapolis, MN";
const r = await buildReport(EXAMPLE, {});
if (r.error || r.choose || r.errors?.length) { console.error(r.error || r.errors || "address needs a parcel choice"); process.exit(1); }
writeFileSync(new URL("../example.json", import.meta.url), JSON.stringify(r));
console.log(`example.json: ${r.findings.length} findings, searched ${r.generated}`);
