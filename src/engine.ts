// Deterministic race engine. 1 s ticks, integer state, fixed processing order
// (groups by position then id; riders by index). See docs in README for the model.
import { clamp, expNegPpm, idiv, mulDiv, mulP, PPM, smoothstep } from "./fixed.js";
import { Course, Corner, segmentAt, zoneAt } from "./course.js";
import { accel, aeroCoef, pNeed } from "./physics.js";
import { AttackKind, AttackPin, BridgePin, CheckPin, ChasePolicy, Pin, RiderPlan, TeamPlan } from "./plans.js";
import { derivePhys, RiderInput, RiderPhys, TeamInput } from "./roster.js";
import type { Job } from "./params/definitions.js";

export const ENGINE_VERSION = "0.1.0";
const FUEL_FULL = 1_000_000_000;

export type Mode = "sit" | "block" | "check" | "situp" | "pull" | "chase" | "break" | "attack" | "hunt" | "follow" | "bridge" | "sprint";
const PACER: ReadonlySet<Mode> = new Set<Mode>(["pull", "chase", "break", "attack", "hunt", "bridge", "sprint"]);
const NO_LEAD: ReadonlySet<Mode> = new Set<Mode>(["check", "block", "follow", "situp"]);

export interface RiderStats {
  fuelUsed: number; // fuel units (1e9 = 100%)
  burstUsed: number; // mJ
  bonks: number;
  recUsed: number;
  boostUsed: number;
  attacks: number;
  cornerAttacks: number;
  attacksNoLane: number;
  attacksNoLegs: number;
  attackDelayS: number;
  checks: number;
  checksShedded: number;
  drops: number;
  pullS: number;
  sprintS: number;
  moveUps: number;
}

interface Pending {
  kind: "attack" | "bridge";
  pin: AttackPin | BridgePin;
  sinceS: number;
  sinceT: number;
  strict: boolean; // corner (exit-zone) attack window
  cornerWait: number | null; // waiting for this corner's apex (D45)
  fromWait: boolean;
  windowUntil: number;
}

export interface Rider {
  idx: number;
  id: string;
  name: string;
  teamIdx: number;
  job: Job;
  iq: number;
  input: RiderInput;
  ph: RiderPhys;
  plan: RiderPlan;
  g: Group | null;
  finished: boolean;
  finishMs: number;
  dnf: boolean;
  W: number; // mJ
  wUsed: number;
  cap: number;
  G: number; // fuel units
  bonk: boolean;
  c: number; // climb accumulator, µs
  recLeft: number; // seconds of recovery effect queued
  boostLeft: number;
  recItems: number;
  boostItems: number;
  mode: Mode;
  P: number; // pedalled power mW (this tick)
  J: number; // ppm
  k: number; // ppm
  atk: { kind: AttackKind; until: number; onCheck: "stop" | "continue" } | null;
  lastOnCheck: "stop" | "continue";
  followedSince: number | null;
  pend: Pending | null;
  huntPending: { target: Rider; at: number; boost: boolean } | null;
  hunt: Rider | null;
  follow: Rider | null;
  bridge: Rider | null;
  situp: boolean;
  spr: { t: number } | null;
  lag: number; // mm behind formation slot
  u: number; // speed relative to group, mm/s
  dropUntil: number;
  dropFrom: number;
  launchFrom: number;
  escS: number | null; // sim position where the current escape began
  pinDone: boolean[];
  moving: boolean;
  offset: number; // mm behind group head
  sNow: number;
  bodyIdx: number; // -1 when in the pace line
  lineIdx: number;
  st: RiderStats;
  events: string[];
}

export interface Group {
  id: number;
  order: Rider[];
  s: number; // head position mm
  v: number; // mm/s
  vHist: number[];
  nextCorner: number;
  braking: boolean;
  vCruise: number;
  exitTarget: number;
  exitUntil: number;
  accCool: number;
  // formation of this tick
  line: Rider[];
  body: Rider[];
  front: Rider | null; // exposed front when there is no pace line
  soft: boolean;
  w: number;
  length: number;
}

interface TeamState {
  idx: number;
  input: TeamInput;
  plan: TeamPlan;
  policy: ChasePolicy;
  chasing: boolean;
  chaseGroup: number;
  budgetUsed: number;
  exhausted: boolean;
  chaseStarts: number;
  riders: Rider[];
}

export interface LogRow {
  t: number; rider: Rider; group: Group; gapMs: number;
}

export interface RaceOptions {
  course: Course;
  prm: Record<string, number>;
  teams: TeamInput[];
  plans: TeamPlan[];
  onTick?: (t: number, riders: Rider[], groups: Group[], leaderS: number) => void;
}

export interface RaceResult {
  riders: Rider[];
  teams: TeamState[];
  ticks: number;
  events: { t: number; msg: string }[];
}

export function runRace(opt: RaceOptions): RaceResult {
  const { course, prm } = opt;
  const P = prm;
  const scale = P["scale.display_per_sim"];
  const L = course.length;
  const gMm = P["physics.g"];
  const rho = P["physics.rho"];
  const vMax = P["physics.v_max_descent_ms"];
  const vMinA = P["physics.v_min_accel_ms"];
  const brake = P["physics.brake_ms2"];
  const spacing = P["group.row_spacing_m"]; // mm
  const gapMs = P["group.gap_s"]; // ms
  const lineMax = P["group.paceline_max"];
  const lanes = P["group.lanes"];
  const KG = idiv(FUEL_FULL * 1000, P["stamina.fuel_coefficient"] * course.tRefS); // fuel units per s at P = CP, s_G = 1
  const fuelLow = mulDiv(FUEL_FULL, P["stamina.fuel_low_pct"], 100_000);
  const bonkRecover = mulDiv(FUEL_FULL, P["stamina.bonk_recover_pct"], 100_000);
  const recRate = idiv(mulDiv(FUEL_FULL, P["item.recovery_amount_pct"], 100_000), P["item.recovery_duration_s"]);
  const events: { t: number; msg: string }[] = [];
  const toPpm = (x1000: number) => x1000 * 1000;
  const kLine = [P["draft.k_line1"], P["draft.k_line2"], P["draft.k_line3"]].map(toPpm);
  const kLine46 = toPpm(P["draft.k_line4_6"]);
  const kRow1 = toPpm(P["draft.k_body_row1"]), kRow2 = toPpm(P["draft.k_body_row2"]), kMid = toPpm(P["draft.k_body_mid"]), kRear = toPpm(P["draft.k_body_rear"]);
  const rearFrac = toPpm(P["draft.rear_fraction"]);
  const kMoving = toPpm(P["draft.k_moving"]);
  const kWheel = toPpm(P["check.wheel_k"]);
  const attackF: Record<AttackKind, number> = { sharp: toPpm(P["attack.sharp_f"]), standard: toPpm(P["attack.standard_f"]), long: toPpm(P["attack.long_f"]) };
  const attackS: Record<AttackKind, number> = { sharp: P["attack.sharp_s"], standard: P["attack.standard_s"], long: P["attack.long_s"] };
  const boostF = toPpm(P["item.boost_power_factor"]);
  const remDisp = (s: number) => (L - s) * scale; // display mm remaining

  // ---------- riders ----------
  const riders: Rider[] = [];
  const teams: TeamState[] = [];
  opt.teams.forEach((t, ti) => {
    const plan = opt.plans[ti];
    const ts: TeamState = { idx: ti, input: t, plan, policy: plan.chasePolicy, chasing: false, chaseGroup: -1, budgetUsed: 0, exhausted: false, chaseStarts: 0, riders: [] };
    teams.push(ts);
    for (const ri of t.riders) {
      const ph = derivePhys(ri, P);
      const rp = plan.riders.get(ri.id)!;
      const r: Rider = {
        idx: riders.length, id: ri.id, name: ri.name, teamIdx: ti, job: ri.job, iq: ri.iq, input: ri, ph, plan: rp,
        g: null, finished: false, finishMs: 0, dnf: false,
        W: ph.wmax, wUsed: 0, cap: ph.wmax, G: FUEL_FULL, bonk: false, c: 0, recLeft: 0, boostLeft: 0,
        recItems: rp.recovery, boostItems: rp.boost, mode: "sit", P: 0, J: PPM, k: PPM,
        atk: null, lastOnCheck: "stop", followedSince: null, pend: null, huntPending: null, hunt: null, follow: null, bridge: null, situp: false, spr: null,
        lag: 0, u: 0, dropUntil: 0, dropFrom: -1, launchFrom: -1, escS: null, pinDone: rp.pins.map(() => false), moving: false,
        offset: 0, sNow: 0, bodyIdx: 0, lineIdx: -1,
        st: { fuelUsed: 0, burstUsed: 0, bonks: 0, recUsed: 0, boostUsed: 0, attacks: 0, cornerAttacks: 0, attacksNoLane: 0, attacksNoLegs: 0, attackDelayS: 0, checks: 0, checksShedded: 0, drops: 0, pullS: 0, sprintS: 0, moveUps: 0 },
        events: [],
      };
      riders.push(r);
      ts.riders.push(r);
    }
  });
  const ev = (t: number, r: Rider | null, msg: string) => {
    const m = r ? `${r.id}: ${msg}` : msg;
    events.push({ t, msg: m });
    if (r) r.events.push(`${t}s ${msg}`);
  };

  // ---------- groups ----------
  let nextGroupId = 1;
  const groups: Group[] = [];
  const newGroup = (order: Rider[], s: number, v: number): Group => {
    let nc = 0;
    while (nc < course.corners.length && course.corners[nc].apex <= s) nc++;
    const g: Group = { id: nextGroupId++, order, s, v, vHist: [v], nextCorner: nc, braking: false, vCruise: v, exitTarget: 0, exitUntil: 0, accCool: 0, line: [], body: [], front: null, soft: false, w: 1, length: 0 };
    for (const r of order) r.g = g;
    groups.push(g);
    return g;
  };
  const active = (r: Rider) => !r.finished && !r.dnf;

  // ---------- per-rider helpers ----------
  const cpEff = (r: Rider): number => {
    if (r.bonk) return mulP(r.ph.cp, toPpm(P["stamina.bonk_cp_factor"]));
    if (r.G >= fuelLow) return r.ph.cp;
    const lo = toPpm(P["stamina.fuel_low_cp_min"]);
    return mulP(r.ph.cp, lo + mulDiv(PPM - lo, r.G, fuelLow));
  };
  const attackPower = (r: Rider, kind: AttackKind) => { const ce = cpEff(r); return ce + mulP(r.ph.pmax - ce, attackF[kind]); };
  const nominalPower = (r: Rider) => (r.atk ? attackPower(r, r.atk.kind) : mulP(cpEff(r), toPpm(P["pace.solo_factor"])));
  const useBoost = (t: number, r: Rider) => {
    if (r.boostItems > 0 && r.boostLeft === 0) { r.boostItems--; r.boostLeft = P["item.boost_duration_s"]; r.st.boostUsed++; ev(t, r, "ブースト使用"); }
  };
  const useRecovery = (t: number, r: Rider, why: string) => {
    if (r.recItems > 0) { r.recItems--; r.recLeft += P["item.recovery_duration_s"]; r.st.recUsed++; ev(t, r, `補給食使用（${why}）`); }
  };
  const computeJ = (r: Rider, grade: number, s: number): number => {
    const w = smoothstep(P["job.w_grade_lo"], P["job.w_grade_hi"], grade);
    // c += w·dt − (1 − w)·c/decay·dt  (c in µs)
    r.c += w - idiv(mulDiv(PPM - w, r.c, PPM) * 1000, P["job.c_decay_s"]);
    if (r.c < 0) r.c = 0;
    const u = PPM - smoothstep(P["job.u_dist_lo_m"], P["job.u_dist_hi_m"], remDisp(s));
    const xL = idiv(r.c * 1000, P["job.tau_long_s"]); // c/τL in ppm  (c µs, τ ms)
    const xS = idiv(r.c * 1000, P["job.tau_short_s"]);
    const climbT = mulP(r.ph.jobA, PPM - expNegPpm(xL)) + mulP(r.ph.jobB, expNegPpm(xS));
    const flatT = mulP(r.ph.jobF, PPM - u) + mulP(r.ph.jobS, u);
    return PPM + mulP(w, climbT) + mulP(PPM - w, flatT);
  };
  const burn = (r: Rider, Pw: number, t: number) => {
    const ce = cpEff(r);
    if (Pw > ce) {
      const d = Math.min(Pw - ce, r.W);
      r.W -= d;
      r.wUsed += d;
      r.st.burstUsed += d;
    } else {
      let rec = mulDiv(mulDiv(ce - Pw, PPM, ce), idiv(r.ph.wmax * 1000, r.ph.tauMs), PPM);
      if (r.bonk) rec = mulP(rec, toPpm(P["stamina.bonk_burst_recovery"]));
      if (r.recLeft > 0) rec = mulP(rec, toPpm(P["item.recovery_burst_bonus"]));
      r.W += rec;
    }
    const fatigueFrac = Math.min(PPM, mulDiv(r.wUsed, PPM, mulP(r.ph.wmax, toPpm(P["stamina.fatigue_full_multiple"]))));
    r.cap = mulP(r.ph.wmax, PPM - mulP(r.ph.fatigue, fatigueFrac));
    if (r.W > r.cap) r.W = r.cap;
    // fuel
    const use = mulDiv(mulP(KG, r.ph.sG), Pw, r.ph.cp);
    r.G -= use;
    r.st.fuelUsed += use;
    if (r.recLeft > 0) { r.G += recRate; r.recLeft--; }
    if (r.G > FUEL_FULL) r.G = FUEL_FULL;
    if (r.G <= 0) {
      r.G = 0;
      if (!r.bonk) { r.bonk = true; r.st.bonks++; ev(t, r, "ハンガーノック"); }
    }
    if (r.bonk && r.G >= bonkRecover) { r.bonk = false; ev(t, r, "ハンガーノックから回復"); }
    if (r.boostLeft > 0) r.boostLeft--;
  };
  const pinRange = (pin: { from: number; to: number }, s: number) => s >= pin.from && s <= pin.to;
  const activeCheckPin = (r: Rider): CheckPin | null => {
    for (const p of r.plan.pins) if (p.type === "check" && pinRange(p, r.sNow)) return p;
    return null;
  };
  const activePull = (r: Rider): boolean => r.plan.pins.some((p) => p.type === "pull" && pinRange(p, r.sNow));

  // ---------- formation ----------
  interface GroupCtx { escortTeams: Set<number>; cornerNear: boolean; }
  const groupCtx = (g: Group): GroupCtx => {
    const escortTeams = new Set<number>();
    for (const o of g.order) if (active(o) && o.plan.role === "escort") escortTeams.add(o.teamIdx);
    const nc = course.corners[g.nextCorner];
    const cornerNear = !!nc && nc.zoned && (nc.apex - g.s) * scale <= P["pos.corner_bonus_km"] * 1000;
    return { escortTeams, cornerNear };
  };
  const priority = (r: Rider, gc: GroupCtx): number => {
    let pr = r.iq;
    const role = r.plan.role;
    if ((role === "leader" || role === "climber") && gc.escortTeams.has(r.teamIdx)) pr += P["pos.ace_escort_bonus"];
    if (role === "escort") pr += P["pos.escort_bonus"];
    if (gc.cornerNear) pr += idiv(P["pos.corner_bonus"] * r.iq, 100);
    if (r.W * 1000 < mulDiv(r.cap, P["pos.low_burst_ratio"], 1)) pr -= P["pos.low_burst_penalty"];
    return pr;
  };

  const formation = (g: Group, t: number) => {
    const act = g.order.filter(active);
    const line: Rider[] = [];
    const rest: Rider[] = [];
    for (const r of act) (PACER.has(r.mode) && line.length < lineMax ? line : rest).push(r);
    g.front = null;
    g.soft = false;
    if (line.length === 0 && rest.length > 0) {
      const gc = groupCtx(g);
      const elig = rest.filter((r) => !NO_LEAD.has(r.mode));
      const pool = (elig.length > 0 ? elig : rest).map((r) => ({ r, pr: priority(r, gc) })).sort((a, b) => a.pr - b.pr || a.r.idx - b.r.idx);
      const bottom = pool.slice(0, Math.min(6, pool.length));
      const f = bottom[idiv(t, P["pace.wait_rotate_s"]) % bottom.length].r;
      g.front = f;
      g.soft = elig.length === 0;
      line.push(f);
      rest.splice(rest.indexOf(f), 1);
    }
    g.line = line;
    g.body = rest;
    const nB = rest.length;
    g.w = nB > 0 ? Math.min(lanes, Math.max(1, Math.ceil(nB / 6))) : 1;
    const rows = nB > 0 ? Math.ceil(nB / g.w) : 0;
    g.length = (line.length + rows - 1) * spacing;
    const rot = line.length > 0 ? idiv(t, P["pace.rotate_s"]) % line.length : 0;
    line.forEach((r, i) => {
      r.lineIdx = i;
      r.bodyIdx = -1;
      r.offset = i * spacing;
      const pos = (i - rot + line.length) % line.length; // rotating position in the line
      r.k = g.front ? PPM : pos < 3 ? kLine[pos] : kLine46;
    });
    rest.forEach((r, j) => {
      r.lineIdx = -1;
      r.bodyIdx = j;
      const row = idiv(j, g.w) + 1;
      r.offset = (line.length + row - 1) * spacing;
      let k = row === 1 ? kRow1 : row === 2 ? kRow2 : j * PPM < mulP(nB * PPM, PPM - rearFrac) ? kMid : kRear;
      if (r.moving) k = kMoving;
      if (r.mode === "follow" && r.follow && r.follow.g === g) k = kWheel;
      r.k = k;
    });
  };

  const lanePos = (g: Group, j: number) => {
    const start = idiv(6 - g.w, 2) + 1;
    return { row: idiv(j, g.w) + 1, lane: start + (j % g.w) };
  };
  const occupied = (g: Group, row: number, lane: number) => {
    const nB = g.body.length;
    const start = idiv(6 - g.w, 2) + 1;
    if (lane < start || lane >= start + g.w) return false;
    const j = (row - 1) * g.w + (lane - start);
    return j < nB;
  };
  /** core §2-9 (a)–(c). Pace-line riders and body row 1 always have a lane. */
  const openLane = (r: Rider): boolean => {
    const g = r.g!;
    if (r.bodyIdx < 0) return true;
    const { row, lane } = lanePos(g, r.bodyIdx);
    if (row === 1) return true;
    for (const l of [lane, lane - 1, lane + 1]) {
      if (l < 1 || l > 6) continue;
      if (l !== lane && occupied(g, row, l)) continue;
      let clear = true;
      for (let rr = row - 1; rr >= 1 && clear; rr--) if (occupied(g, rr, l)) clear = false;
      if (!clear) continue;
      if (l === 3 && g.line.length > 0) continue;
      return true;
    }
    return false;
  };
  const openLaneStrict = (r: Rider): boolean => {
    const g = r.g!;
    if (r.bodyIdx < 0) return true;
    const { row, lane } = lanePos(g, r.bodyIdx);
    for (const l of [lane, lane - 1, lane + 1]) {
      if (l < 1 || l > 6) continue;
      if (l !== lane && occupied(g, row, l)) continue;
      let clear = true;
      for (let rr = row - 1; rr >= 1 && clear; rr--) if (occupied(g, rr, l)) clear = false;
      if (!clear) continue;
      if (l === 3 && g.line.length > 0) continue;
      return true;
    }
    return false;
  };

  const moveUps = (g: Group, t: number) => {
    for (const r of g.order) r.moving = false;
    if (t % P["pos.move_period_s"] !== 0) return;
    const body = g.body;
    if (body.length <= g.w) return;
    const gc = groupCtx(g);
    const pr = new Map<Rider, number>();
    for (const r of body) pr.set(r, priority(r, gc));
    const sorted = [...body].sort((a, b) => pr.get(b)! - pr.get(a)! || a.idx - b.idx);
    const target = new Map<Rider, number>();
    sorted.forEach((r, i) => target.set(r, idiv(i, g.w)));
    const pos = new Map<Rider, number>();
    body.forEach((r, j) => pos.set(r, j));
    const done = new Set<Rider>();
    const cost = (r: Rider) => {
      let c = mulP(P["pos.move_cost_j"], PPM - P["pos.move_cost_iq"] * r.iq);
      if (r.input.computer) c = mulP(c, PPM - toPpm(P["equip.computer_accel_loss"]));
      return c; // mJ (param J*1000)
    };
    const isForced = (r: Rider) => r.pend !== null && !r.pend.strict && r.pend.cornerWait === null;
    for (const r of sorted) {
      if (done.has(r)) continue;
      const j = pos.get(r)!;
      const row = idiv(j, g.w);
      const forced = isForced(r);
      const want = forced ? 0 : target.get(r)!;
      if (row <= want || row === 0) continue;
      let best = -1;
      for (let jj = (row - 1) * g.w; jj < row * g.w; jj++) {
        const o = body[jj];
        if (done.has(o) || isForced(o)) continue;
        if (!forced && pr.get(o)! >= pr.get(r)!) continue;
        if (best < 0 || pr.get(o)! < pr.get(body[best])! || (pr.get(o)! === pr.get(body[best])! && o.idx > body[best].idx)) best = jj;
      }
      if (best < 0) continue;
      const o = body[best];
      body[best] = r;
      body[j] = o;
      pos.set(r, best);
      pos.set(o, j);
      done.add(r);
      done.add(o);
      r.moving = true;
      r.st.moveUps++;
      const c = Math.min(cost(r), r.W);
      r.W -= c;
      r.wUsed += c;
      r.st.burstUsed += c;
    }
    // write body order back into g.order (line riders keep their slots)
    let bi = 0;
    const inBody = new Set(body);
    g.order = g.order.map((r) => (inBody.has(r) ? body[bi++] : r));
  };

  // ---------- split / merge ----------
  const split = (r: Rider, t: number, absV?: number, launch = true): Group => {
    const g = r.g!;
    if (g.order.filter(active).length === 1) return g;
    g.order = g.order.filter((o) => o !== r);
    r.launchFrom = launch ? g.id : -1;
    const v = absV ?? g.v + r.u;
    r.lag = 0;
    r.u = 0;
    const ng = newGroup([r], r.sNow, v);
    void t;
    return ng;
  };

  // ---------- initial state ----------
  const startV = P["race.start_speed_ms"];
  {
    const g0 = newGroup([...riders], 0, startV);
    const gc0 = groupCtx(g0);
    const pr = riders.map((r) => ({ r, p: priority(r, gc0) })).sort((a, b) => b.p - a.p || a.r.idx - b.r.idx);
    g0.order = pr.map((x) => x.r);
  }

  const tMax = course.tRefS * 3 + 600;
  let t = 0;
  const chaserSets = new Map<number, Set<Rider>>();

  while (t < tMax) {
    t++;
    groups.sort((a, b) => b.s - a.s || a.id - b.id);
    for (const r of riders) if (active(r)) r.sNow = r.g!.s - r.offset - r.lag;

    // ---- 1. items, sprint, pins ----
    for (const r of riders) {
      if (!active(r)) continue;
      // item pins
      r.plan.pins.forEach((p, i) => {
        if (p.type !== "item" || r.pinDone[i] || r.sNow < p.at) return;
        r.pinDone[i] = true;
        if (p.item === "recovery") useRecovery(t, r, "ピン");
        else useBoost(t, r);
      });
      // auto recovery (stamina §2-2): below threshold, one at a time, unless enough fuel to finish
      if (r.recLeft === 0 && r.recItems > 0 && mulDiv(r.G, 100_000, FUEL_FULL) < r.plan.recThresholdPct1000) {
        const v = Math.max(r.g!.v, 5000);
        const remS = idiv(L - r.sNow, v);
        const need = mulDiv(mulP(KG, r.ph.sG), remS * 70, 100);
        if (r.G <= need) useRecovery(t, r, "自動");
      }
      // sprint
      if (!r.spr) {
        r.plan.pins.forEach((p, i) => {
          if (p.type !== "sprint" || r.pinDone[i] || r.sNow < p.at) return;
          r.pinDone[i] = true;
          r.spr = { t: 0 };
          r.atk = null; r.pend = null; r.hunt = null; r.bridge = null; r.follow = null;
          split(r, t);
          if (p.boost) useBoost(t, r);
        });
      }
      if (r.spr) continue;
      // attack / bridge pins -> pending
      r.plan.pins.forEach((p, i) => {
        if (r.pinDone[i] || r.pend) return;
        if (p.type === "attack") {
          if (p.cornerIdx !== null) {
            const c = course.corners[p.cornerIdx];
            if (r.sNow >= c.apex) {
              r.pinDone[i] = true;
              if (r.sNow > p.at) { r.st.attacksNoLane++; ev(t, r, "立ち上がりアタック: 頂点を過ぎていた（行き場なし）"); return; }
              r.pend = { kind: "attack", pin: p, sinceS: r.sNow, sinceT: t, strict: true, cornerWait: null, fromWait: false, windowUntil: t + P["corner.lane_window_s"] };
            }
          } else if (r.sNow >= p.at) {
            r.pinDone[i] = true;
            r.pend = { kind: "attack", pin: p, sinceS: r.sNow, sinceT: t, strict: false, cornerWait: null, fromWait: false, windowUntil: 0 };
          }
        } else if (p.type === "bridge") {
          if (!pinRange(p, r.sNow)) return;
          const tgt = bridgeTarget(r, p);
          if (tgt) {
            r.pinDone[i] = true;
            r.pend = { kind: "bridge", pin: p, sinceS: r.sNow, sinceT: t, strict: false, cornerWait: null, fromWait: false, windowUntil: 0 };
          }
        }
      });
    }

    // ---- 2. pending attacks / bridges ----
    for (const r of riders) {
      if (!active(r) || !r.pend || r.spr) continue;
      if (r.atk || r.hunt || r.bridge) continue;
      const pd = r.pend;
      const g = r.g!;
      if (pd.kind === "attack") {
        const pin = pd.pin as AttackPin;
        const need = mulP(mulP(r.ph.pmax - cpEff(r), attackF[pin.kind]) * attackS[pin.kind], toPpm(P["attack.start_burst_ratio"]));
        if (r.W < need) {
          if ((r.sNow - pd.sinceS) * scale > P["attack.wait_max_km"] * 1000) { r.pend = null; r.st.attacksNoLegs++; ev(t, r, "アタック中止（脚が残っていない）"); }
          continue;
        }
      } else {
        const tgt = bridgeTarget(r, pd.pin as BridgePin);
        if (!tgt) { r.pend = null; continue; }
      }
      // zones (D45): a pending normal attack/bridge that drifts into a no-attack zone waits for the apex
      if (!pd.strict && pd.cornerWait === null) {
        const z = zoneAt(course, r.sNow);
        if (z.kind === "no_attack" && z.corner) pd.cornerWait = z.corner.idx;
      }
      if (pd.cornerWait !== null) {
        const c = course.corners[pd.cornerWait];
        if (g.s < c.apex) continue;
        pd.cornerWait = null; pd.strict = true; pd.fromWait = true; pd.windowUntil = t + P["corner.lane_window_s"];
      }
      const ok = pd.strict ? openLaneStrict(r) : openLane(r);
      if (!ok) {
        if (pd.strict && t > pd.windowUntil) {
          if (pd.fromWait) { pd.strict = false; pd.fromWait = false; }
          else { r.pend = null; r.st.attacksNoLane++; ev(t, r, "立ち上がりアタック: 行き場なし"); }
        }
        continue;
      }
      launch(r, pd, t);
    }

    // ---- 3. check reactions, hunts, attack timers ----
    for (const r of riders) {
      if (!active(r)) continue;
      if (r.huntPending && t >= r.huntPending.at) {
        const tg = r.huntPending.target;
        const boost = r.huntPending.boost;
        r.huntPending = null;
        if (active(tg) && tg.g !== r.g && tg.escS !== null && !r.spr && !r.atk && !r.bridge) {
          split(r, t);
          r.hunt = tg;
          r.escS = r.escS ?? r.sNow;
          r.st.checks++;
          if (boost) useBoost(t, r);
          ev(t, r, `チェック開始 → ${tg.id}`);
        }
      }
      if (r.hunt) {
        const tg = r.hunt;
        if (!active(tg) || tg.escS === null) { r.hunt = null; }
        else if (tg.g === r.g) { r.hunt = null; r.follow = tg; }
        else if (r.W <= 0) { r.hunt = null; r.escS = null; r.st.checksShedded++; ev(t, r, `チェック: 振り切られた（${tg.id}）`); }
      }
      if (r.follow) {
        const tg = r.follow;
        if (!active(tg) || tg.g !== r.g || tg.escS === null) r.follow = null;
      }
      if (r.bridge) {
        const tg = r.bridge;
        if (!active(tg)) r.bridge = null;
        else if (tg.g === r.g) { r.bridge = null; ev(t, r, `ブリッジ成功 → ${tg.id}`); }
        else if (r.W <= 0) { r.bridge = null; r.escS = null; ev(t, r, "ブリッジ失敗"); }
      }
      if (r.atk && t >= r.atk.until) r.atk = null;
      // sit up when a checker has been on the wheel for N seconds (D41)
      if (r.escS !== null && r.lastOnCheck === "stop" && !r.spr) {
        const followed = r.g!.order.some((o) => active(o) && o.follow === r);
        if (!followed) r.followedSince = null;
        else {
          r.followedSince = r.followedSince ?? t;
          if (t - r.followedSince >= P["attack.sit_up_after_check_s"]) {
            r.atk = null; r.escS = null; r.situp = true; r.followedSince = null;
            ev(t, r, "チェックに付かれたのでアタックをやめる");
          }
        }
      }
      if (r.spr) r.spr.t++;
    }

    // ---- 4. team chase decisions (core §2-7) ----
    chaseDecisions(t);

    // ---- 5. modes ----
    chaserSets.clear();
    for (const ts of teams) if (ts.chasing) chaserSets.set(ts.idx, chasersOf(ts));
    for (const r of riders) {
      if (!active(r)) continue;
      r.mode = resolveMode(r);
    }

    // ---- 6. per-group physics ----
    groups.sort((a, b) => b.s - a.s || a.id - b.id);
    const drops: Rider[] = [];
    const finishedGroups: Group[] = [];
    for (const g of groups) {
      if (!g.order.some(active)) continue;
      formation(g, t);
      moveUps(g, t);
      formation(g, t);
      const seg = course.segments[segmentAt(course, g.s)];
      for (const r of g.order) if (active(r)) r.J = computeJ(r, seg.grade, r.sNow);
      // block efficiency
      let blockers = 0;
      g.body.slice(0, P["block.slots"]).forEach((r) => { if (r.mode === "block") blockers++; });
      const blockEff = Math.min(toPpm(P["block.max"]), blockers * toPpm(P["block.per_rider"]));
      // corner braking
      const corner: Corner | undefined = course.corners[g.nextCorner];
      const lead = g.line[0] ?? g.body[0];
      let vT = 0;
      let braking = false;
      if (corner && lead) {
        vT = mulP(corner.vc, P["corner.iq_line_base"] + P["corner.iq_line_per_iq"] * lead.iq);
        const d = corner.apex - g.s;
        if (g.v > vT && idiv(g.v * g.v - vT * vT, 2 * brake) >= d - g.v) braking = true;
      }
      if (braking && !g.braking) g.vCruise = g.v;
      g.braking = braking;
      const exitPhase = !braking && g.exitTarget > 0 && g.v < g.exitTarget && t <= g.exitUntil;
      if (!exitPhase) g.exitTarget = 0;
      // engine
      let num = 0, den = 0;
      const desired = (r: Rider): number => {
        const ce = cpEff(r);
        const isFront = g.front === r;
        let p: number;
        switch (r.mode) {
          case "pull": p = mulP(mulP(ce, toPpm(P["pace.tempo_factor"])), PPM - blockEff); break;
          case "chase": p = mulP(mulP(ce, toPpm(P["pace.chase_factor"])), PPM - blockEff); break;
          case "break": p = mulP(ce, toPpm(g.line.length <= 1 ? P["pace.solo_factor"] : P["pace.tempo_factor"])); break;
          case "attack": p = attackPower(r, r.atk!.kind); break;
          case "hunt": p = Math.min(r.ph.pmax, mulP(nominalPower(r.hunt!), toPpm(P["check.chase_power_factor"]))); break;
          case "bridge": p = ce + mulP(r.ph.pmax - ce, toPpm(P["pace.bridge_f"])); break;
          case "sprint": p = mulP(r.ph.pmax, Math.max(0, PPM - toPpm(P["sprint.power_decay_per_s"]) * (r.spr!.t - 1))); break;
          default: p = isFront ? mulP(ce, toPpm(g.soft ? P["pace.soft_factor"] : P["pace.wait_factor"])) : 0;
        }
        if (exitPhase && (isFront || r.mode === "pull" || r.mode === "chase" || r.mode === "break")) p = Math.max(p, mulP(ce, toPpm(P["pace.exit_factor"])));
        if (braking) p = 0;
        return capP(r, p);
      };
      const out = (r: Rider, p: number) => mulP(mulP(p, r.J), r.boostLeft > 0 ? boostF : PPM);
      for (const r of g.line) {
        const p = desired(r);
        r.P = p;
        const coef = aeroCoef(rho, r.ph.cda, r.mode === "sprint" && r.spr!.t <= P["sprint.draft_s"] ? kLine[1] : r.k);
        num += out(r, p) - pNeed(g.v, r.ph.mTot, gMm, seg.slope, coef, seg.wind);
        den += r.ph.mEff;
      }
      let vNew = g.v;
      if (den > 0) vNew = g.v + accel(num, den, g.v, vMinA);
      if (braking) vNew = Math.max(vT, g.v - brake);
      if (corner && g.s + vNew >= corner.apex && vNew > vT && vT > 0) vNew = Math.min(vNew, Math.max(vT, g.v - brake));
      vNew = clamp(vNew, 0, vMax);
      const aG = vNew - g.v;
      // followers
      for (const r of g.body) {
        if (r === g.front) continue;
        const coef = aeroCoef(rho, r.ph.cda, r.k);
        const vr = g.v + r.u;
        if (r.u < 0 || r.lag > 0) {
          // closing a gap after a corner / shortfall (core §2-8)
          const ce = cpEff(r);
          const pc = braking ? 0 : capP(r, ce + mulP(r.ph.pmax - ce, toPpm(P["pace.close_f"])));
          r.P = pc;
          const aAbs = braking ? -brake : accel(out(r, pc) - pNeed(vr, r.ph.mTot, gMm, seg.slope, coef, seg.wind), r.ph.mEff, vr, vMinA);
          r.u += aAbs - aG;
          r.lag -= r.u;
          if (r.lag <= 0) { r.lag = 0; if (r.u > 0) r.u = 0; }
          if (r.lag > mulDiv(Math.max(vNew, 1000), gapMs, 1000)) drops.push(r);
          continue;
        }
        let need = pNeed(vNew, r.ph.mTot, gMm, seg.slope, coef, seg.wind) + Math.max(0, mulDiv(r.ph.mEff * aG, vNew, PPM));
        if (need < 0) need = 0;
        let req = mulDiv(need, PPM, mulP(r.J, r.boostLeft > 0 ? boostF : PPM));
        if (braking) req = 0;
        const pAct = capP(r, req);
        r.P = pAct;
        if (pAct < req - 1000) {
          // shortfall -> fall behind slot
          const dv = accel(out(r, req - pAct), r.ph.mEff, vNew, vMinA);
          r.u -= Math.max(1, dv);
          r.lag -= r.u;
        }
      }
      // accordion outside corners (core §2-8 (4))
      g.vHist.push(vNew);
      if (g.vHist.length > P["accordion.window_s"] + 1) g.vHist.shift();
      const dvW = Math.abs(vNew - g.vHist[0]);
      if (!braking && !exitPhase && t >= g.accCool && dvW >= P["accordion.dv_ms"] && g.body.length > 2) {
        g.accCool = t + P["accordion.window_s"];
        const n = g.body.length;
        g.body.forEach((r, j) => {
          const frac = mulDiv(j, PPM, n - 1);
          if (frac <= PPM / 2) return;
          let c = mulP(mulP(P["accordion.cost_j"], 2 * (frac - PPM / 2)), PPM - P["corner.accordion_iq"] * r.iq);
          if (r.input.computer) c = mulP(c, PPM - toPpm(P["equip.computer_accel_loss"]));
          c = Math.min(c, r.W);
          r.W -= c; r.wUsed += c; r.st.burstUsed += c;
        });
      }
      // move
      const sOld = g.s;
      g.v = vNew;
      g.s += vNew;
      // apex event
      if (corner && sOld < corner.apex && g.s >= corner.apex) {
        g.nextCorner++;
        g.exitTarget = Math.max(g.vCruise, vNew);
        g.exitUntil = t + 30;
        g.braking = false;
        const nRowsAcc = P["corner.accordion_rows"];
        for (const r of g.order) {
          if (!active(r)) continue;
          const row = r.bodyIdx < 0 ? 1 : idiv(r.bodyIdx, g.w) + 1;
          const vci = mulP(corner.vc, P["corner.iq_line_base"] + P["corner.iq_line_per_iq"] * r.iq);
          const red = mulP(mulP(toPpm(P["corner.accordion_max"]), Math.min(PPM, mulDiv(row - 1, PPM, nRowsAcc))), PPM - P["corner.accordion_iq"] * r.iq);
          const vin = mulP(vci, PPM - red);
          const du = Math.min(0, vin - vNew);
          if (r.bodyIdx >= 0 && du < 0) r.u = Math.min(r.u, du);
          if (r.pend && r.pend.cornerWait === corner.idx) { /* handled in pending loop */ }
        }
      }
      if (g.s >= L) finishedGroups.push(g);
    }

    // ---- 7. stamina for everyone ----
    for (const r of riders) {
      if (!active(r)) continue;
      burn(r, r.P, t);
      if (PACER.has(r.mode) && r.mode !== "sprint" && r.mode !== "attack") r.st.pullS++;
      if (r.mode === "sprint") r.st.sprintS++;
    }

    // ---- 8. finishes ----
    for (const g of finishedGroups) {
      const sOld = g.s - g.v;
      for (const r of g.order) {
        if (!active(r)) continue;
        const sp = sOld - r.offset - r.lag;
        r.finishMs = (t - 1) * 1000 + mulDiv(L - sp, 1000, Math.max(g.v, 1));
        r.finished = true;
        r.sNow = L;
      }
      g.order = [];
    }

    // ---- 9. drops ----
    for (const r of drops) {
      if (!active(r) || !r.g) continue;
      const g = r.g;
      r.sNow = g.s - r.offset - r.lag;
      const absV = Math.max(0, g.v + r.u);
      split(r, t, absV, false);
      r.dropUntil = t + P["group.drop_cooldown_s"];
      r.dropFrom = g.id;
      r.st.drops++;
      if (r.follow) { r.follow = null; r.escS = null; r.st.checksShedded++; }
      ev(t, r, "集団から遅れた");
    }

    // ---- 10. merges ----
    for (let i = groups.length - 1; i >= 0; i--) if (!groups[i].order.some(active)) groups.splice(i, 1);
    groups.sort((a, b) => b.s - a.s || a.id - b.id);
    // a launched rider may not fall back into the group it left until it has passed its head
    for (const r of riders) {
      if (r.launchFrom < 0 || !active(r)) continue;
      const src = groups.find((g) => g.id === r.launchFrom);
      if (!src || r.g!.s > src.s || !(r.atk || r.hunt || r.bridge || r.spr)) r.launchFrom = -1;
    }
    for (const g of groups) {
      let len = 0;
      for (const r of g.order) if (active(r) && r.g === g) len = Math.max(len, r.offset + r.lag);
      g.length = len;
    }
    let i = 0;
    while (i < groups.length - 1) {
      const F = groups[i], R = groups[i + 1];
      const gap = F.s - F.length - R.s;
      const sprinting = F.order.some((r) => active(r) && r.spr) || R.order.some((r) => active(r) && r.spr);
      const cool = R.order.some((r) => active(r) && ((r.dropFrom === F.id && r.dropUntil > t) || r.launchFrom === F.id));
      if (!sprinting && !cool && R.v >= F.v && gap <= mulDiv(Math.max(R.v, 1000), gapMs, 1000)) {
        const fa = F.order.filter(active), ra = R.order.filter(active);
        for (const r of ra) { r.lag = 0; r.u = 0; r.g = F; }
        F.order = [...fa, ...ra];
        // escapees swallowed by a bigger bunch are caught (their escape ends)
        const esc = F.order.filter((r) => r.escS !== null || r.situp).length;
        if (F.order.length - esc > esc) for (const r of F.order) { r.escS = null; r.situp = false; }
        groups.splice(i + 1, 1);
        F.length = F.length + spacing + R.length;
        continue;
      }
      i++;
    }

    if (opt.onTick) {
      const leaderS = groups.length ? groups.reduce((m, g) => Math.max(m, g.s), 0) : L;
      opt.onTick(t, riders, groups, leaderS);
    }
    if (!riders.some(active)) break;
  }
  for (const r of riders) if (active(r)) { r.dnf = true; r.finishMs = 0; }
  return { riders, teams, ticks: t, events };

  // ---------- inner helpers needing closure ----------
  function capP(r: Rider, p: number): number {
    const ce = cpEff(r);
    const hi = r.W > 0 ? Math.min(r.ph.pmax, ce + r.W) : ce;
    return clamp(p, 0, Math.max(hi, 0));
  }

  function bridgeTarget(r: Rider, p: BridgePin): Rider | null {
    const g = r.g!;
    const mates = teams[r.teamIdx].riders.filter((o) => o !== r && active(o) && o.g && o.g !== g && o.g.s > g.s);
    if (p.target === "any") return mates.sort((a, b) => b.g!.s - a.g!.s || a.idx - b.idx)[0] ?? null;
    return mates.find((o) => o.id === p.target) ?? null;
  }

  function launch(r: Rider, pd: Pending, t: number) {
    const g = r.g!;
    const absV = g.v + r.u;
    const fromGroup = g;
    r.pend = null;
    r.st.attackDelayS += t - pd.sinceT;
    if (pd.kind === "attack") {
      const pin = pd.pin as AttackPin;
      split(r, t, absV);
      r.atk = { kind: pin.kind, until: t + attackS[pin.kind], onCheck: pin.onCheck };
      r.followedSince = null;
      r.lastOnCheck = pin.onCheck;
      r.escS = r.escS ?? r.sNow;
      r.situp = false;
      r.st.attacks++;
      if (pd.strict) r.st.cornerAttacks++;
      if (pin.boost) useBoost(t, r);
      ev(t, r, `${pd.strict ? "立ち上がりアタック" : "アタック"}（${pin.kind}）${t - pd.sinceT > 0 ? `・${t - pd.sinceT}秒遅れ` : ""}`);
      scheduleChecks(r, fromGroup, t);
    } else {
      const pin = pd.pin as BridgePin;
      const tgt = bridgeTarget(r, pin);
      if (!tgt) return;
      split(r, t, absV);
      r.bridge = tgt;
      r.escS = r.escS ?? r.sNow;
      r.lastOnCheck = "continue";
      if (pin.boost) useBoost(t, r);
      ev(t, r, `ブリッジ開始 → ${tgt.id}`);
    }
  }

  function scheduleChecks(a: Rider, g: Group, t: number) {
    const byTeam = new Map<number, Rider>();
    const cands = g.order.filter((o) => active(o) && o.teamIdx !== a.teamIdx && !o.spr && !o.atk && !o.hunt && !o.follow && !o.bridge && !o.huntPending);
    cands.sort((x, y) => y.iq - x.iq || x.idx - y.idx);
    for (const c of cands) {
      if (byTeam.has(c.teamIdx)) continue;
      const pin = activeCheckPin(c);
      if (!pin) continue;
      const tgt = pin.target;
      const ok = tgt === "any" || tgt === a.id || tgt === teams[a.teamIdx].input.id;
      if (!ok) continue;
      byTeam.set(c.teamIdx, c);
      c.huntPending = { target: a, at: t + c.ph.reactS, boost: pin.boost };
    }
  }

  function teamRefGroup(ts: TeamState): Group | null {
    const act = ts.riders.filter(active);
    if (act.length === 0) return null;
    const lead = act.find((r) => r.plan.role === "leader" || r.plan.role === "climber");
    if (lead && lead.g) return lead.g;
    const cnt = new Map<Group, number>();
    for (const r of act) if (r.g) cnt.set(r.g, (cnt.get(r.g) ?? 0) + 1);
    let best: Group | null = null;
    for (const [g, n] of cnt) if (!best || n > cnt.get(best)! || (n === cnt.get(best)! && g.id < best.id)) best = g;
    return best;
  }

  function chaseDecisions(t: number) {
    const budget = idiv(P["ai.pull_budget_km"] * 1000, scale); // display m -> display mm -> sim mm
    const front = groups.reduce<Group | null>((m, g) => (g.order.some(active) && (!m || g.s > m.s) ? g : m), null);
    const cands: { ts: TeamState; g: Group }[] = [];
    for (const ts of teams) {
      const g = teamRefGroup(ts);
      if (!g) { ts.chasing = false; continue; }
      const ahead = !!front && front !== g && front.s > g.s;
      const mateAhead = ts.riders.some((r) => active(r) && r.g && r.g !== g && r.g.s > g.s);
      if (ts.chasing) {
        if (!ahead || mateAhead || ts.exhausted) { ts.chasing = false; continue; }
        // group ids change when groups merge; the chase follows the team's group
        ts.chaseGroup = g.id;
        ts.budgetUsed += g.v;
        if (ts.budgetUsed >= budget) { ts.exhausted = true; ts.chasing = false; ev(t, null, `${ts.input.id}: 牽引の予算を使い切った`); }
        continue;
      }
      if (ts.policy === "none" || ts.exhausted || !ahead || mateAhead) continue;
      const gapMsNow = mulDiv(front!.s - front!.length - g.s, 1000, Math.max(g.v, 1000));
      const alpha = ts.policy === "aggressive" ? P["ai.alpha_aggressive"] : P["ai.alpha_normal"]; // ms per display km
      const thr = mulDiv(alpha, remDisp(g.s), 1_000_000);
      if (gapMsNow > thr) cands.push({ ts, g });
    }
    cands.sort((a, b) => (a.ts.policy === "aggressive" ? 0 : 1) - (b.ts.policy === "aggressive" ? 0 : 1) || a.ts.idx - b.ts.idx);
    for (const { ts, g } of cands) {
      const n = teams.filter((o) => o.chasing && o.chaseGroup === g.id).length;
      if (n >= P["ai.max_chase_teams"]) continue;
      ts.chasing = true;
      ts.chaseGroup = g.id;
      ts.chaseStarts++;
      ev(t, null, `${ts.input.id}: 追走開始（方針 ${ts.policy}）`);
    }
  }

  function chasersOf(ts: TeamState): Set<Rider> {
    const g = groups.find((x) => x.id === ts.chaseGroup);
    if (!g) return new Set();
    const roleRank = (r: Rider) => (r.plan.role === "puller" ? 0 : r.plan.role === "free" ? 1 : r.plan.role === "escort" ? 2 : 3);
    const c = ts.riders
      .filter((r) => active(r) && r.g === g && r.plan.role !== "leader" && r.plan.role !== "climber" && !r.pend && !activeCheckPin(r) && !r.atk && !r.hunt && !r.follow && !r.bridge && !r.spr && r.escS === null)
      .sort((a, b) => roleRank(a) - roleRank(b) || b.input.flat - a.input.flat || a.idx - b.idx)
      .slice(0, P["ai.chase_riders_per_team"]);
    return new Set(c);
  }

  function resolveMode(r: Rider): Mode {
    if (r.spr) return "sprint";
    if (r.atk) return "attack";
    if (r.hunt) return "hunt";
    if (r.bridge) return "bridge";
    if (r.follow) return "follow";
    if (r.situp) return "situp";
    const g = r.g!;
    const ts = teams[r.teamIdx];
    if (r.escS !== null) return "break";
    if (ts.chasing && ts.chaseGroup === g.id && chaserSets.get(ts.idx)?.has(r)) return "chase";
    if (activePull(r)) return "pull";
    // checking / blocking only makes sense with other teams in the same group
    const rivals = g.order.some((o) => o.teamIdx !== r.teamIdx && active(o));
    if (!rivals) return "sit";
    if (activeCheckPin(r)) return "check";
    if (ts.riders.some((o) => o !== r && active(o) && o.g && o.g !== g && o.g.s > g.s)) return "block";
    return "sit";
  }
}

export function displayKm(s: number, prm: Record<string, number>): number {
  return (s * prm["scale.display_per_sim"]) / 1_000_000;
}
void (null as unknown as Pin);
