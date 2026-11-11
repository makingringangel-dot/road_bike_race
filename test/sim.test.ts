import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expNegPpm, idiv, isqrt, mulDiv, parseDecimal, PPM } from "../src/fixed.js";
import { loadParamSet } from "../src/params/paramset.js";
import { validateParams } from "../src/params/validate.js";
import { loadCourse } from "../src/course.js";
import { loadRoster } from "../src/roster.js";
import { loadPlans } from "../src/plans.js";
import { simulate } from "../src/race.js";

const tmp = mkdtempSync(join(tmpdir(), "racesim-"));

test("fixed-point helpers are exact", () => {
  assert.equal(idiv(-7, 2), -4);
  assert.equal(idiv(7, 2), 3);
  assert.equal(isqrt(99), 9);
  assert.equal(isqrt(100), 10);
  assert.equal(mulDiv(2 ** 40, 2 ** 20, 2 ** 30), 2 ** 30);
  assert.equal(parseDecimal("1.25", 1000), 1250);
  assert.equal(parseDecimal("0.000001", PPM), 1);
  assert.throws(() => parseDecimal("0.0001", 1000));
  assert.equal(expNegPpm(0), PPM);
  assert.ok(expNegPpm(PPM) > 367_000 && expNegPpm(PPM) < 368_500);
});

test("parameter validation rejects out-of-range and unknown keys", () => {
  const p = join(tmp, "bad.csv");
  const base = readFileSync("samples/params/params-v1.csv", "utf8");
  writeFileSync(p, base.replace(/^ai\.alpha_normal,1\.5,/m, "ai.alpha_normal,20,") + "no.such_key,1\n");
  const v = validateParams(loadParamSet(p));
  assert.ok(v.errors.some((e) => e.includes("ai.alpha_normal")), v.errors.join("\n"));
  assert.ok(v.errors.some((e) => e.includes("no.such_key")), v.errors.join("\n"));
});

test("sample parameter sets validate", () => {
  for (const f of ["samples/params/params-v1.csv", "samples/params/params-v2.csv"]) {
    const v = validateParams(loadParamSet(f));
    assert.deepEqual(v.errors, [], f);
  }
});

function runOnce(courseFile: string, logPath: string | null) {
  const params = loadParamSet("samples/params/params-v2.csv");
  const course = loadCourse(courseFile, params.values);
  const roster = loadRoster("samples/roster.csv");
  const { plans, checksum } = loadPlans([`samples/plans/${course.id}`]);
  return simulate({ course, params, roster, plans, plansChecksum: checksum, teamCount: 50, logPath, traceEvery: 0 });
}

test("same inputs give an identical race (determinism) and a full 300-rider field", () => {
  const la = join(tmp, "a.csv"), lb = join(tmp, "b.csv");
  const a = runOnce("samples/courses/flat-coast.json", la);
  const b = runOnce("samples/courses/flat-coast.json", lb);
  assert.equal(a.ranking.length, 300);
  assert.deepEqual(a.ranking.map((r) => [r.rider_id, r.time_ms]), b.ranking.map((r) => [r.rider_id, r.time_ms]));
  assert.equal(readFileSync(la, "utf8"), readFileSync(lb, "utf8"));
  assert.equal(a.meta.param_version, 2);
  assert.equal(a.ranking[0].rank, 1);
});

test("a pin inside a corner's no-attack zone is rejected with a message", () => {
  const r = runOnce("samples/courses/mountain-pass.json", null);
  assert.ok(r.messages.some((m) => m.includes("コーナー前はアタックできません")), r.messages.join("\n"));
});
