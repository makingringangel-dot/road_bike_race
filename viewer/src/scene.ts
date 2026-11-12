import { frameAt, Replay } from "./data";

export const LANE_W = 0.9; // m (6 abreast)
export const ROAD_W = LANE_W * 6 + 0.8;

export interface RiderView {
  s: number; // metres along the course (may exceed length after the finish)
  d: number; // lateral offset, + = right of travel
  on: boolean; // on the road (not DNF)
  finished: boolean;
  mode: string;
  bonk: boolean;
  grp: number; // 1-based group index in the current keyframe, 0 = none
  v: number; // m/s
  line: boolean;
}

export interface GroupView {
  idx: number; // 1-based
  head: number;
  tail: number;
  size: number;
  v: number;
  gapS: number;
  label: string;
  short: string;
  riders: number[];
}

export interface Scene { t: number; k: number; riders: RiderView[]; groups: GroupView[]; leaderS: number; }

const PACER = new Set(["pull", "chase", "break"]);
const smooth = (x: number) => x * x * (3 - 2 * x);
const mod = (a: number, n: number) => ((a % n) + n) % n;

function laneOffset(slot: number): number {
  const lane = slot >= 10 ? 3 : slot;
  return (lane - 3.5) * LANE_W;
}

/** Hermite interpolation of a rider's distance between keyframes using the group speeds at both ends. */
function hermite(s0: number, s1: number, v0: number, v1: number, h: number, a: number): number {
  const a2 = a * a, a3 = a2 * a;
  return (2 * a3 - 3 * a2 + 1) * s0 + (a3 - 2 * a2 + a) * h * v0 + (-2 * a3 + 3 * a2) * s1 + (a3 - a2) * h * v1;
}

export function buildScene(rp: Replay, t: number, prev?: Scene): Scene {
  const F = rp.times.length;
  const k = frameAt(rp, t);
  const k1 = Math.min(k + 1, F - 1);
  const t0 = rp.times[k], t1 = rp.times[k1];
  const h = Math.max(1e-6, t1 - t0);
  const a = k1 === k ? 0 : Math.max(0, Math.min(1, (t - t0) / h));
  const P0 = rp.pos[k], P1 = rp.pos[k1];
  const G0 = rp.groups[k], G1 = rp.groups[k1];
  const spacing = rp.file.params.row_spacing_m;
  const R = rp.file.params.rotate_s;
  const L = rp.length;
  const riders: RiderView[] = [];
  for (let i = 0; i < rp.n; i++) {
    const g0 = rp.grp[k][i], g1 = rp.grp[k1][i];
    const sl0 = rp.slot[k][i], sl1 = rp.slot[k1][i];
    const mraw = rp.mode[k][i];
    const mode = rp.file.modes[mraw & 15] ?? "sit";
    const meta = rp.file.riders[i];
    let s: number;
    let v = g0 > 0 ? G0[g0 - 1].v : 0;
    if (g0 > 0 && g1 > 0) {
      const v1 = G1[g1 - 1].v;
      const lin = P0[i] + (P1[i] - P0[i]) * a;
      const her = hermite(P0[i], P1[i], v, v1, h, a);
      s = Math.abs((P1[i] - P0[i]) / h - (v + v1) / 2) > 2.5 ? lin : her;
      v = v + (v1 - v) * a;
    } else s = P0[i] + (P1[i] - P0[i]) * a;
    const finished = meta.finish_s !== null && t >= meta.finish_s;
    let d: number;
    if (finished) {
      const tau = Math.min(14, t - meta.finish_s!);
      s = L + 11 * tau - 0.4 * tau * tau;
      d = (((meta.rank ?? 1) - 1) % 6 - 2.5) * LANE_W;
      v = Math.max(0, 11 - 0.8 * tau);
    } else {
      const da = sl0 > 0 ? laneOffset(sl0) : prev?.riders[i]?.d ?? 0;
      const db = sl1 > 0 ? laneOffset(sl1) : da;
      d = da + (db - da) * smooth(a);
    }
    let line = false;
    if (!finished && sl0 >= 10 && g0 > 0) {
      const gi = G0[g0 - 1];
      const n = gi.line;
      if (n >= 2 && PACER.has(mode)) {
        // the engine keeps the pace line in a fixed order and only rotates who takes the wind;
        // show the rotation: the front rider swings out and drifts to the back
        line = true;
        const li = sl0 - 10;
        const per = Math.floor(t / R);
        const f = t - per * R;
        const tw = Math.min(4, R * 0.4);
        const pNow = mod(li - per, n), pPrev = mod(li - per + 1, n);
        let pDisp = pNow, swing = 0;
        if (f < tw) {
          const e = smooth(f / tw);
          pDisp = pPrev + (pNow - pPrev) * e;
          if (pPrev === 0) swing = Math.sin(Math.PI * e) * LANE_W * 1.1;
        }
        s += (li - pDisp) * spacing;
        d += swing;
      }
    }
    if (!finished && !line) {
      d += 0.12 * Math.sin(t * 0.7 + i * 1.7);
      s += 0.2 * Math.sin(t * 0.43 + i * 2.3);
    }
    riders.push({ s, d, on: g0 > 0 || finished || g1 > 0, finished, mode, bonk: (mraw & 16) !== 0, grp: finished ? 0 : g0, v, line });
  }
  // groups (from the current keyframe, heads from interpolated riders)
  const groups: GroupView[] = G0.map((g, j) => ({ idx: j + 1, head: -Infinity, tail: Infinity, size: g.size, v: g.v, gapS: 0, label: "", short: "", riders: [] }));
  riders.forEach((r, i) => {
    if (r.finished || r.grp <= 0) return;
    const g = groups[r.grp - 1];
    if (!g) return;
    g.riders.push(i);
    g.head = Math.max(g.head, r.s);
    g.tail = Math.min(g.tail, r.s);
  });
  const live = groups.filter((g) => g.riders.length > 0);
  const leaderS = live.length ? live[0].head : L;
  let big = live[0];
  for (const g of live) if (g.size > (big?.size ?? 0)) big = g;
  // one reference speed keeps the gaps ordered like the groups
  const vRef = Math.max(live[0]?.v ?? 1, 1);
  live.forEach((g, j) => {
    g.gapS = j === 0 ? 0 : (leaderS - g.head) / vRef;
    const n = g.size;
    let name: string;
    if (g === big) name = live.length === 1 ? "メイン集団" : j === 0 ? "先頭集団" : "メイン集団";
    else if (j === 0) name = n <= 12 ? "逃げ" : "先頭集団";
    else if (big && live.indexOf(big) > j) name = "追走";
    else name = n >= 10 ? "後方集団" : "遅れ";
    g.short = name;
    g.label = `${name} ${n}人 ${j === 0 ? "先頭" : fmtGap(g.gapS)}`;
  });
  return { t, k, riders, groups: live, leaderS };
}

export function fmtGap(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `+${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function fmtClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  return `${hh}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}
