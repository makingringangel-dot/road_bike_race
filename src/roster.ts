import { readFileSync } from "node:fs";
import { checksum, icbrtBig, idiv, mulP, PPM } from "./fixed.js";
import { csvObjects } from "./csv.js";
import { Job, JOBS } from "./params/definitions.js";

export interface RiderInput {
  id: string;
  name: string;
  job: Job;
  flat: number;
  climb: number;
  sprint: number;
  stamina: number;
  iq: number;
  frame: "none" | "aero" | "light" | "allround";
  wheel: "none" | "deep" | "low";
  wear: "none" | "basic" | "aero";
  computer: boolean;
  generated: boolean;
}

export interface TeamInput {
  id: string;
  name: string;
  riders: RiderInput[];
  generated: boolean; // AI-filled slot
}

export interface Roster {
  teams: TeamInput[];
  checksum: string;
}

const STAT_KEYS = ["flat", "climb", "sprint", "stamina", "iq"] as const;

/** Roster CSV: team_id,team_name,rider_id,rider_name,job,flat,climb,sprint,stamina,iq[,frame,wheel,wear,computer] */
export function loadRoster(path: string): Roster {
  const text = readFileSync(path, "utf8");
  const rows = csvObjects(text);
  const teams = new Map<string, TeamInput>();
  const ids = new Set<string>();
  rows.forEach((r, i) => {
    const line = i + 2;
    const tid = r.team_id;
    if (!tid || !r.rider_id) throw new Error(`roster line ${line}: team_id と rider_id は必須です`);
    if (ids.has(r.rider_id)) throw new Error(`roster line ${line}: rider_id が重複しています: ${r.rider_id}`);
    ids.add(r.rider_id);
    const job = (r.job || "allrounder").toLowerCase() as Job;
    if (!JOBS.includes(job)) throw new Error(`roster line ${line}: 脚質が不正です: ${r.job}（${JOBS.join("/")}）`);
    const stats: Record<string, number> = {};
    for (const k of STAT_KEYS) {
      const v = Number.parseInt(r[k], 10);
      if (!/^\d+$/.test(r[k] ?? "") || v < 0 || v > 100) throw new Error(`roster line ${line}: ${k} は0〜100の整数: "${r[k]}"`);
      stats[k] = v;
    }
    const enumOf = <T extends string>(val: string | undefined, allowed: readonly T[], what: string): T => {
      const x = (val || "none").toLowerCase() as T;
      if (!allowed.includes(x)) throw new Error(`roster line ${line}: ${what} が不正です: ${val}（${allowed.join("/")}）`);
      return x;
    };
    if (!teams.has(tid)) teams.set(tid, { id: tid, name: r.team_name || tid, riders: [], generated: false });
    teams.get(tid)!.riders.push({
      id: r.rider_id, name: r.rider_name || r.rider_id, job,
      flat: stats.flat, climb: stats.climb, sprint: stats.sprint, stamina: stats.stamina, iq: stats.iq,
      frame: enumOf(r.frame, ["none", "aero", "light", "allround"] as const, "frame"),
      wheel: enumOf(r.wheel, ["none", "deep", "low"] as const, "wheel"),
      wear: enumOf(r.wear, ["none", "basic", "aero"] as const, "wear"),
      computer: ["1", "true", "yes"].includes((r.computer || "").toLowerCase()),
      generated: false,
    });
  });
  for (const t of teams.values()) if (t.riders.length > 6) throw new Error(`team ${t.id}: 6人を超えています（${t.riders.length}人）`);
  return { teams: [...teams.values()], checksum: checksum(text) };
}

/** Deterministic integer hash (input generation only; the race itself has no randomness). */
export function hash32(...xs: number[]): number {
  let h = 0x9e3779b9;
  for (const x of xs) {
    h = Math.imul(h ^ (x | 0), 0x85ebca6b) >>> 0;
    h = (h ^ (h >>> 13)) >>> 0;
    h = Math.imul(h, 0xc2b2ae35) >>> 0;
    h = (h ^ (h >>> 16)) >>> 0;
  }
  return h;
}

const AI_JOB_PATTERN: Job[] = ["sprinter", "rouleur", "rouleur", "climber", "puncheur", "allrounder"];
const JOB_BIAS: Record<Job, Partial<Record<(typeof STAT_KEYS)[number], number>>> = {
  sprinter: { sprint: 18, climb: -12 },
  rouleur: { flat: 14, climb: -6 },
  climber: { climb: 18, flat: -6, sprint: -8 },
  puncheur: { sprint: 8, climb: 6 },
  allrounder: {},
};

export function generateRider(teamSlot: number, riderIdx: number, seed: number, base: number, spread: number, job?: Job): RiderInput {
  const j = job ?? AI_JOB_PATTERN[(riderIdx + teamSlot) % AI_JOB_PATTERN.length];
  const stat = (k: (typeof STAT_KEYS)[number], n: number) => {
    const h = hash32(seed, teamSlot, riderIdx, n);
    const off = (h % (2 * spread + 1)) - spread;
    return Math.max(0, Math.min(100, base + off + (JOB_BIAS[j][k] ?? 0)));
  };
  const id = `AI${String(teamSlot + 1).padStart(2, "0")}-${riderIdx + 1}`;
  return {
    id, name: id, job: j,
    flat: stat("flat", 1), climb: stat("climb", 2), sprint: stat("sprint", 3), stamina: stat("stamina", 4), iq: stat("iq", 5),
    frame: "none", wheel: "none", wear: "none", computer: false, generated: true,
  };
}

/** Fill the field up to `teamCount` teams of 6; missing riders in existing teams are generated too. */
export function fillField(roster: Roster, teamCount: number, seed: number, prm: Record<string, number>): TeamInput[] {
  const base = prm["ai.rider_stat_base"], spread = prm["ai.rider_stat_spread"];
  const teams = roster.teams.map((t) => ({ ...t, riders: [...t.riders] }));
  if (teams.length > teamCount) throw new Error(`チーム数が上限（${teamCount}）を超えています: ${teams.length}`);
  teams.forEach((t, slot) => {
    while (t.riders.length < 6) t.riders.push(generateRider(slot, t.riders.length, seed, base, spread));
  });
  for (let slot = teams.length; slot < teamCount; slot++) {
    const riders = Array.from({ length: 6 }, (_, i) => generateRider(slot, i, seed, base, spread));
    teams.push({ id: `AI${String(slot + 1).padStart(2, "0")}`, name: `AIチーム${slot + 1}`, riders, generated: true });
  }
  return teams;
}

// ---- derived physical values (core §4-1) ----
export interface RiderPhys {
  cp: number; // mW
  mass: number; // g (body)
  mTot: number; // g (body+bike)
  mEff: number; // g (mTot + wheel mass again)
  cda: number; // ppm m²
  pmax: number; // mW
  wmax: number; // mJ
  tauMs: number;
  sG: number; // ppm
  reactS: number;
  fatigue: number; // ppm
  jobA: number; jobB: number; jobF: number; jobS: number; // ppm
}

export function derivePhys(r: RiderInput, prm: Record<string, number>): RiderPhys {
  const cp = prm["stat.cp_base_w"] + prm["stat.cp_per_flat_w"] * r.flat; // W*1000 = mW
  let mass = prm["stat.mass_base_kg"] - prm["stat.mass_per_climb_kg"] * r.climb; // g
  const mref = prm["stat.cda_ref_mass_kg"];
  // (m/mref)^(2/3) in ppm = cbrt(m^2/mref^2 * 1e18)
  const ratio = icbrtBig((BigInt(mass) * BigInt(mass) * 10n ** 18n) / (BigInt(mref) * BigInt(mref)));
  let cda = mulP(prm["stat.cda_ref"] * 1000, Number(ratio)); // ppm m²
  let bike = prm["physics.bike_mass_kg"];
  let wheel = prm["physics.wheel_mass_kg"];
  if (r.frame === "aero") cda += prm["equip.frame_aero_cda"];
  if (r.frame === "light") bike += prm["equip.frame_light_kg"];
  if (r.frame === "allround") { cda += prm["equip.frame_allround_cda"]; bike += prm["equip.frame_allround_kg"]; }
  if (r.wheel === "deep") { cda += prm["equip.wheel_deep_cda"]; wheel += prm["equip.wheel_deep_kg"]; bike += prm["equip.wheel_deep_kg"]; }
  if (r.wheel === "low") { wheel += prm["equip.wheel_low_kg"]; bike += prm["equip.wheel_low_kg"]; }
  if (r.wear === "basic") cda += prm["equip.wear_basic_cda"];
  if (r.wear === "aero") cda += prm["equip.wear_aero_cda"];
  const mTot = mass + bike;
  const pmax = prm["stat.pmax_base_w"] + prm["stat.pmax_per_sprint_w"] * r.sprint;
  const wmax = (prm["stat.wmax_base_kj"] + prm["stat.wmax_per_sprint_kj"] * r.sprint) * 1000; // J*1000 = mJ
  const tauMs = prm["stat.tau_base_s"] - prm["stat.tau_per_stamina_s"] * r.stamina;
  let sG = prm["stat.sg_base"] * 1000 - prm["stat.sg_per_stamina"] * r.stamina;
  if (r.computer) sG = mulP(sG, PPM - prm["equip.computer_fuel"] * 1000);
  const reactMs = prm["stat.react_base_s"] - idiv(prm["stat.react_per_iq_s"] * r.iq, 1000);
  const reactS = Math.max(0, idiv(reactMs + 500, 1000));
  const fatigue = prm["stamina.fatigue_base"] * 1000 - prm["stamina.fatigue_per_stamina"] * r.stamina;
  const j = (t: string) => prm[`job.${r.job}.${t}`] * 1000;
  mass = Math.max(mass, 30_000);
  return { cp, mass, mTot, mEff: mTot + wheel, cda, pmax, wmax, tauMs, sG, reactS, fatigue, jobA: j("A"), jobB: j("B"), jobF: j("F"), jobS: j("S") };
}
