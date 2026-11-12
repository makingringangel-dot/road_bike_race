#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { gzipSync } from "node:zlib";
import { loadCourse } from "./course.js";
import { loadParamSet } from "./params/paramset.js";
import { validateParams } from "./params/validate.js";
import { loadPlans } from "./plans.js";
import { loadRoster } from "./roster.js";
import { buildReplay } from "./replay.js";

const USAGE = `リプレイ（キーフレーム）の書き出し
使い方:
  node dist/src/replay-cli.js --course <course.json> --out <replay.json|replay.json.gz>
      [--roster <roster.csv>] [--plans <file|dir> ...] [--params <params.csv>] [--teams 50] [--ai-seed 0]
      [--mid-every 10]   勝負所以外のキーフレームの間隔（秒）`;

const argv = process.argv.slice(2);
const opt = new Map<string, string[]>();
for (let i = 0; i < argv.length; i++) {
  if (!argv[i].startsWith("--")) continue;
  const k = argv[i].slice(2);
  const v = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
  opt.set(k, [...(opt.get(k) ?? []), v]);
}
const one = (k: string) => opt.get(k)?.at(-1);
const course = one("course"), out = one("out");
if (!course || !out) { console.error(USAGE); process.exit(1); }

const params = loadParamSet(one("params") ?? null);
const v = validateParams(params);
if (v.errors.length) { console.error("パラメータの検証エラー:\n  " + v.errors.join("\n  ")); process.exit(2); }
const c = loadCourse(course, params.values);
const roster = one("roster") ? loadRoster(one("roster")!) : { teams: [], checksum: "" };
const planPaths = (opt.get("plans") ?? []).flatMap((s) => s.split(",")).filter(Boolean);
const { plans, checksum } = planPaths.length ? loadPlans(planPaths) : { plans: [], checksum: "" };
const t0 = Date.now();
const rep = buildReplay(
  { course: c, params, roster, plans, plansChecksum: checksum, teamCount: parseInt(one("teams") ?? "50", 10), aiSeed: parseInt(one("ai-seed") ?? "0", 10), logPath: null, traceEvery: 0 },
  { midEvery: parseInt(one("mid-every") ?? "10", 10) },
);
const json = JSON.stringify(rep);
const gz = gzipSync(json, { level: 9 });
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, out.endsWith(".gz") ? gz : json);
console.log(`${out}: キーフレーム ${rep.frames.length}枚 / ${rep.meta.ticks}秒、イベント ${rep.events.length}件、JSON ${(json.length / 1024).toFixed(0)} KB（gzip ${(gz.length / 1024).toFixed(0)} KB）、${Date.now() - t0} ms`);
