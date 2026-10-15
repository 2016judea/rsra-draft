import test from "node:test";
import assert from "node:assert/strict";
process.env.ACCESS_SECRET = "test-secret";
const { newPassword, checkPassword, subjectKey } = await import("../api/_lib/pay.js");
const { freeSlice } = await import("../api/_lib/rsra.js");

test("a paid password opens the property it was bought for and no other", () => {
  const { nonce, password } = newPassword("pin:053:1802923340065");
  assert.deepEqual(checkPassword(password, "pin:053:1802923340065"), { nonce, kind: "paid" });
  assert.equal(checkPassword(password.toLowerCase().replace(/-/g, " "), "pin:053:1802923340065")?.kind, "paid");
  assert.equal(checkPassword(password, "pin:053:2702924110135"), null);
  assert.equal(checkPassword("AAAA-BBBB-CCCC", "pin:053:1802923340065"), null);
});

test("subject key prefers county + PIN", () => {
  assert.equal(subjectKey({ county_fips: "053", parcel: { pin: "123" }, matched: "x" }), "pin:053:123");
  assert.equal(subjectKey({ matched: "1 Main St, Duluth, MN, 55802" }), "addr:1 MAIN ST DULUTH MN 55802");
});

test("the free slice carries counts, never a record", () => {
  const f = { key: "F1", list: "lust", miles: 0, name: "SECRET GAS STATION", open: true, address: "1 Main", url: "https://x" };
  const r = { generated: "", elapsed_ms: 0, subject: {}, lists: [{ id: "lust", name: "Leak sites" }], findings: [f], unlocated: [], sems_unplaced: [],
    historical: { timeline: [{ year: 1912, kind: "Sanborn map", url: "https://loc" }], earliest_year: 1912, reaches_1940: true },
    risk: { suggestion: "High risk", basis: "b", rules: [{ id: "R1", text: "t", rows: ["F1"] }] }, citations: {}, adjoining_miles: 0.125, errors: [] };
  const s = freeSlice(r), js = JSON.stringify(s);
  assert.equal(s.findings, undefined);
  assert.ok(!js.includes("SECRET GAS STATION") && !js.includes("https://loc") && !js.includes('"F1"'));
  assert.equal(s.lists[0].bands[0], 1);
  assert.equal(s.risk.rules[0].n, 1);
});
