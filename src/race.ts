import { closeSync, openSync, writeSync } from "node:fs";
import { Course } from "./course.js";
import { ENGINE_VERSION, Group, Rider, runRace } from "./engine.js";
import { idiv, mulDiv } from "./fixed.js";
import { ParamSet } from "./params/paramset.js";
import { ChasePolicy, compileTeamPlan, spreadMix, Template, TeamPlan, TeamPlanInput } from "./plans.js";
import { fillField, Roster, TeamInput } from "./roster.js";
import { csvLine } from "./csv.js";

export interface RaceSetup {
  course: Course;
  params: ParamSet;
  roster: Roster;
  plans: TeamPlanInput[];
  plansChecksum: string;
  teamCount?: number;
  aiSeed?: number;
  aiRotation?: number;
  logPath?: string | null;
  logEvery?: number;
  traceEvery?: number; // sampling for the HTML view (s); 0 = off
}

export interface RankRow {
  rank: number;
  rider_id: string;
  name: string;
  team_id: string;
  job: string;
  role: string;
  status: "finished" | "dnf";
  time_ms: number;
  gap_ms: number;
  group_gap_ms: number;
  escape_from_km: number | null;
}

export interface RiderSummary {
  rider_id: string;
  team_id: string;
  job: string;
  role: string;
  ai: boolean;
  fuel_used_pct: number;
  fuel_end_pct: number;
  burst_used_kj: number;
  bonks: number;
  recovery_used: number;
  boost_used: number;
  recovery_left: number;
  boost_left: number;
  attacks: number;
  corner_attacks: number;
  attacks_no_lane: number;
  attacks_no_legs: number;
  checks: number;
  checks_shed: number;
  drops: number;
  pull_s: number;
  sprint_s: number;
  events: string[];
}

export interface RaceReport {
  meta: Record<string, string | number | null>;
  ranking: RankRow[];
  riders: RiderSummary[];
  teams: { team_id: string; name: string; ai: boolean; template: Template; chase_policy: ChasePolicy; chase_starts: number; pull_budget_used_km: number }[];
  outcome: { winner: string; winner_team: string; winner_job: string; type: "breakaway" | "late_attack" | "group"; escape_from_km: number | null; lead_group_size: number; margin_ms: number };
  metrics: { finishers: number; dnf: number; bonk_riders: number; dropped_riders: number; sprint_avg_s_top10: number; attacks: number; corner_attacks: number; no_lane: number; compute_ms: number };
  messages: string[];
  events: { t: number; msg: string }[];
  trace: Trace | null;
}

export interface Trace {
  every: number;
  displayLenKm: number;
  profile: { km: number; alt: number }[];
  corners: { km: number; vc_kmh: number; name: string }[];
  riders: { id: string; team: string; job: string }[];
  frames: { t: number; km: number[]; grp: number[] }[];
}

export function prepareTeams(setup: RaceSetup): { teams: TeamInput[]; plans: TeamPlan[]; messages: string[] } {
  const prm = setup.params.values;
  const teamCount = setup.teamCount ?? 50;
  const teams = fillField(setup.roster, teamCount, setup.aiSeed ?? 0, prm);
  const byTeam = new Map(setup.plans.map((p) => [p.team_id, p]));
  const messages: string[] = [];
  for (const p of setup.plans) if (!teams.some((t) => t.id === p.team_id)) messages.push(`作戦のチーム ${p.team_id} はロースターにありません（無視）`);
  const aiTeams = teams.filter((t) => !byTeam.has(t.id));
  const type = setup.course.type === "flat" ? "flat" : "mountain";
  const tplKeys = Object.keys(prm).filter((k) => k.startsWith(`ai.template_mix.${type}.`)).sort();
  const tplMix = spreadMix(aiTeams.length, tplKeys.map((k) => [k.split(".").pop() as Template, prm[k]] as [Template, number]), setup.aiRotation ?? 0);
  const polMix = spreadMix(aiTeams.length, [["aggressive", prm["ai.mix_aggressive"]], ["normal", prm["ai.mix_normal"]], ["none", prm["ai.mix_none"]]] as [ChasePolicy, number][], (setup.aiRotation ?? 0) * 3);
  const aiIdx = new Map(aiTeams.map((t, i) => [t.id, i]));
  const plans = teams.map((t) => {
    const i = aiIdx.get(t.id) ?? 0;
    const tp = compileTeamPlan(t, byTeam.get(t.id) ?? null, setup.course, prm, tplMix[i], polMix[i]);
    messages.push(...tp.messages);
    return tp;
  });
  return { teams, plans, messages };
}

export function simulate(setup: RaceSetup): RaceReport {
  const prm = setup.params.values;
  const course = setup.course;
  const scale = prm["scale.display_per_sim"];
  const { teams, plans, messages } = prepareTeams(setup);
  const logEvery = setup.logEvery ?? 1;
  let fd: number | null = null;
  let buf: string[] = [];
  const flush = () => { if (fd !== null && buf.length) { writeSync(fd, buf.join("\n") + "\n"); buf = []; } };
  if (setup.logPath) {
    fd = openSync(setup.logPath, "w");
    buf.push(csvLine(["t_s", "rider_id", "team_id", "dist_km", "speed_kmh", "group_id", "group_size", "group_rank", "mode", "power_w", "J", "k", "burst_kj", "burst_cap_kj", "fuel_pct", "bonk", "gap_to_leader_s", "items_rec", "items_boost"]));
  }
  const traceEvery = setup.traceEvery ?? 0;
  const frames: Trace["frames"] = [];
  const t0 = process.hrtime.bigint();
  const res = runRace({
    course, prm, teams, plans,
    onTick: (t: number, riders: Rider[], groups: Group[], leaderS: number) => {
      const doLog = fd !== null && t % logEvery === 0;
      const doTrace = traceEvery > 0 && t % traceEvery === 0;
      if (!doLog && !doTrace) return;
      const sizes = new Map<Group, number>();
      const rankOf = new Map<Group, number>();
      groups.forEach((g, i) => { sizes.set(g, g.order.filter((r) => !r.finished && !r.dnf).length); rankOf.set(g, i + 1); });
      if (doTrace) {
        frames.push({
          t,
          km: riders.map((r) => Math.round(((r.finished ? course.length : r.sNow) * scale) / 1000) / 1000),
          grp: riders.map((r) => (r.finished || !r.g ? 0 : rankOf.get(r.g) ?? 0)),
        });
      }
      if (!doLog) return;
      for (const r of riders) {
        if (r.finished || r.dnf || !r.g) continue;
        const g = r.g;
        const gapMs = mulDiv(leaderS - r.sNow, 1000, Math.max(g.v, 1000));
        buf.push(csvLine([
          t, r.id, teams[r.teamIdx].id, (r.sNow * scale / 1e6).toFixed(3), (g.v * 3.6 / 1000).toFixed(2), g.id, sizes.get(g) ?? 0, rankOf.get(g) ?? 0, r.mode,
          Math.round(r.P / 1000), (r.J / 1e6).toFixed(4), (r.k / 1e6).toFixed(2), (r.W / 1e6).toFixed(2), (r.cap / 1e6).toFixed(2), (r.G / 1e7).toFixed(1), r.bonk ? 1 : 0,
          (gapMs / 1000).toFixed(1), r.recItems, r.boostItems,
        ]));
      }
      if (buf.length > 5000) flush();
    },
  });
  flush();
  if (fd !== null) closeSync(fd);
  const computeMs = Number((process.hrtime.bigint() - t0) / 1_000_000n);

  // ranking
  const fin = res.riders.filter((r) => r.finished).sort((a, b) => a.finishMs - b.finishMs || a.idx - b.idx);
  const dnf = res.riders.filter((r) => !r.finished).sort((a, b) => b.sNow - a.sNow || a.idx - b.idx);
  const win = fin[0];
  const ranking: RankRow[] = [];
  let groupStart = win ? win.finishMs : 0;
  fin.forEach((r, i) => {
    if (i > 0 && r.finishMs - fin[i - 1].finishMs > prm["group.gap_s"]) groupStart = r.finishMs;
    ranking.push(row(r, i + 1, "finished", r.finishMs - win.finishMs, groupStart - win.finishMs));
  });
  dnf.forEach((r, i) => ranking.push(row(r, fin.length + i + 1, "dnf", 0, 0)));
  function row(r: Rider, rank: number, status: "finished" | "dnf", gap: number, ggap: number): RankRow {
    return {
      rank, rider_id: r.id, name: r.name, team_id: teams[r.teamIdx].id, job: r.job, role: r.plan.role, status,
      time_ms: status === "finished" ? r.finishMs : 0, gap_ms: gap, group_gap_ms: ggap,
      escape_from_km: r.escS !== null ? Math.round((r.escS * scale) / 1000) / 1000 : null,
    };
  }

  // outcome: breakaway = winner's escape began before the last X of the race
  let type: RaceReport["outcome"]["type"] = "group";
  const escFrom = win && win.escS !== null ? win.escS : null;
  if (escFrom !== null) type = escFrom * 1000 <= mulDiv(course.length, 1000 - prm["report.breakaway_min_frac"], 1) ? "breakaway" : "late_attack";
  let leadSize = 0;
  for (let i = 0; i < fin.length; i++) { if (i > 0 && fin[i].finishMs - fin[i - 1].finishMs > prm["group.gap_s"]) break; leadSize++; }
  const top10 = fin.slice(0, 10).filter((r) => r.st.sprintS > 0);
  const summaries: RiderSummary[] = res.riders.map((r) => ({
    rider_id: r.id, team_id: teams[r.teamIdx].id, job: r.job, role: r.plan.role, ai: plans[r.teamIdx].ai,
    fuel_used_pct: Math.round(r.st.fuelUsed / 1e6) / 10,
    fuel_end_pct: Math.round(r.G / 1e6) / 10,
    burst_used_kj: Math.round(r.st.burstUsed / 1e5) / 10,
    bonks: r.st.bonks, recovery_used: r.st.recUsed, boost_used: r.st.boostUsed, recovery_left: r.recItems, boost_left: r.boostItems,
    attacks: r.st.attacks, corner_attacks: r.st.cornerAttacks, attacks_no_lane: r.st.attacksNoLane, attacks_no_legs: r.st.attacksNoLegs,
    checks: r.st.checks, checks_shed: r.st.checksShedded, drops: r.st.drops, pull_s: r.st.pullS, sprint_s: r.st.sprintS,
    events: r.events,
  }));
  const report: RaceReport = {
    meta: {
      engine_version: ENGINE_VERSION,
      param_version: setup.params.version, param_checksum: setup.params.checksum, param_source: setup.params.source, param_status: setup.params.status,
      course_id: course.id, course_version: course.version, course_checksum: course.checksum, course_type: course.type,
      course_display_km: course.displayKm1000 / 1000, t_ref_s: course.tRefS,
      roster_checksum: setup.roster.checksum, plans_checksum: setup.plansChecksum,
      teams: teams.length, riders: res.riders.length, ai_seed: setup.aiSeed ?? 0, ai_rotation: setup.aiRotation ?? 0, ticks: res.ticks,
    },
    ranking,
    riders: summaries,
    teams: res.teams.map((ts) => ({
      team_id: ts.input.id, name: ts.input.name, ai: ts.plan.ai, template: ts.plan.template, chase_policy: ts.policy,
      chase_starts: ts.chaseStarts, pull_budget_used_km: Math.round((ts.budgetUsed * scale) / 1e5) / 10,
    })),
    outcome: {
      winner: win?.id ?? "", winner_team: win ? teams[win.teamIdx].id : "", winner_job: win?.job ?? "", type,
      escape_from_km: escFrom !== null ? Math.round((escFrom * scale) / 1e5) / 10 : null,
      lead_group_size: leadSize, margin_ms: fin.length > 1 ? fin[1].finishMs - fin[0].finishMs : 0,
    },
    metrics: {
      finishers: fin.length, dnf: dnf.length,
      bonk_riders: res.riders.filter((r) => r.st.bonks > 0).length,
      dropped_riders: res.riders.filter((r) => r.st.drops > 0).length,
      sprint_avg_s_top10: top10.length ? Math.round((top10.reduce((a, r) => a + r.st.sprintS, 0) * 10) / top10.length) / 10 : 0,
      attacks: res.riders.reduce((a, r) => a + r.st.attacks, 0),
      corner_attacks: res.riders.reduce((a, r) => a + r.st.cornerAttacks, 0),
      no_lane: res.riders.reduce((a, r) => a + r.st.attacksNoLane, 0),
      compute_ms: computeMs,
    },
    messages,
    events: res.events,
    trace: traceEvery > 0 ? buildTrace(course, scale, res.riders, teams, frames, traceEvery) : null,
  };
  return report;
}

function buildTrace(course: Course, scale: number, riders: Rider[], teams: TeamInput[], frames: Trace["frames"], every: number): Trace {
  const profile: Trace["profile"] = [];
  let alt = 0;
  for (const s of course.segments) {
    profile.push({ km: (s.start * scale) / 1e6, alt: Math.round(alt) });
    alt += ((s.end - s.start) * s.grade) / 1e9; // mm*ppm -> m
  }
  profile.push({ km: (course.length * scale) / 1e6, alt: Math.round(alt) });
  return {
    every, displayLenKm: (course.length * scale) / 1e6, profile,
    corners: course.corners.map((c) => ({ km: (c.apex * scale) / 1e6, vc_kmh: Math.round((c.vc * 3.6) / 100) / 10, name: c.name })),
    riders: riders.map((r) => ({ id: r.id, team: teams[r.teamIdx].id, job: r.job })),
    frames,
  };
}

export function fmtTime(ms: number): string {
  const s = idiv(ms, 1000);
  const h = idiv(s, 3600), m = idiv(s % 3600, 60), ss = s % 60;
  const t = idiv(ms % 1000, 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}.${t}`;
}
export function fmtGap(ms: number): string {
  if (ms <= 0) return "—";
  const s = idiv(ms, 1000);
  return s >= 60 ? `+${idiv(s, 60)}:${String(s % 60).padStart(2, "0")}` : `+${s}.${idiv(ms % 1000, 100)}s`;
}
