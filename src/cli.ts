#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadCourse, validateCourse, Course } from "./course.js";
import { exportCsv, loadParamSet, ParamSet } from "./params/paramset.js";
import { validateParams } from "./params/validate.js";
import { loadPlans, TeamPlanInput } from "./plans.js";
import { loadRoster, Roster } from "./roster.js";
import { fmtGap, fmtTime, RaceReport, simulate } from "./race.js";
import { renderHtml } from "./html.js";
import { csvLine } from "./csv.js";

interface Args { _: string[]; [k: string]: string | string[] | boolean | undefined; }

function parseArgs(argv: string[]): Args {
  const a: Args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x.startsWith("--")) {
      const key = x.slice(2);
      const nxt = argv[i + 1];
      const val: string | boolean = nxt === undefined || nxt.startsWith("--") ? true : (i++, nxt);
      const prev = a[key];
      if (prev === undefined) a[key] = val;
      else a[key] = [...(Array.isArray(prev) ? prev : [String(prev)]), String(val)];
    } else a._.push(x);
  }
  return a;
}
const str = (a: Args, k: string, d?: string): string | undefined => { const v = a[k]; return v === undefined ? d : Array.isArray(v) ? v[v.length - 1] : String(v); };
const list = (a: Args, k: string): string[] => { const v = a[k]; return v === undefined ? [] : (Array.isArray(v) ? v : [String(v)]).flatMap((s) => s.split(",")).filter(Boolean); };
const int = (a: Args, k: string, d: number) => { const v = str(a, k); return v === undefined ? d : parseInt(v, 10); };

const USAGE = `ロードレース・シミュレーター（試作） ${"" }
使い方:
  racesim run      --course <course.json> --roster <roster.csv> [--plans <file|dir> ...] [--params <params.csv>] [--out <dir>]
                   [--teams 50] [--ai-seed 0] [--log-every 1] [--no-log] [--no-html]
  racesim compare  --course ... --roster ... [--plans ...] --params <A.csv> --params-b <B.csv> [--out <dir>]
  racesim batch    --courses <c1.json,c2.json> --races 20 [--roster <roster.csv>] [--plans-dir samples/plans]
                   [--params <A.csv>] [--params-b <B.csv>] [--out <dir>]
  racesim params validate --params <params.csv> [--base <previous.csv>] [--course <course.json>]
  racesim params export   [--params <params.csv>] --out <file.csv>     既定値（または指定ファイル）を全キー付きCSVで書き出す
`;

function loadParamsChecked(path: string | undefined, label = "params"): ParamSet {
  const ps = loadParamSet(path ?? null);
  const v = validateParams(ps);
  if (v.errors.length) {
    console.error(`パラメータセット（${label}: ${ps.source}）の検証エラー:`);
    for (const e of v.errors) console.error("  " + e);
    process.exit(2);
  }
  for (const w of v.warnings) console.error(`  ${label}: ${w}`);
  return ps;
}

function loadInputs(a: Args, ps: ParamSet): { course: Course; roster: Roster; plans: TeamPlanInput[]; plansChecksum: string } {
  const cp = str(a, "course");
  const rp = str(a, "roster");
  if (!cp || !rp) { console.error(USAGE); process.exit(1); }
  const course = loadCourse(cp, ps.values);
  for (const w of validateCourse(course, ps.values)) console.error("  " + w);
  const roster = loadRoster(rp);
  const pl = list(a, "plans");
  const { plans, checksum } = pl.length ? loadPlans(pl) : { plans: [], checksum: "" };
  return { course, roster, plans, plansChecksum: checksum };
}

function summaryText(rep: RaceReport, n = 20): string {
  const L: string[] = [];
  const m = rep.meta;
  L.push(`コース: ${m.course_id} v${m.course_version}（${m.course_type}、表示 ${m.course_display_km} km、T_ref ${m.t_ref_s}秒）`);
  L.push(`パラメータ: 版 ${m.param_version}（${m.param_status}、checksum ${m.param_checksum}、${m.param_source}） / エンジン ${m.engine_version}`);
  L.push(`出走: ${m.teams}チーム ${m.riders}人 / 計算 ${rep.metrics.compute_ms} ms / ${m.ticks} tick`);
  const o = rep.outcome;
  const typeJa = o.type === "breakaway" ? "逃げ切り" : o.type === "late_attack" ? "終盤のアタック" : "集団・小集団ゴール";
  L.push(`勝者: ${o.winner}（${o.winner_team}・${o.winner_job}） → ${typeJa}${o.escape_from_km !== null ? `（表示 ${o.escape_from_km} km から先行）` : ""}、先頭集団 ${o.lead_group_size}人、2位との差 ${(o.margin_ms / 1000).toFixed(1)}秒`);
  L.push("");
  L.push(" 順位  選手        チーム  脚質        役割       タイム        差（実）   差（集団）");
  for (const r of rep.ranking.slice(0, n)) {
    L.push(`${String(r.rank).padStart(4)}  ${r.rider_id.padEnd(10)}  ${r.team_id.padEnd(6)}  ${r.job.padEnd(10)}  ${r.role.padEnd(9)}  ${r.status === "finished" ? fmtTime(r.time_ms) : "DNF".padEnd(11)}  ${fmtGap(r.gap_ms).padStart(9)}  ${fmtGap(r.group_gap_ms).padStart(9)}`);
  }
  const mt = rep.metrics;
  L.push("");
  L.push(`指標: 完走 ${mt.finishers} / DNF ${mt.dnf} / ハンガーノック ${mt.bonk_riders}人 / 集団から遅れた ${mt.dropped_riders}人 / アタック ${mt.attacks}回（立ち上がり ${mt.corner_attacks}、行き場なし ${mt.no_lane}） / 上位10人のスプリント平均 ${mt.sprint_avg_s_top10}秒`);
  return L.join("\n");
}

function writeOutputs(dir: string, rep: RaceReport, html: boolean) {
  mkdirSync(dir, { recursive: true });
  const { trace, ...rest } = rep;
  writeFileSync(join(dir, "result.json"), JSON.stringify(rest, null, 1));
  writeFileSync(join(dir, "ranking.csv"), [csvLine(["rank", "rider_id", "name", "team_id", "job", "role", "status", "time", "time_ms", "gap_s", "group_gap_s", "escape_from_km"]),
    ...rep.ranking.map((r) => csvLine([r.rank, r.rider_id, r.name, r.team_id, r.job, r.role, r.status, r.status === "finished" ? fmtTime(r.time_ms) : "", r.time_ms, (r.gap_ms / 1000).toFixed(1), (r.group_gap_ms / 1000).toFixed(1), r.escape_from_km ?? ""]))].join("\n") + "\n");
  const cols = ["rider_id", "team_id", "job", "role", "ai", "fuel_used_pct", "fuel_end_pct", "burst_used_kj", "bonks", "recovery_used", "boost_used", "recovery_left", "boost_left", "attacks", "corner_attacks", "attacks_no_lane", "attacks_no_legs", "checks", "checks_shed", "drops", "pull_s", "sprint_s"] as const;
  writeFileSync(join(dir, "riders.csv"), [csvLine([...cols]), ...rep.riders.map((r) => csvLine(cols.map((c) => String(r[c]))))].join("\n") + "\n");
  writeFileSync(join(dir, "summary.txt"), summaryText(rep, 50) + "\n\n" + (rep.messages.length ? "作戦の注意:\n" + rep.messages.map((m) => "  " + m).join("\n") + "\n" : ""));
  if (html && trace) writeFileSync(join(dir, "view.html"), renderHtml(rep));
}

function cmdRun(a: Args) {
  const ps = loadParamsChecked(str(a, "params"));
  const inp = loadInputs(a, ps);
  const out = str(a, "out", "out/run")!;
  mkdirSync(out, { recursive: true });
  const rep = simulate({
    ...inp, params: ps, teamCount: int(a, "teams", 50), aiSeed: int(a, "ai-seed", 0), aiRotation: int(a, "ai-rotation", 0),
    logPath: a["no-log"] ? null : join(out, "log.csv"), logEvery: int(a, "log-every", 1), traceEvery: a["no-html"] ? 0 : 10,
  });
  writeOutputs(out, rep, !a["no-html"]);
  console.log(summaryText(rep));
  if (rep.messages.length) { console.log("\n作戦の注意:"); for (const m of rep.messages.slice(0, 30)) console.log("  " + m); }
  console.log(`\n出力: ${out}/（result.json, ranking.csv, riders.csv, summary.txt${a["no-log"] ? "" : ", log.csv"}${a["no-html"] ? "" : ", view.html"}）`);
}

function cmdCompare(a: Args) {
  const pa = loadParamsChecked(str(a, "params"), "A");
  const pb = loadParamsChecked(str(a, "params-b"), "B");
  const vb = validateParams(pb, pa);
  for (const w of vb.warnings.filter((x) => x.startsWith("[変更]"))) console.log("  " + w);
  const inp = loadInputs(a, pa);
  const inpB = { ...inp, course: loadCourse(str(a, "course")!, pb.values) };
  const opt = { teamCount: int(a, "teams", 50), aiSeed: int(a, "ai-seed", 0), aiRotation: int(a, "ai-rotation", 0), logPath: null, traceEvery: 0 };
  const A = simulate({ ...inp, params: pa, ...opt });
  const B = simulate({ ...inpB, params: pb, ...opt });
  const rankB = new Map(B.ranking.map((r) => [r.rider_id, r]));
  const lines: string[] = [];
  lines.push(`ドライラン比較: A = 版 ${pa.version}（${pa.source}） / B = 版 ${pb.version}（${pb.source}）`);
  const typeJa = (t: string) => (t === "breakaway" ? "逃げ切り" : t === "late_attack" ? "終盤アタック" : "集団");
  lines.push(`勝者: A ${A.outcome.winner}（${typeJa(A.outcome.type)}） / B ${B.outcome.winner}（${typeJa(B.outcome.type)}）`);
  let changed = 0;
  for (const r of A.ranking) if (rankB.get(r.rider_id)?.rank !== r.rank) changed++;
  lines.push(`順位が変わった選手: ${changed} / ${A.ranking.length}人`);
  lines.push("");
  lines.push(" A順位  選手        B順位   変化   A差（集団）  B差（集団）");
  for (const r of A.ranking.slice(0, int(a, "top", 20))) {
    const b = rankB.get(r.rider_id)!;
    const d = r.rank - b.rank;
    lines.push(`${String(r.rank).padStart(5)}  ${r.rider_id.padEnd(10)}  ${String(b.rank).padStart(5)}  ${(d > 0 ? "↑" + d : d < 0 ? "↓" + -d : "→").padStart(5)}  ${fmtGap(r.group_gap_ms).padStart(10)}  ${fmtGap(b.group_gap_ms).padStart(10)}`);
  }
  const movers = A.ranking.map((r) => ({ id: r.rider_id, a: r.rank, b: rankB.get(r.rider_id)!.rank })).sort((x, y) => Math.abs(y.a - y.b) - Math.abs(x.a - x.b) || x.a - y.a).slice(0, 5);
  lines.push("");
  lines.push("順位の変化が大きい選手: " + movers.map((m) => `${m.id} ${m.a}→${m.b}`).join(", "));
  const mk = (x: RaceReport) => x.metrics;
  const keys = ["finishers", "bonk_riders", "dropped_riders", "attacks", "no_lane", "sprint_avg_s_top10", "compute_ms"] as const;
  lines.push("指標（A → B）: " + keys.map((k) => `${k} ${mk(A)[k]} → ${mk(B)[k]}`).join(" / "));
  const text = lines.join("\n");
  console.log(text);
  const out = str(a, "out");
  if (out) {
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "compare.txt"), text + "\n");
    writeOutputs(join(out, "A"), A, false);
    writeOutputs(join(out, "B"), B, false);
    console.log(`\n出力: ${out}/compare.txt, ${out}/A/, ${out}/B/`);
  }
}

interface BatchRow { course: string; type: string; race: number; winner: string; job: string; outcome: string; esc_km: number | null; lead: number; bonks: number; dropped: number; sprint_s: number; ms: number; }

function runBatch(courses: string[], races: number, ps: ParamSet, roster: Roster | null, plansDir: string | undefined, teams: number): BatchRow[] {
  const rows: BatchRow[] = [];
  for (const cpath of courses) {
    const course = loadCourse(cpath, ps.values);
    let plans: TeamPlanInput[] = [], pcs = "";
    const pdir = plansDir ? join(plansDir, course.id) : null;
    if (pdir && existsSync(pdir)) ({ plans, checksum: pcs } = loadPlans([pdir]));
    for (let i = 0; i < races; i++) {
      const rep = simulate({ course, params: ps, roster: roster ?? { teams: [], checksum: "" }, plans, plansChecksum: pcs, teamCount: teams, aiSeed: i + 1, aiRotation: i, logPath: null, traceEvery: 0 });
      rows.push({ course: course.id, type: course.type, race: i + 1, winner: rep.outcome.winner, job: rep.outcome.winner_job, outcome: rep.outcome.type, esc_km: rep.outcome.escape_from_km, lead: rep.outcome.lead_group_size, bonks: rep.metrics.bonk_riders, dropped: rep.metrics.dropped_riders, sprint_s: rep.metrics.sprint_avg_s_top10, ms: rep.metrics.compute_ms });
      process.stderr.write(`  ${course.id} #${i + 1}: ${rep.outcome.winner} ${rep.outcome.type}\n`);
    }
  }
  return rows;
}

function batchSummary(rows: BatchRow[], label: string): string[] {
  const L: string[] = [];
  const byCourse = new Map<string, BatchRow[]>();
  for (const r of rows) byCourse.set(r.course, [...(byCourse.get(r.course) ?? []), r]);
  const target = (type: string) => (type === "flat" ? "目標 20〜30%" : "目標 約40%");
  for (const [c, rs] of byCourse) {
    const n = rs.length;
    const pct = (f: (r: BatchRow) => boolean) => Math.round((rs.filter(f).length * 1000) / n) / 10;
    const jobs = new Map<string, number>();
    for (const r of rs) jobs.set(r.job, (jobs.get(r.job) ?? 0) + 1);
    const avg = (f: (r: BatchRow) => number) => Math.round((rs.reduce((a, r) => a + f(r), 0) * 10) / n) / 10;
    L.push(`[${label}] ${c}（${rs[0].type}、${n}レース）: 逃げ切り ${pct((r) => r.outcome === "breakaway")}%（${target(rs[0].type)}） / 終盤アタック ${pct((r) => r.outcome === "late_attack")}% / 集団 ${pct((r) => r.outcome === "group")}%`);
    L.push(`      勝者の脚質: ${[...jobs].sort((a, b) => b[1] - a[1]).map(([j, k]) => `${j} ${k}`).join(", ")} / 先頭集団 平均${avg((r) => r.lead)}人 / ハンガーノック 平均${avg((r) => r.bonks)}人 / 遅れた選手 平均${avg((r) => r.dropped)}人 / スプリント平均 ${avg((r) => r.sprint_s)}秒 / 計算 平均${avg((r) => r.ms)}ms`);
  }
  return L;
}

function cmdBatch(a: Args) {
  const courses = list(a, "courses");
  if (!courses.length) { console.error(USAGE); process.exit(1); }
  const races = int(a, "races", 20);
  const rp = str(a, "roster");
  const roster = rp ? loadRoster(rp) : null;
  const teams = int(a, "teams", 50);
  const pa = loadParamsChecked(str(a, "params"), "A");
  const rowsA = runBatch(courses, races, pa, roster, str(a, "plans-dir"), teams);
  const lines = batchSummary(rowsA, `A v${pa.version}`);
  let rowsB: BatchRow[] = [];
  if (str(a, "params-b")) {
    const pb = loadParamsChecked(str(a, "params-b"), "B");
    rowsB = runBatch(courses, races, pb, roster, str(a, "plans-dir"), teams);
    lines.push(...batchSummary(rowsB, `B v${pb.version}`));
    let diff = 0;
    rowsA.forEach((r, i) => { if (rowsB[i].winner !== r.winner) diff++; });
    lines.push(`A と B で勝者が変わったレース: ${diff} / ${rowsA.length}`);
  }
  console.log(lines.join("\n"));
  const out = str(a, "out");
  if (out) {
    mkdirSync(out, { recursive: true });
    const cols = ["course", "type", "race", "winner", "job", "outcome", "esc_km", "lead", "bonks", "dropped", "sprint_s", "ms"] as const;
    const dump = (rs: BatchRow[]) => [csvLine([...cols]), ...rs.map((r) => csvLine(cols.map((c) => String(r[c] ?? ""))))].join("\n") + "\n";
    writeFileSync(join(out, "batch_A.csv"), dump(rowsA));
    if (rowsB.length) writeFileSync(join(out, "batch_B.csv"), dump(rowsB));
    writeFileSync(join(out, "batch_summary.txt"), lines.join("\n") + "\n");
    console.log(`\n出力: ${out}/`);
  }
}

function cmdParams(a: Args) {
  const sub = a._[1];
  if (sub === "validate") {
    const ps = loadParamSet(str(a, "params") ?? null);
    const base = str(a, "base") ? loadParamSet(str(a, "base")!) : null;
    const v = validateParams(ps, base);
    if (str(a, "course")) v.warnings.push(...validateCourse(loadCourse(str(a, "course")!, ps.values), ps.values));
    console.log(`パラメータセット: ${ps.source} / 版 ${ps.version} / status ${ps.status} / checksum ${ps.checksum}`);
    for (const e of v.errors) console.log("  エラー " + e);
    for (const w of v.warnings) console.log("  " + w);
    console.log(v.errors.length ? `→ 公開できません（エラー ${v.errors.length}件）` : `→ OK（警告 ${v.warnings.length}件）`);
    process.exit(v.errors.length ? 2 : 0);
  } else if (sub === "export") {
    const ps = loadParamSet(str(a, "params") ?? null);
    const out = str(a, "out");
    const csv = exportCsv(ps.values, { version: ps.version, parentVersion: ps.parentVersion, status: ps.status, note: ps.note });
    if (out) { writeFileSync(out, csv); console.log(`書き出しました: ${out}`); } else process.stdout.write(csv);
  } else {
    console.error(USAGE);
    process.exit(1);
  }
}

const args = parseArgs(process.argv.slice(2));
try {
  switch (args._[0]) {
    case "run": cmdRun(args); break;
    case "compare": cmdCompare(args); break;
    case "batch": cmdBatch(args); break;
    case "params": cmdParams(args); break;
    default: console.log(USAGE);
  }
} catch (e) {
  console.error("エラー: " + (e as Error).message);
  if (process.env.RACESIM_DEBUG) console.error((e as Error).stack);
  process.exit(1);
}
