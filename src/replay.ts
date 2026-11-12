import { ENGINE_VERSION, Group, Mode, Rider, runRace } from "./engine.js";
import { idiv } from "./fixed.js";
import { prepareTeams, RaceSetup } from "./race.js";

/**
 * Compact replay (keyframes) for the replay viewer (core §8-2: mid-race every 10–30 s, key moments every 1 s, ~300 KB–1 MB).
 * Built from the engine's onTick hook only, so the sim core is untouched.
 *
 * Per keyframe, per rider (all integers):
 *   ds   position delta from the previous keyframe in dm (absolute in the first keyframe)
 *   slot 0 = not on the road (finished / DNF), 1–6 = body lane, 10+i = i-th rider of the pace line (lane 3)
 *   mode index into REPLAY_MODES, +16 while bonking
 *   grp  1-based index into the keyframe's group list (front first), 0 = not on the road
 * Per keyframe, per group: [head position dm, speed dm/s, riders, lane width, pace-line length]
 * Rider stats (fuel %, burst %, items) are sampled every `statEvery` seconds.
 */
export const REPLAY_FORMAT = "road-race-replay";
export const REPLAY_VERSION = 1;
export const REPLAY_MODES: Mode[] = ["sit", "block", "check", "situp", "pull", "chase", "break", "attack", "hunt", "follow", "bridge", "sprint"];

export type ReplayEventKind =
  | "attack" | "corner_attack" | "attack_fail" | "check" | "check_shed" | "bridge" | "bridge_ok" | "bridge_fail"
  | "bonk" | "bonk_recover" | "item_recovery" | "item_boost" | "drop" | "chase" | "chase_end" | "sprint" | "catch" | "finish" | "other";

export interface ReplayEvent { t: number; kind: ReplayEventKind; rider: number; team: number; text: string; }

export interface ReplayOptions {
  midEvery?: number; // keyframe interval outside key moments (s)
  statEvery?: number;
}

interface Tick {
  t: number;
  s: Int32Array; // dm
  slot: Int8Array;
  mode: Int8Array;
  grp: Int16Array;
  groups: number[][];
  bigHeads: number[]; // head position and length (mm) of the lead group and groups with >= 10 riders
}

const EVENT_RULES: [RegExp, ReplayEventKind][] = [
  [/立ち上がりアタック（/, "corner_attack"],
  [/アタック中止|行き場なし|アタックをやめる/, "attack_fail"],
  [/アタック（/, "attack"],
  [/ハンガーノックから回復/, "bonk_recover"],
  [/ハンガーノック/, "bonk"],
  [/補給食使用/, "item_recovery"],
  [/ブースト使用/, "item_boost"],
  [/振り切られた/, "check_shed"],
  [/チェック開始/, "check"],
  [/ブリッジ成功/, "bridge_ok"],
  [/ブリッジ失敗/, "bridge_fail"],
  [/ブリッジ開始/, "bridge"],
  [/集団から遅れた/, "drop"],
  [/追走開始/, "chase"],
  [/牽引の予算を使い切った/, "chase_end"],
];
const DENSE_KINDS = new Set<ReplayEventKind>(["attack", "corner_attack", "check", "check_shed", "bridge", "bridge_ok", "bonk", "drop", "sprint", "catch", "chase"]);

export function buildReplay(setup: RaceSetup, opt: ReplayOptions = {}) {
  const prm = setup.params.values;
  const course = setup.course;
  const scale = prm["scale.display_per_sim"];
  const midEvery = opt.midEvery ?? 10;
  const statEvery = opt.statEvery ?? 10;
  const { teams, plans } = prepareTeams(setup);
  const ticks: Tick[] = [];
  const stats: number[][] = []; // per stat sample: fuel, burst, rec, boost interleaved
  const statT: number[] = [];
  const detected: ReplayEvent[] = [];
  const firstSeen = new Map<number, number>();
  let prevGroupOf = new Map<Rider, number>(); // engine group id
  let prevGroupInfo = new Map<number, { s: number; n: number; esc: boolean }>();
  let prevMode = new Map<Rider, Mode>();
  let riderIdx = new Map<Rider, number>();
  let raceRiders: Rider[] = [];

  const res = runRace({
    course, prm, teams, plans,
    onTick: (t: number, riders: Rider[], groups: Group[]) => {
      if (!raceRiders.length) { raceRiders = riders; riderIdx = new Map(riders.map((r, i) => [r, i])); }
      const n = riders.length;
      const live = (r: Rider) => !r.finished && !r.dnf && !!r.g;
      const gs = groups.filter((g) => g.order.some(live)).sort((a, b) => b.s - a.s || a.id - b.id);
      const gIdx = new Map(gs.map((g, i) => [g, i + 1]));
      const tk: Tick = { t, s: new Int32Array(n), slot: new Int8Array(n), mode: new Int8Array(n), grp: new Int16Array(n), groups: [], bigHeads: [] };
      for (const g of gs) {
        const size = g.order.filter(live).length;
        tk.groups.push([idiv(g.s, 100), idiv(g.v, 100), size, g.w, g.line.length]);
        if (size >= 10 || tk.groups.length === 1) tk.bigHeads.push(g.s, g.length);
        if (!firstSeen.has(g.id)) firstSeen.set(g.id, t);
      }
      riders.forEach((r, i) => {
        tk.s[i] = idiv(r.finished ? course.length : r.sNow, 100);
        tk.mode[i] = REPLAY_MODES.indexOf(r.mode) + (r.bonk ? 16 : 0);
        if (!live(r)) return;
        const g = r.g!;
        tk.grp[i] = gIdx.get(g) ?? 0;
        if (r.bodyIdx < 0) tk.slot[i] = 10 + Math.max(0, r.lineIdx);
        else tk.slot[i] = idiv(6 - g.w, 2) + 1 + (r.bodyIdx % g.w);
      });
      ticks.push(tk);
      if (t % statEvery === 0) {
        statT.push(t);
        const row: number[] = [];
        for (const r of riders) row.push(idiv(r.G, 10_000_000), r.cap > 0 ? idiv(Math.max(0, r.W) * 100, r.cap) : 0, r.recItems, r.boostItems);
        stats.push(row);
      }
      // sprint launches and catches are not engine events; derive them from state changes
      for (const r of riders) {
        if (r.mode === "sprint" && prevMode.get(r) !== "sprint" && live(r) && (gIdx.get(r.g!) ?? 99) <= 3) {
          detected.push({ t, kind: "sprint", rider: riderIdx.get(r)!, team: r.teamIdx, text: `${r.id}: スプリント開始` });
        }
        prevMode.set(r, r.mode);
      }
      const groupOf = new Map<Rider, number>();
      const info = new Map<number, { s: number; n: number; esc: boolean }>();
      for (const g of gs) {
        const members = g.order.filter(live);
        info.set(g.id, { s: g.s, n: members.length, esc: members.some((r) => r.escS !== null) });
        const from = new Map<number, number>();
        for (const r of members) {
          groupOf.set(r, g.id);
          const pg = prevGroupOf.get(r);
          if (pg !== undefined) from.set(pg, (from.get(pg) ?? 0) + 1);
        }
        if (from.size < 2) continue;
        const parts = [...from.keys()].map((id) => ({ id, ...(prevGroupInfo.get(id) ?? { s: 0, n: 0, esc: false }) })).sort((a, b) => b.s - a.s);
        const ahead = parts[0], behind = parts[parts.length - 1];
        const age = t - (firstSeen.get(ahead.id) ?? t);
        if (ahead.n > 0 && ahead.n * 2 <= behind.n && age >= 60) {
          detected.push({ t, kind: "catch", rider: -1, team: -1, text: `${ahead.esc ? "逃げ" : "先行"} ${ahead.n}人を吸収（${members.length}人の集団に）` });
        }
      }
      prevGroupOf = groupOf;
      prevGroupInfo = info;
    },
  });

  const riders = res.riders;
  const idOf = new Map(riders.map((r, i) => [r.id, i]));
  const teamOf = new Map(teams.map((t, i) => [t.id, i]));
  const events: ReplayEvent[] = [];
  for (const e of res.events) {
    const m = /^([^:：]+): (.*)$/.exec(e.msg);
    const who = m ? m[1] : "";
    const text = m ? m[2] : e.msg;
    const kind = EVENT_RULES.find(([re]) => re.test(text))?.[1] ?? "other";
    const ri = idOf.get(who) ?? -1;
    events.push({ t: e.t, kind, rider: ri, team: ri >= 0 ? riders[ri].teamIdx : teamOf.get(who) ?? -1, text: e.msg });
  }
  events.push(...detected);
  const fin = riders.filter((r) => r.finished).sort((a, b) => a.finishMs - b.finishMs || a.idx - b.idx);
  fin.slice(0, 3).forEach((r, i) => events.push({ t: Math.ceil(r.finishMs / 1000), kind: "finish", rider: idOf.get(r.id)!, team: r.teamIdx, text: `${r.id}: ${i + 1}位でゴール` }));
  events.sort((a, b) => a.t - b.t);

  // keyframe schedule
  const T = ticks.length;
  const dense = new Uint8Array(T + 2);
  const mark = (a: number, b: number) => { for (let t = Math.max(1, a); t <= Math.min(T, b); t++) dense[t] = 1; };
  for (const e of events) if (DENSE_KINDS.has(e.kind)) mark(e.t - 2, e.t + 8);
  const finaleFrom = course.length - 1_000_000;
  for (const tk of ticks) {
    for (let i = 0; i < tk.bigHeads.length; i += 2) {
      const head = tk.bigHeads[i], len = tk.bigHeads[i + 1];
      if (head >= finaleFrom && head - len < course.length) { dense[tk.t] = 1; break; }
      if (course.corners.some((c) => head >= c.apex - 150_000 && head - len <= c.apex + 150_000)) { dense[tk.t] = 1; break; }
    }
  }
  const keep: Tick[] = [];
  for (const tk of ticks) if (tk.t === 1 || tk.t === T || tk.t % midEvery === 0 || dense[tk.t]) keep.push(tk);

  const n = riders.length;
  const prev = new Int32Array(n);
  const frames = keep.map((tk, k) => {
    const ds: number[] = new Array(n);
    for (let i = 0; i < n; i++) { ds[i] = k === 0 ? tk.s[i] : tk.s[i] - prev[i]; prev[i] = tk.s[i]; }
    return { t: tk.t, g: tk.groups.flat(), d: ds, l: Array.from(tk.slot), m: Array.from(tk.mode), q: Array.from(tk.grp) };
  });

  let alt = 0;
  const profile: number[][] = [];
  for (const sg of course.segments) { profile.push([sg.start / 1000, Math.round(alt * 10) / 10]); alt += ((sg.end - sg.start) * sg.grade) / 1e9; }
  profile.push([course.length / 1000, Math.round(alt * 10) / 10]);
  const rank = new Map(fin.map((r, i) => [r, i + 1]));

  return {
    format: REPLAY_FORMAT, version: REPLAY_VERSION,
    meta: {
      engine_version: ENGINE_VERSION, course_id: course.id, course_version: course.version, course_name: course.name, course_type: course.type,
      param_version: setup.params.version, param_checksum: setup.params.checksum, ai_seed: setup.aiSeed ?? 0, ticks: T,
      winner: fin[0]?.id ?? "", keyframes: frames.length, mid_every_s: midEvery, stat_every_s: statEvery,
    },
    params: {
      display_per_sim: scale, row_spacing_m: prm["group.row_spacing_m"] / 1000, lanes: prm["group.lanes"], rotate_s: prm["pace.rotate_s"], wait_rotate_s: prm["pace.wait_rotate_s"],
    },
    modes: REPLAY_MODES,
    course: {
      length_m: course.length / 1000,
      segments: course.segments.map((sg) => ({ from_m: sg.start / 1000, to_m: sg.end / 1000, grade_pct: sg.grade / 10_000, wind_ms: sg.wind / 1000, label: sg.label })),
      corners: course.corners.map((c) => ({
        apex_m: c.apex / 1000, radius_m: c.radius / 1000, vc_kmh: Math.round((c.vc * 3.6) / 100) / 10, zoned: c.zoned,
        no_attack_from_m: c.noAttackStart / 1000, exit_to_m: c.exitEnd / 1000, name: c.name,
      })),
      climbs: course.climbs.map((c) => ({ from_m: c.start / 1000, to_m: c.end / 1000 })),
      profile,
    },
    teams: teams.map((t, i) => ({ id: t.id, name: t.name, ai: plans[i].ai, template: plans[i].template })),
    riders: riders.map((r) => ({
      id: r.id, name: r.name, team: r.teamIdx, job: r.job, role: r.plan.role,
      finish_s: r.finished ? Math.round(r.finishMs / 100) / 10 : null, rank: rank.get(r) ?? null,
    })),
    events,
    stats: { t: statT, v: stats },
    frames,
  };
}
