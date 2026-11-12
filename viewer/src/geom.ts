import type { ReplayFile } from "./data";

/**
 * Top-down road built from the 1-D course: the sim only knows distance, grade and corner radii,
 * so the map draws each corner as an arc of its radius with a turn angle chosen from its sharpness,
 * plus gentle bends on the straights. Units are sim metres.
 */
export interface Path {
  length: number;
  step: number;
  x: Float32Array;
  y: Float32Array;
  h: Float32Array; // heading (rad)
  chunks: { from: number; to: number; minX: number; minY: number; maxX: number; maxY: number }[];
  bbox: { minX: number; minY: number; maxX: number; maxY: number };
}

export function turnAngle(radius: number): number {
  if (radius <= 8) return (172 * Math.PI) / 180;
  if (radius <= 15) return (95 * Math.PI) / 180;
  if (radius <= 30) return (65 * Math.PI) / 180;
  return (40 * Math.PI) / 180;
}

export function buildPath(course: ReplayFile["course"]): Path {
  const step = 1;
  const L = course.length_m;
  const N = Math.ceil(L / step) + 2;
  const curv = new Float32Array(N);
  // gentle meanders
  for (let i = 0; i < N; i++) {
    const s = i * step;
    curv[i] = (Math.sin(s / 900) * 0.6 + Math.sin(s / 2300 + 1.3) * 0.4) / 1400;
  }
  let lastSign = 1;
  let prevHairpin = -1e9;
  course.corners.forEach((c, idx) => {
    const ang = turnAngle(c.radius_m);
    const hairpin = c.radius_m <= 8;
    let sign: number;
    if (hairpin && c.apex_m - prevHairpin < 3000) sign = -lastSign;
    else sign = idx % 2 === 0 ? 1 : -1;
    if (hairpin) prevHairpin = c.apex_m;
    lastSign = sign;
    const arc = c.radius_m * ang;
    const a = Math.max(0, Math.floor((c.apex_m - arc / 2) / step));
    const b = Math.min(N - 1, Math.ceil((c.apex_m + arc / 2) / step));
    const k = (sign * ang) / ((b - a) * step || 1);
    for (let i = a; i < b; i++) curv[i] = k;
  });
  const x = new Float32Array(N), y = new Float32Array(N), h = new Float32Array(N);
  let cx = 0, cy = 0, ch = -Math.PI / 2;
  for (let i = 0; i < N; i++) {
    x[i] = cx; y[i] = cy; h[i] = ch;
    ch += curv[i] * step;
    cx += Math.cos(ch) * step;
    cy += Math.sin(ch) * step;
  }
  const chunks: Path["chunks"] = [];
  const bbox = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const CH = 200;
  for (let from = 0; from < N - 1; from += CH) {
    const to = Math.min(N - 1, from + CH);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = from; i <= to; i++) { minX = Math.min(minX, x[i]); maxX = Math.max(maxX, x[i]); minY = Math.min(minY, y[i]); maxY = Math.max(maxY, y[i]); }
    chunks.push({ from, to, minX, minY, maxX, maxY });
    bbox.minX = Math.min(bbox.minX, minX); bbox.maxX = Math.max(bbox.maxX, maxX); bbox.minY = Math.min(bbox.minY, minY); bbox.maxY = Math.max(bbox.maxY, maxY);
  }
  return { length: L, step, x, y, h, chunks, bbox };
}

/** World position at distance s with lateral offset d (positive = right of travel). */
export function at(p: Path, s: number, d = 0): { x: number; y: number; h: number } {
  const u = Math.max(0, Math.min(p.x.length - 1.001, s / p.step));
  const i = Math.floor(u), f = u - i;
  const x = p.x[i] + (p.x[i + 1] - p.x[i]) * f;
  const y = p.y[i] + (p.y[i + 1] - p.y[i]) * f;
  let dh = p.h[i + 1] - p.h[i];
  if (dh > Math.PI) dh -= 2 * Math.PI; else if (dh < -Math.PI) dh += 2 * Math.PI;
  const h = p.h[i] + dh * f;
  return { x: x - Math.sin(h) * d, y: y + Math.cos(h) * d, h };
}

export function altitudeAt(course: ReplayFile["course"], s: number): number {
  const pr = course.profile;
  for (let i = 0; i + 1 < pr.length; i++) {
    if (s <= pr[i + 1][0]) {
      const f = (s - pr[i][0]) / ((pr[i + 1][0] - pr[i][0]) || 1);
      return pr[i][1] + (pr[i + 1][1] - pr[i][1]) * f;
    }
  }
  return pr[pr.length - 1][1];
}

export function gradeAt(course: ReplayFile["course"], s: number): number {
  for (const sg of course.segments) if (s >= sg.from_m && s < sg.to_m) return sg.grade_pct;
  return 0;
}
