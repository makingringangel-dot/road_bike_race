import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { checksum, idiv, mulP, parseDecimal, PPM } from "./fixed.js";
import { Course, zoneAt } from "./course.js";
import { RiderInput, TeamInput } from "./roster.js";

export type Role = "leader" | "escort" | "puller" | "breakaway" | "climber" | "free";
export type Template = "sprint" | "breakaway" | "climb" | "balanced";
export type ChasePolicy = "aggressive" | "normal" | "none";
export type AttackKind = "sharp" | "standard" | "long";

export interface PinInput {
  type: "attack" | "check" | "bridge" | "sprint" | "item" | "pull";
  at_km?: number | string;
  from_km?: number | string;
  to_km?: number | string;
  at_m?: number | string; // sprint: remaining display metres
  kind?: AttackKind;
  on_check?: "stop" | "continue";
  boost?: boolean;
  target?: string; // check: "any" | team id | rider id ; bridge: rider id | "any"
  item?: "recovery" | "boost";
}

export interface RiderPlanInput {
  role?: Role;
  items?: { recovery?: number; boost?: number };
  recovery_threshold_pct?: number | string;
  pins?: PinInput[];
}

export interface TeamPlanInput {
  team_id: string;
  template?: Template;
  chase_policy?: ChasePolicy;
  riders?: Record<string, RiderPlanInput>;
}

// compiled (sim units)
export interface AttackPin { type: "attack"; at: number; kind: AttackKind; onCheck: "stop" | "continue"; boost: boolean; cornerIdx: number | null; }
export interface CheckPin { type: "check"; from: number; to: number; target: string; boost: boolean; }
export interface BridgePin { type: "bridge"; from: number; to: number; target: string; boost: boolean; }
export interface SprintPin { type: "sprint"; at: number; boost: boolean; } // at = sim position where it launches
export interface ItemPin { type: "item"; at: number; item: "recovery" | "boost"; }
export interface PullPin { type: "pull"; from: number; to: number; }
export type Pin = AttackPin | CheckPin | BridgePin | SprintPin | ItemPin | PullPin;

export interface RiderPlan {
  role: Role;
  recovery: number;
  boost: number;
  recThresholdPct1000: number; // pct*1000
  pins: Pin[];
}

export interface TeamPlan {
  teamId: string;
  template: Template;
  chasePolicy: ChasePolicy;
  ai: boolean;
  riders: Map<string, RiderPlan>;
  messages: string[];
}

export function loadPlans(paths: string[]): { plans: TeamPlanInput[]; checksum: string } {
  const files: string[] = [];
  for (const p of paths) {
    if (statSync(p).isDirectory()) for (const f of readdirSync(p).sort()) { if (f.endsWith(".json")) files.push(join(p, f)); }
    else files.push(p);
  }
  const plans: TeamPlanInput[] = [];
  let all = "";
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    all += text;
    const j = JSON.parse(text);
    const arr: TeamPlanInput[] = Array.isArray(j) ? j : Array.isArray(j.plans) ? j.plans : [j];
    for (const p of arr) {
      if (!p.team_id) throw new Error(`${f}: team_id がありません`);
      plans.push(p);
    }
  }
  return { plans, checksum: checksum(all) };
}

// ---------- helpers ----------
function dispKmToSim(km: number | string, scale: number, what: string): number {
  return idiv(parseDecimal(km, PPM, what), scale);
}
const score = {
  sprint: (r: RiderInput) => r.sprint * 2 + r.flat + (r.job === "sprinter" ? 30 : 0),
  climb: (r: RiderInput) => r.climb * 2 + r.stamina + (r.job === "climber" ? 30 : 0) + (r.job === "puncheur" ? 10 : 0),
  flat: (r: RiderInput) => r.flat * 2 + r.stamina + (r.job === "rouleur" ? 30 : 0),
  overall: (r: RiderInput) => r.flat + r.climb + r.sprint + r.stamina + r.iq,
  iq: (r: RiderInput) => r.iq,
};
function pick(rs: RiderInput[], used: Set<string>, f: (r: RiderInput) => number, n: number): RiderInput[] {
  const out = rs.filter((r) => !used.has(r.id)).sort((a, b) => f(b) - f(a) || (a.id < b.id ? -1 : 1)).slice(0, n);
  out.forEach((r) => used.add(r.id));
  return out;
}

interface TemplateRider { role: Role; pins: PinInput[]; }

/** Build the template's roles and pins (in display km, then compiled like player pins). */
function templateRiders(tpl: Template, team: TeamInput, course: Course, prm: Record<string, number>): Map<string, TemplateRider> {
  const scale = prm["scale.display_per_sim"];
  const Ldisp = course.length * scale; // display mm
  const km = (mm: number) => String(idiv(mm, 1000) / 1000); // display mm -> km literal (3 decimals)
  const fromEnd = (dispKm1000: number) => Math.max(0, Ldisp - dispKm1000 * 1000);
  const rs = team.riders;
  const used = new Set<string>();
  const out = new Map<string, TemplateRider>();
  const checkLast = prm["ai.check_last_km"];
  const lateCheck: PinInput = { type: "check", from_km: km(fromEnd(checkLast)), to_km: km(fromEnd(1000)), target: "any" };
  const finalClimb = course.climbs.length ? course.climbs[course.climbs.length - 1] : null;
  const effTpl: Template = tpl === "climb" && !finalClimb ? "balanced" : tpl;
  if (effTpl === "sprint") {
    const [ace] = pick(rs, used, score.sprint, 1);
    const pullers = pick(rs, used, score.flat, 3);
    const escorts = pick(rs, used, score.iq, 2);
    out.set(ace.id, { role: "leader", pins: [] });
    for (const r of pullers) out.set(r.id, { role: "puller", pins: [{ type: "pull", from_km: km(fromEnd(prm["ai.pull_last_km"])), to_km: km(fromEnd(2000)) }] });
    escorts.forEach((r, i) => out.set(r.id, { role: "escort", pins: i === 0 ? [lateCheck] : [] }));
  } else if (effTpl === "breakaway") {
    const [brk] = pick(rs, used, score.flat, 1);
    const [ace] = pick(rs, used, score.overall, 1);
    const [chk] = pick(rs, used, score.iq, 1);
    out.set(brk.id, { role: "breakaway", pins: [{ type: "attack", at_km: km(prm["ai.break_attack_km"] * 1000), kind: "long", on_check: "continue" }] });
    out.set(ace.id, { role: "leader", pins: [] });
    out.set(chk.id, { role: "escort", pins: [lateCheck] });
    for (const r of rs) if (!out.has(r.id)) out.set(r.id, { role: "free", pins: [] });
  } else if (effTpl === "climb") {
    const [ace] = pick(rs, used, score.climb, 1);
    const pullers = pick(rs, used, score.climb, 2);
    const escorts = pick(rs, used, score.iq, 2);
    const climbLen = finalClimb!.end - finalClimb!.start;
    const atkSim = finalClimb!.start + mulP(climbLen, prm["ai.climb_attack_frac"] * 1000);
    out.set(ace.id, { role: "climber", pins: [{ type: "attack", at_km: km(atkSim * scale), kind: "standard", on_check: "continue", boost: true }] });
    for (const r of pullers) out.set(r.id, { role: "puller", pins: [{ type: "pull", from_km: km(finalClimb!.start * scale), to_km: km(atkSim * scale) }] });
    escorts.forEach((r, i) => out.set(r.id, { role: "escort", pins: i === 0 ? [lateCheck] : [] }));
  } else {
    const [ace] = pick(rs, used, score.overall, 1);
    const [chk] = pick(rs, used, score.iq, 1);
    out.set(ace.id, { role: "leader", pins: [] });
    out.set(chk.id, { role: "escort", pins: [lateCheck] });
  }
  for (const r of rs) if (!out.has(r.id)) out.set(r.id, { role: "free", pins: [] });
  return out;
}

function loadoutFor(role: Role, prm: Record<string, number>): { recovery: number; boost: number } {
  const key = role === "leader" ? "leader" : role === "breakaway" ? "breakaway" : role === "puller" ? "puller" : role === "climber" ? "climber" : "escort";
  return { recovery: prm[`ai.loadout.${key}.recovery`], boost: prm[`ai.loadout.${key}.boost`] };
}

/** Compile a team's plan (template + overrides) into sim units, enforcing the pin rules. */
export function compileTeamPlan(team: TeamInput, input: TeamPlanInput | null, course: Course, prm: Record<string, number>, aiTemplate: Template, aiPolicy: ChasePolicy): TeamPlan {
  const msgs: string[] = [];
  const tpl: Template = input?.template ?? aiTemplate;
  if (!["sprint", "breakaway", "climb", "balanced"].includes(tpl)) throw new Error(`team ${team.id}: 未知のテンプレート ${tpl}`);
  const policy: ChasePolicy = input?.chase_policy ?? (input ? "normal" : aiPolicy);
  const tr = templateRiders(tpl, team, course, prm);
  const pinMax = prm["ui.pins_per_rider_max"];
  const sprintDefault = launchToSim(prm["sprint.launch_default_m"], course, prm, msgs, team.id, true);
  const riders = new Map<string, RiderPlan>();
  const riderIds = new Set(team.riders.map((r) => r.id));
  for (const k of Object.keys(input?.riders ?? {})) if (!riderIds.has(k)) msgs.push(`${team.id}: 作戦に未知の選手 ${k} があります（無視）`);
  for (const r of team.riders) {
    const ri = input?.riders?.[r.id];
    const t = tr.get(r.id)!;
    const role: Role = ri?.role ?? t.role;
    const lo = loadoutFor(role, prm);
    let recovery = ri?.items?.recovery ?? lo.recovery;
    let boost = ri?.items?.boost ?? lo.boost;
    if (boost > prm["item.carry_boost_max"]) { msgs.push(`${r.id}: 加速系は${prm["item.carry_boost_max"]}個までです（${boost} → ${prm["item.carry_boost_max"]}）`); boost = prm["item.carry_boost_max"]; }
    if (recovery + boost > prm["item.carry_total_max"]) {
      const nr = Math.max(0, prm["item.carry_total_max"] - boost);
      msgs.push(`${r.id}: 持ち込みは合計${prm["item.carry_total_max"]}個までです（回復系 ${recovery} → ${nr}）`);
      recovery = nr;
    }
    const thr = ri?.recovery_threshold_pct !== undefined ? parseDecimal(ri.recovery_threshold_pct, 1000, `${r.id}.recovery_threshold_pct`) : prm["item.recovery_auto_threshold_pct"];
    const rawPins = ri?.pins ?? t.pins;
    if (rawPins.length > pinMax) msgs.push(`${r.id}: ピンは${pinMax}本までです（${rawPins.length}本 → 先頭の${pinMax}本を使用）`);
    const pins: Pin[] = [];
    let hasSprint = false;
    for (const pi of rawPins.slice(0, pinMax)) {
      const c = compilePin(pi, r.id, course, prm, msgs, team.id);
      if (!c) continue;
      if (c.type === "sprint") hasSprint = true;
      pins.push(c);
    }
    if (!hasSprint) pins.push({ type: "sprint", at: role === "leader" || role === "climber" ? sprintDefault : launchToSim(prm["sprint.ai_launch_m"], course, prm, msgs, team.id, true), boost: role === "leader" && boost > 0 });
    riders.set(r.id, { role, recovery, boost, recThresholdPct1000: thr, pins });
  }
  return { teamId: team.id, template: tpl, chasePolicy: policy, ai: !input, riders, messages: msgs };
}

/** Sprint launch distance (display metres*1000 remaining) to the sim position; template defaults in a no-attack zone launch at the apex (D45). */
function launchToSim(remDisp: number, course: Course, prm: Record<string, number>, msgs: string[], who: string, isDefault: boolean): number {
  const scale = prm["scale.display_per_sim"];
  const at = course.length - idiv(remDisp, scale);
  const z = zoneAt(course, at);
  if (z.kind === "no_attack" && z.corner) {
    if (isDefault) return z.corner.apex;
    msgs.push(`${who}: コーナー前はアタックできません！（スプリント 残り${remDisp / 1000}m）`);
    return -1;
  }
  return at;
}

function compilePin(pi: PinInput, rid: string, course: Course, prm: Record<string, number>, msgs: string[], tid: string): Pin | null {
  const scale = prm["scale.display_per_sim"];
  const who = `${tid}/${rid}`;
  const inCourse = (s: number) => s >= 0 && s < course.length;
  try {
    switch (pi.type) {
      case "attack": {
        const at = dispKmToSim(pi.at_km ?? 0, scale, `${who}.attack.at_km`);
        if (!inCourse(at)) { msgs.push(`${who}: アタックの地点がコースの外です（無視）`); return null; }
        const z = zoneAt(course, at);
        if (z.kind === "no_attack") { msgs.push(`${who}: コーナー前はアタックできません！（${pi.at_km}km のピンを無視）`); return null; }
        return { type: "attack", at, kind: pi.kind ?? "standard", onCheck: pi.on_check ?? "stop", boost: !!pi.boost, cornerIdx: z.kind === "exit" ? z.corner!.idx : null };
      }
      case "bridge": {
        const from = dispKmToSim(pi.from_km ?? 0, scale, `${who}.bridge.from_km`), to = dispKmToSim(pi.to_km ?? 0, scale, `${who}.bridge.to_km`);
        if (zoneAt(course, from).kind === "no_attack") { msgs.push(`${who}: コーナー前はアタックできません！（ブリッジ ${pi.from_km}km のピンを無視）`); return null; }
        return { type: "bridge", from, to, target: pi.target ?? "any", boost: !!pi.boost };
      }
      case "check": {
        const from = dispKmToSim(pi.from_km ?? 0, scale, `${who}.check.from_km`), to = dispKmToSim(pi.to_km ?? 0, scale, `${who}.check.to_km`);
        return { type: "check", from, to, target: pi.target ?? "any", boost: !!pi.boost };
      }
      case "pull": {
        const from = dispKmToSim(pi.from_km ?? 0, scale, `${who}.pull.from_km`), to = dispKmToSim(pi.to_km ?? 0, scale, `${who}.pull.to_km`);
        return { type: "pull", from, to };
      }
      case "sprint": {
        const m = parseDecimal(pi.at_m ?? 400, 1000, `${who}.sprint.at_m`);
        if (m < prm["sprint.launch_min_m"] || m > prm["sprint.launch_max_m"] || (m - prm["sprint.launch_min_m"]) % prm["sprint.launch_step_m"] !== 0) {
          msgs.push(`${who}: スプリントの発動地点は残り${prm["sprint.launch_min_m"] / 1000}〜${prm["sprint.launch_max_m"] / 1000}m・${prm["sprint.launch_step_m"] / 1000}m刻みです（${pi.at_m}m を無視）`);
          return null;
        }
        const at = launchToSim(m, course, prm, msgs, who, false);
        if (at < 0) return null;
        return { type: "sprint", at, boost: pi.boost ?? true };
      }
      case "item": {
        const at = dispKmToSim(pi.at_km ?? 0, scale, `${who}.item.at_km`);
        return { type: "item", at, item: pi.item ?? "recovery" };
      }
      default:
        msgs.push(`${who}: 未知のピンの種類 ${(pi as PinInput).type}`);
        return null;
    }
  } catch (e) {
    msgs.push(`${who}: ${(e as Error).message}`);
    return null;
  }
}

/** Deterministic spread of categories by weight (smooth weighted round robin). */
export function spreadMix<T extends string>(n: number, weights: [T, number][], rotation: number): T[] {
  const cur = weights.map(() => 0);
  const total = weights.reduce((a, [, w]) => a + w, 0);
  const seq: T[] = [];
  for (let i = 0; i < n + rotation; i++) {
    let best = 0;
    for (let k = 0; k < weights.length; k++) {
      cur[k] += weights[k][1];
      if (cur[k] > cur[best]) best = k;
    }
    cur[best] -= total;
    seq.push(weights[best][0]);
  }
  return seq.slice(rotation);
}
