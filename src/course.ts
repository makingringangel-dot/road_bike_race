import { readFileSync } from "node:fs";
import { checksum, idiv, isqrt, mulDiv, parseDecimal, PPM } from "./fixed.js";
import { aeroCoef, slopeFor, Slope, steadySpeed } from "./physics.js";

export interface CourseFile {
  id: string;
  version: number;
  name?: string;
  type: "flat" | "hilly" | "mountain";
  t_ref_s?: number;
  segments: { length_km: number | string; grade_pct?: number | string; wind_ms?: number | string; label?: string }[];
  corners?: { at_km: number | string; radius_m: number | string; name?: string }[];
}

export interface Segment {
  start: number; // sim mm
  end: number;
  grade: number; // ppm
  slope: Slope;
  wind: number; // headwind mm/s
  label: string;
}

export interface Corner {
  idx: number;
  apex: number; // sim mm
  radius: number; // mm
  vc: number; // mm/s
  zoned: boolean;
  noAttackStart: number; // sim mm
  exitEnd: number; // sim mm
  name: string;
}

export interface Climb {
  start: number;
  end: number;
  avgGrade: number; // ppm
}

export interface Course {
  id: string;
  version: number;
  name: string;
  type: "flat" | "hilly" | "mountain";
  length: number; // sim mm
  displayKm1000: number; // display length in metres
  segments: Segment[];
  corners: Corner[];
  climbs: Climb[];
  tRefS: number;
  checksum: string;
}

export function loadCourse(path: string, prm: Record<string, number>): Course {
  const text = readFileSync(path, "utf8");
  const cf = JSON.parse(text) as CourseFile;
  return buildCourse(cf, prm, checksum(text));
}

export function buildCourse(cf: CourseFile, prm: Record<string, number>, sum?: string): Course {
  const scale = prm["scale.display_per_sim"];
  const crr = prm["physics.crr"];
  const segs: Segment[] = [];
  let pos = 0;
  for (const [i, s] of cf.segments.entries()) {
    const dispMm = parseDecimal(s.length_km, PPM, `segments[${i}].length_km`); // display mm
    const len = idiv(dispMm, scale);
    const grade = parseDecimal(s.grade_pct ?? 0, 10_000, `segments[${i}].grade_pct`); // % -> ppm
    const wind = parseDecimal(s.wind_ms ?? 0, 1000, `segments[${i}].wind_ms`);
    if (len <= 0) throw new Error(`segments[${i}]: length_km must be > 0`);
    segs.push({ start: pos, end: pos + len, grade, slope: slopeFor(grade, crr), wind, label: s.label ?? "" });
    pos += len;
  }
  const length = pos;
  const aLat = prm["physics.a_lat_ms2"]; // mm/s2
  const zoneMax = idiv(prm["corner.zone_max_vc_kmh"] * 1000, 3600); // km/h*1000 -> mm/s
  const noAtk = idiv(prm["corner.no_attack_zone_m"], scale); // display mm -> sim mm
  const exitZ = idiv(prm["corner.exit_zone_m"], scale);
  const corners: Corner[] = (cf.corners ?? [])
    .map((c, i) => {
      const apex = idiv(parseDecimal(c.at_km, PPM, `corners[${i}].at_km`), scale);
      const radius = parseDecimal(c.radius_m, 1000, `corners[${i}].radius_m`);
      const vc = isqrt(aLat * radius);
      return { idx: i, apex, radius, vc, zoned: vc < zoneMax, noAttackStart: apex - noAtk, exitEnd: apex + exitZ, name: c.name ?? `C${i + 1}` };
    })
    .sort((a, b) => a.apex - b.apex || a.idx - b.idx);
  corners.forEach((c, i) => (c.idx = i));
  for (const c of corners) if (c.apex <= 0 || c.apex >= length) throw new Error(`corner ${c.name} is outside the course`);

  // climbs: contiguous segments with grade >= 3%
  const climbs: Climb[] = [];
  let cur: Climb | null = null;
  let rise = 0;
  for (const s of segs) {
    if (s.grade >= 30_000) {
      if (!cur) { cur = { start: s.start, end: s.end, avgGrade: 0 }; rise = 0; }
      cur.end = s.end;
      rise += mulDiv(s.end - s.start, s.grade, PPM);
    } else if (cur) {
      cur.avgGrade = mulDiv(rise, PPM, cur.end - cur.start);
      climbs.push(cur);
      cur = null;
    }
  }
  if (cur) { cur.avgGrade = mulDiv(rise, PPM, cur.end - cur.start); climbs.push(cur); }

  let tRefS = cf.t_ref_s !== undefined ? parseDecimal(cf.t_ref_s, 1, "t_ref_s") : 0;
  if (!tRefS) tRefS = estimateTRef(segs, prm);
  return {
    id: cf.id, version: cf.version, name: cf.name ?? cf.id, type: cf.type ?? "flat",
    length, displayKm1000: idiv(length * scale, 1000), segments: segs, corners, climbs, tRefS,
    checksum: sum ?? checksum(JSON.stringify(cf)),
  };
}

/** Rough expected sim time when the course file has no t_ref_s: reference rider at the flat reference speed's power. */
function estimateTRef(segs: Segment[], prm: Record<string, number>): number {
  const mass = 76_500, g = prm["physics.g"];
  const coef = aeroCoef(prm["physics.rho"], 300_000, 650_000);
  const flat = slopeFor(0, prm["physics.crr"]);
  const vRef = prm["stamina.t_ref_speed_ms"];
  // power that gives vRef on the flat inside the bunch
  let lo = 0, hi = 2_000_000;
  const need = (pw: number) => steadySpeed(pw, mass, g, flat, coef, 0, 30_000);
  while (hi - lo > 1000) { const m = idiv(lo + hi, 2); if (need(m) < vRef) lo = m; else hi = m; }
  let t = 0;
  for (const s of segs) {
    const v = Math.max(3000, steadySpeed(hi, mass, g, s.slope, coef, s.wind, prm["physics.v_max_descent_ms"]));
    t += idiv(s.end - s.start, v);
  }
  return t;
}

export function segmentAt(course: Course, s: number, hint = 0): number {
  const segs = course.segments;
  let i = hint < segs.length ? hint : 0;
  if (s < segs[i].start) i = 0;
  while (i < segs.length - 1 && s >= segs[i].end) i++;
  return i;
}

export type ZoneKind = "none" | "no_attack" | "exit";

/** Zone at sim position s. No-attack zone has priority when zones overlap (core §2-11). */
export function zoneAt(course: Course, s: number): { kind: ZoneKind; corner: Corner | null } {
  let exit: Corner | null = null;
  for (const c of course.corners) {
    if (!c.zoned) continue;
    if (s >= c.noAttackStart && s < c.apex) return { kind: "no_attack", corner: c };
    if (s >= c.apex && s <= c.exitEnd && !exit) exit = c;
  }
  return exit ? { kind: "exit", corner: exit } : { kind: "none", corner: null };
}

/** Course-level warnings of core §9-4 (checked when a course is published/used). */
export function validateCourse(course: Course, prm: Record<string, number>): string[] {
  const w: string[] = [];
  const scale = prm["scale.display_per_sim"];
  const last5 = idiv(5_000_000, scale); // display 5km in sim mm
  const from = Math.max(0, course.length - last5);
  let blocked = 0;
  for (let s = from; s < course.length; s += 1000) if (zoneAt(course, s).kind === "no_attack") blocked += 1000;
  if (blocked * 2 > course.length - from) w.push(`[コース警告] ゴール前の表示5kmのうち、アタック禁止ゾーンが50%を超えています（${Math.round((blocked * 100) / (course.length - from))}%）`);
  const lo = idiv(prm["sprint.launch_min_m"], scale), hi = idiv(prm["sprint.launch_max_m"], scale);
  let free = false;
  for (let d = lo; d <= hi; d += 1000) if (zoneAt(course, course.length - d).kind !== "no_attack") { free = true; break; }
  if (!free) w.push("[コース警告] スプリントの発動範囲がすべてアタック禁止ゾーンに入っています");
  for (const c of course.corners) if (c.radius < 3000) w.push(`[コース警告] コーナー ${c.name} の半径が3m未満です`);
  return w;
}
