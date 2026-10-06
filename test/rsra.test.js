import test from "node:test";
import assert from "node:assert/strict";
import { makeDistance, searchMiles, addrKey, riskCall } from "../api/_lib/rsra.js";
import { readFileSync } from "node:fs";

const lists = JSON.parse(readFileSync(new URL("../data/lists.json", import.meta.url))).lists;
const by = Object.fromEntries(lists.map((l) => [l.id, l]));

test("search distance is the larger of CFR and ASTM", () => {
  assert.equal(searchMiles(by.npl), 1);
  assert.equal(searchMiles(by.lust), 0.5);
  assert.equal(searchMiles(by.tanks), 0.125);          // adjoining
  assert.equal(searchMiles(by.fed_icec), 0.5);         // CFR 0.5 beats ASTM property-only
  assert.equal(searchMiles(by.erns), 0);               // property only
});

test("every list carries a citation and a source", () => {
  for (const l of lists) { assert.ok(l.cfr, l.id); assert.ok(l.source, l.id); }
});

test("distance is zero inside the parcel and measured to its edge outside", () => {
  // ~0.01 deg square around (44.97, -93.28)
  const ring = [[-93.285, 44.965], [-93.275, 44.965], [-93.275, 44.975], [-93.285, 44.975], [-93.285, 44.965]];
  const d = makeDistance({ lat: 44.97, lon: -93.28, rings: [ring] });
  assert.equal(d(-93.28, 44.97), 0);
  const east = d(-93.275 + 0.01, 44.97);               // 0.01 deg east of the east edge
  assert.ok(Math.abs(east - 0.489) < 0.01, `got ${east}`); // 0.01 deg lon at 44.97N = 0.489 mi
});

test("address keys survive the agencies' spelling differences", () => {
  assert.equal(addrKey("1629 Hennepin Avenue, Minneapolis"), addrKey("1629 HENNEPIN AVE, MINNEAPOLIS, MN, 55403"));
  assert.equal(addrKey("2600 E Lake St"), "2600 lake");
  assert.equal(addrKey("Hennepin Avenue at Washington"), null);
});

test("risk rules: on-subject leak is high; a closed leak nearby is not", () => {
  const near = [{ key: "F1", list: "lust", miles: 0.2, open: false }];
  assert.equal(riskCall(near).suggestion, "Low risk");
  assert.equal(riskCall([{ key: "F1", list: "lust", miles: 0, open: false }]).suggestion, "High risk");
  assert.equal(riskCall([{ key: "F1", list: "lust", miles: 0.3, open: true }]).suggestion, "High risk");
  assert.equal(riskCall([{ key: "F1", list: "rcra_gen", miles: 0.1, open: true }]).suggestion, "Low risk");
});
