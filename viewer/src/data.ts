export type EventKind =
  | "attack" | "corner_attack" | "attack_fail" | "check" | "check_shed" | "bridge" | "bridge_ok" | "bridge_fail"
  | "bonk" | "bonk_recover" | "item_recovery" | "item_boost" | "drop" | "chase" | "chase_end" | "sprint" | "catch" | "finish" | "other";

export interface ReplayFile {
  format: string;
  version: number;
  meta: { course_id: string; course_name: string; course_type: string; param_version: number; ticks: number; winner: string; engine_version: string; ai_seed: number };
  params: { display_per_sim: number; row_spacing_m: number; lanes: number; rotate_s: number; wait_rotate_s: number };
  modes: string[];
  course: {
    length_m: number;
    segments: { from_m: number; to_m: number; grade_pct: number; wind_ms: number; label: string }[];
    corners: { apex_m: number; radius_m: number; vc_kmh: number; zoned: boolean; no_attack_from_m: number; exit_to_m: number; name: string }[];
    climbs: { from_m: number; to_m: number }[];
    profile: number[][];
  };
  teams: { id: string; name: string; ai: boolean; template: string }[];
  riders: { id: string; name: string; team: number; job: string; role: string; finish_s: number | null; rank: number | null }[];
  events: { t: number; kind: EventKind; rider: number; team: number; text: string }[];
  stats: { t: number[]; v: number[][] };
  frames: { t: number; g: number[]; d: number[]; l: number[]; m: number[]; q: number[] }[];
}

export interface GroupInfo { head: number; v: number; size: number; w: number; line: number; }

/** Decoded replay: absolute positions per keyframe (metres along the sim course). */
export interface Replay {
  file: ReplayFile;
  n: number;
  times: Float64Array;
  pos: Float32Array[]; // [frame][rider] metres
  slot: Int8Array[];
  mode: Int8Array[];
  grp: Int16Array[];
  groups: GroupInfo[][];
  duration: number;
  length: number;
  teamColor: string[];
}

export async function loadReplayBytes(buf: ArrayBuffer): Promise<ReplayFile> {
  const u8 = new Uint8Array(buf);
  let text: string;
  if (u8[0] === 0x1f && u8[1] === 0x8b) {
    const ds = new Response(new Blob([u8]).stream().pipeThrough(new DecompressionStream("gzip")));
    text = await ds.text();
  } else text = new TextDecoder().decode(u8);
  const f = JSON.parse(text) as ReplayFile;
  if (f.format !== "road-race-replay") throw new Error("リプレイファイルではありません");
  return f;
}

export function teamColors(n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const h = Math.round((i * 360 * 0.381966) % 360);
    const l = i % 3 === 0 ? 52 : i % 3 === 1 ? 64 : 42;
    out.push(`hsl(${h} 78% ${l}%)`);
  }
  return out;
}

export function decode(file: ReplayFile): Replay {
  const n = file.riders.length;
  const F = file.frames.length;
  const times = new Float64Array(F);
  const pos: Float32Array[] = [];
  const slot: Int8Array[] = [], mode: Int8Array[] = [], grp: Int16Array[] = [];
  const groups: GroupInfo[][] = [];
  const acc = new Int32Array(n);
  file.frames.forEach((fr, k) => {
    times[k] = fr.t;
    const p = new Float32Array(n);
    for (let i = 0; i < n; i++) { acc[i] = k === 0 ? fr.d[i] : acc[i] + fr.d[i]; p[i] = acc[i] / 10; }
    pos.push(p);
    slot.push(Int8Array.from(fr.l));
    mode.push(Int8Array.from(fr.m));
    grp.push(Int16Array.from(fr.q));
    const gs: GroupInfo[] = [];
    for (let j = 0; j < fr.g.length; j += 5) gs.push({ head: fr.g[j] / 10, v: fr.g[j + 1] / 10, size: fr.g[j + 2], w: fr.g[j + 3], line: fr.g[j + 4] });
    groups.push(gs);
  });
  return { file, n, times, pos, slot, mode, grp, groups, duration: times[F - 1], length: file.course.length_m, teamColor: teamColors(file.teams.length) };
}

/** Index k with times[k] <= t < times[k+1] (clamped). */
export function frameAt(rp: Replay, t: number): number {
  const ts = rp.times;
  if (t <= ts[0]) return 0;
  if (t >= ts[ts.length - 1]) return ts.length - 1;
  let lo = 0, hi = ts.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (ts[mid] <= t) lo = mid; else hi = mid; }
  return lo;
}

export function statAt(rp: Replay, i: number, t: number): { fuel: number; burst: number; rec: number; boost: number } {
  const st = rp.file.stats;
  if (!st.t.length) return { fuel: 0, burst: 0, rec: 0, boost: 0 };
  let k = 0;
  while (k + 1 < st.t.length && st.t[k + 1] <= t) k++;
  const a = st.v[k], b = st.v[Math.min(k + 1, st.t.length - 1)];
  const span = (st.t[Math.min(k + 1, st.t.length - 1)] - st.t[k]) || 1;
  const f = Math.max(0, Math.min(1, (t - st.t[k]) / span));
  const lerp = (x: number, y: number) => x + (y - x) * f;
  return { fuel: lerp(a[i * 4], b[i * 4]), burst: lerp(a[i * 4 + 1], b[i * 4 + 1]), rec: a[i * 4 + 2], boost: a[i * 4 + 3] };
}
