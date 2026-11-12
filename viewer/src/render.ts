import type { Replay } from "./data";
import { at, Path } from "./geom";
import { LANE_W, ROAD_W, Scene } from "./scene";

export interface Camera { x: number; y: number; rot: number; zoom: number; }

export interface Bubble { rider: number; text: string; color: string; age: number; }

export interface MapState {
  rp: Replay;
  path: Path;
  scene: Scene;
  cam: Camera;
  selected: number;
  bubbles: Bubble[];
  banner: string;
  screenPos: Float32Array; // out: rider screen x,y (NaN when hidden)
}

export const EVENT_STYLE: Record<string, { label: string; color: string }> = {
  attack: { label: "アタック！", color: "#ff4d4d" },
  corner_attack: { label: "立ち上がりアタック！", color: "#ff7a1a" },
  attack_fail: { label: "アタック不発", color: "#b0b0b0" },
  check: { label: "チェック", color: "#4db8ff" },
  check_shed: { label: "振り切られた", color: "#7aa7c7" },
  bridge: { label: "ブリッジ！", color: "#ffb84d" },
  bridge_ok: { label: "ブリッジ成功", color: "#ffd24d" },
  bridge_fail: { label: "ブリッジ失敗", color: "#b0b0b0" },
  bonk: { label: "ハンガーノック", color: "#b36bff" },
  bonk_recover: { label: "回復", color: "#9ad17a" },
  item_recovery: { label: "補給", color: "#5cd65c" },
  item_boost: { label: "ブースト！", color: "#ffe14d" },
  drop: { label: "遅れた", color: "#999999" },
  chase: { label: "追走開始", color: "#4dd2ff" },
  chase_end: { label: "牽引終了", color: "#7aa" },
  sprint: { label: "スプリント！", color: "#ffd700" },
  catch: { label: "吸収", color: "#ff66cc" },
  finish: { label: "ゴール", color: "#ffffff" },
  other: { label: "", color: "#ccc" },
};

const MODE_JA: Record<string, string> = {
  sit: "集団内", block: "ブロック", check: "チェック", situp: "様子見", pull: "牽引", chase: "追走", break: "逃げ",
  attack: "アタック", hunt: "チェック追走", follow: "マーク", bridge: "ブリッジ", sprint: "スプリント",
};
export const modeJa = (m: string) => MODE_JA[m] ?? m;

function worldToScreen(c: Camera, w: number, h: number, x: number, y: number): [number, number] {
  const dx = x - c.x, dy = y - c.y;
  const cs = Math.cos(c.rot), sn = Math.sin(c.rot);
  return [w / 2 + (dx * cs - dy * sn) * c.zoom, h * 0.58 + (dx * sn + dy * cs) * c.zoom];
}

export function drawMap(ctx: CanvasRenderingContext2D, w: number, h: number, st: MapState): void {
  const { rp, path, scene, cam } = st;
  ctx.save();
  ctx.fillStyle = "#3f6b3a";
  ctx.fillRect(0, 0, w, h);
  ctx.translate(w / 2, h * 0.58);
  ctx.scale(cam.zoom, cam.zoom);
  ctx.rotate(cam.rot);
  ctx.translate(-cam.x, -cam.y);
  const radius = Math.hypot(w, h) / cam.zoom;
  const vis = path.chunks.filter((c) => c.maxX > cam.x - radius && c.minX < cam.x + radius && c.maxY > cam.y - radius && c.minY < cam.y + radius);
  const stride = Math.max(1, Math.floor(1.2 / cam.zoom));
  const strokeRange = (from: number, to: number, d: number) => {
    ctx.beginPath();
    for (let i = from; i <= to; i += stride) {
      const p = at(path, i * path.step, d);
      if (i === from) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
    }
    const p = at(path, to * path.step, d);
    ctx.lineTo(p.x, p.y);
  };
  // verge and roadside trees (deterministic, for a sense of speed)
  ctx.lineCap = "round";
  for (const c of vis) { ctx.strokeStyle = "#4d7a43"; ctx.lineWidth = Math.max(ROAD_W + 8, 3 / cam.zoom); strokeRange(c.from, c.to, 0); ctx.stroke(); }
  if (cam.zoom > 0.8) {
    const sStep = 9;
    const lo = Math.max(0, Math.floor(vis.reduce((m, c) => Math.min(m, c.from), Infinity) * path.step / sStep));
    const hi = Math.ceil(vis.reduce((m, c) => Math.max(m, c.to), 0) * path.step / sStep);
    for (let k = lo; k <= hi; k++) {
      const hsh = hash(k);
      if ((hsh & 3) === 0) continue;
      const side = hsh & 4 ? 1 : -1;
      const off = side * (ROAD_W / 2 + 5 + ((hsh >>> 3) % 22));
      const p = at(path, k * sStep + ((hsh >>> 8) % 7), off);
      if (Math.abs(p.x - cam.x) > radius || Math.abs(p.y - cam.y) > radius) continue;
      const r = 1.6 + ((hsh >>> 12) % 20) / 10;
      ctx.fillStyle = "rgba(0,0,0,0.18)";
      ctx.beginPath(); ctx.arc(p.x + 0.7, p.y + 0.7, r, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = (hsh >>> 16) % 3 === 0 ? "#2f5a2c" : (hsh >>> 16) % 3 === 1 ? "#386b33" : "#29502a";
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill();
    }
  }
  ctx.lineJoin = "round";
  for (const c of vis) { ctx.strokeStyle = "#c9c2a8"; ctx.lineWidth = Math.max(ROAD_W + 1.2, 2.5 / cam.zoom); strokeRange(c.from, c.to, 0); ctx.stroke(); }
  for (const c of vis) { ctx.strokeStyle = "#45484d"; ctx.lineWidth = Math.max(ROAD_W, 1.6 / cam.zoom); strokeRange(c.from, c.to, 0); ctx.stroke(); }
  // corner zones (D43/D44)
  for (const cn of rp.file.course.corners) {
    if (!cn.zoned) continue;
    const a = Math.floor(cn.no_attack_from_m / path.step), ap = Math.floor(cn.apex_m / path.step), b = Math.floor(cn.exit_to_m / path.step);
    if (!vis.some((c) => c.to >= a && c.from <= b)) continue;
    ctx.lineCap = "butt";
    ctx.strokeStyle = "rgba(235,60,60,0.42)"; ctx.lineWidth = Math.max(ROAD_W, 2 / cam.zoom); strokeRange(a, ap, 0); ctx.stroke();
    ctx.strokeStyle = "rgba(60,210,130,0.40)"; strokeRange(ap, b, 0); ctx.stroke();
    ctx.lineCap = "round";
  }
  if (cam.zoom > 1.2) {
    ctx.strokeStyle = "rgba(255,255,255,0.85)"; ctx.lineWidth = 0.12;
    for (const c of vis) { strokeRange(c.from, c.to, -LANE_W * 3); ctx.stroke(); strokeRange(c.from, c.to, LANE_W * 3); ctx.stroke(); }
    ctx.setLineDash([3, 5]); ctx.strokeStyle = "rgba(255,255,255,0.35)"; ctx.lineWidth = 0.08;
    for (const c of vis) for (let l = -2; l <= 2; l++) { strokeRange(c.from, c.to, l * LANE_W); ctx.stroke(); }
    ctx.setLineDash([]);
  }
  // finish and start lines
  const line = (s: number, checker: boolean) => {
    const p = at(path, s);
    ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.h);
    if (checker) {
      for (let i = 0; i < 12; i++) for (let j = 0; j < 2; j++) { ctx.fillStyle = (i + j) % 2 ? "#111" : "#fff"; ctx.fillRect(j * 0.6 - 0.6, -ROAD_W / 2 + (i * ROAD_W) / 12, 0.6, ROAD_W / 12); }
    } else { ctx.fillStyle = "#fff"; ctx.fillRect(-0.2, -ROAD_W / 2, 0.4, ROAD_W); }
    ctx.restore();
  };
  line(0, false);
  line(rp.length, true);
  ctx.restore();

  // labels in screen space (stay upright)
  ctx.save();
  ctx.textBaseline = "middle";
  const S = (s: number, d: number) => { const p = at(path, s, d); return worldToScreen(cam, w, h, p.x, p.y); };
  const inView = (x: number, y: number, m = 60) => x > -m && x < w + m && y > -m && y < h + m;
  const scale = rp.file.params.display_per_sim;
  // km markers (display km)
  const kmStep = cam.zoom > 3 ? 1 : cam.zoom > 0.6 ? 5 : cam.zoom > 0.15 ? 10 : 0;
  if (kmStep) {
    ctx.font = "12px 'Noto Sans JP', 'WenQuanYi Micro Hei', sans-serif";
    const total = rp.length * scale / 1000;
    for (let km = kmStep; km < total; km += kmStep) {
      const [x, y] = S((km * 1000) / scale, ROAD_W / 2 + 3);
      if (!inView(x, y)) continue;
      const rem = Math.round(total - km);
      drawPill(ctx, x, y, `残り${rem}km`, "rgba(20,30,20,0.75)", "#e8f0d8");
    }
  }
  for (const cn of rp.file.course.corners) {
    const [x, y] = S(cn.apex_m, -ROAD_W / 2 - 6);
    if (!inView(x, y)) continue;
    ctx.font = "bold 13px 'Noto Sans JP', 'WenQuanYi Micro Hei', sans-serif";
    drawPill(ctx, x, y, `${cn.name}  R${cn.radius_m}m`, "rgba(40,20,10,0.8)", "#ffd9a8");
    if (cn.zoned && cam.zoom > 1.5) {
      ctx.font = "11px 'Noto Sans JP', 'WenQuanYi Micro Hei', sans-serif";
      const [ax, ay] = S((cn.no_attack_from_m + cn.apex_m) / 2, ROAD_W / 2 + 4);
      if (inView(ax, ay)) drawPill(ctx, ax, ay, "アタック禁止", "rgba(170,30,30,0.85)", "#fff");
      const [ex, ey] = S((cn.apex_m + cn.exit_to_m) / 2, ROAD_W / 2 + 4);
      if (inView(ex, ey)) drawPill(ctx, ex, ey, "立ち上がり", "rgba(20,120,70,0.85)", "#fff");
    }
  }
  {
    const [x, y] = S(rp.length, -ROAD_W / 2 - 5);
    if (inView(x, y)) { ctx.font = "bold 14px 'Noto Sans JP', 'WenQuanYi Micro Hei', sans-serif"; drawPill(ctx, x, y, "ゴール", "#111", "#fff"); }
  }

  // riders
  const sp = st.screenPos;
  const lod = cam.zoom >= 2.2 ? 2 : cam.zoom >= 0.5 ? 1 : 0;
  const order = scene.riders.map((_, i) => i).sort((a, b) => scene.riders[a].s - scene.riders[b].s);
  for (const i of order) {
    const r = scene.riders[i];
    sp[i * 2] = NaN; sp[i * 2 + 1] = NaN;
    if (!r.on) continue;
    const p = at(path, Math.min(r.s, path.length + 200), r.d);
    const [x, y] = worldToScreen(cam, w, h, p.x, p.y);
    if (!inView(x, y, 20)) continue;
    sp[i * 2] = x; sp[i * 2 + 1] = y;
    const col = rp.teamColor[rp.file.riders[i].team];
    if (lod === 0) { ctx.fillStyle = col; ctx.fillRect(x - 1.5, y - 1.5, 3, 3); continue; }
    if (lod === 1) {
      ctx.beginPath(); ctx.arc(x, y, Math.max(2, 0.45 * cam.zoom), 0, Math.PI * 2); ctx.fillStyle = col; ctx.fill();
      if (i === st.selected) { ctx.strokeStyle = "#fff"; ctx.lineWidth = 2; ctx.stroke(); }
      continue;
    }
    const z = cam.zoom;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(p.h + cam.rot);
    // glow by mode
    const glow = r.mode === "attack" || r.mode === "bridge" ? "#ff4d4d" : r.mode === "sprint" ? "#ffd700" : r.bonk ? "#b36bff" : null;
    if (glow) { ctx.beginPath(); ctx.ellipse(0, 0, 1.4 * z, 0.75 * z, 0, 0, Math.PI * 2); ctx.fillStyle = glow + "55"; ctx.fill(); }
    // bike + rider (placeholder shapes)
    ctx.fillStyle = "#1a1a1a";
    ctx.fillRect(-0.85 * z, -0.06 * z, 1.7 * z, 0.12 * z);
    ctx.beginPath(); ctx.ellipse(-0.1 * z, 0, 0.62 * z, 0.27 * z, 0, 0, Math.PI * 2); ctx.fillStyle = col; ctx.fill();
    ctx.lineWidth = Math.max(1, 0.05 * z); ctx.strokeStyle = "rgba(0,0,0,0.6)"; ctx.stroke();
    ctx.beginPath(); ctx.arc(0.45 * z, 0, 0.16 * z, 0, Math.PI * 2); ctx.fillStyle = "#f4f4f4"; ctx.fill(); ctx.stroke();
    if (i === st.selected) { ctx.beginPath(); ctx.arc(0, 0, 1.25 * z, 0, Math.PI * 2); ctx.strokeStyle = "#fff"; ctx.lineWidth = 2.5; ctx.stroke(); }
    ctx.restore();
  }
  // group labels
  const placed: number[] = [];
  const free = (x: number, y: number, tw: number): boolean => {
    for (let k = 0; k < placed.length; k += 3) {
      if (Math.abs(placed[k] - x) < (placed[k + 2] + tw) / 2 + 4 && Math.abs(placed[k + 1] - y) < 22) return false;
    }
    placed.push(x, y, tw);
    return true;
  };
  ctx.font = "bold 13px 'Noto Sans JP', 'WenQuanYi Micro Hei', sans-serif";
  for (const g of [...scene.groups].sort((a, b) => b.size - a.size)) {
    const [x, y] = S(g.head + 4, ROAD_W / 2 + 7);
    if (!inView(x, y) || !free(x, y, ctx.measureText(g.label).width + 16)) continue;
    drawPill(ctx, x, y, g.label, g.short === "逃げ" ? "rgba(200,40,40,0.9)" : g.short === "メイン集団" ? "rgba(30,60,140,0.9)" : "rgba(40,40,40,0.85)", "#fff");
  }
  // event bubbles, newest first
  ctx.font = "bold 14px 'Noto Sans JP', 'WenQuanYi Micro Hei', sans-serif";
  for (let k = st.bubbles.length - 1; k >= 0; k--) {
    const b = st.bubbles[k];
    const x = sp[b.rider * 2], y = sp[b.rider * 2 + 1];
    if (!Number.isFinite(x)) continue;
    const lift = 22 + b.age * 18;
    if (!free(x, y - lift, ctx.measureText(b.text).width + 16)) continue;
    ctx.globalAlpha = Math.max(0, 1 - b.age * 0.6);
    drawPill(ctx, x, y - lift, b.text, "rgba(0,0,0,0.75)", b.color);
    ctx.globalAlpha = 1;
  }
  if (st.selected >= 0) {
    const x = sp[st.selected * 2], y = sp[st.selected * 2 + 1];
    if (Number.isFinite(x)) { ctx.font = "bold 12px 'Noto Sans JP', 'WenQuanYi Micro Hei', sans-serif"; drawPill(ctx, x, y + 20, rp.file.riders[st.selected].name, "rgba(255,255,255,0.92)", "#111"); }
  }
  if (st.banner) {
    ctx.font = "bold 16px 'Noto Sans JP', 'WenQuanYi Micro Hei', sans-serif";
    drawPill(ctx, w / 2, 26, st.banner, "rgba(0,0,0,0.7)", "#fff");
  }
  ctx.restore();
}

export function drawPill(ctx: CanvasRenderingContext2D, x: number, y: number, text: string, bg: string, fg: string): void {
  const tw = ctx.measureText(text).width;
  const hgt = parseInt(ctx.font.match(/(\d+)px/)?.[1] ?? "12", 10) + 8;
  ctx.fillStyle = bg;
  const rx = x - tw / 2 - 7, ry = y - hgt / 2;
  ctx.beginPath();
  ctx.roundRect(rx, ry, tw + 14, hgt, hgt / 2);
  ctx.fill();
  ctx.fillStyle = fg;
  ctx.textAlign = "center";
  ctx.fillText(text, x, y + 1);
}

/** Whole-course overview with group dots. */
export function drawMinimap(ctx: CanvasRenderingContext2D, w: number, h: number, path: Path, scene: Scene, rp: Replay, camS: number): void {
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "rgba(10,20,10,0.72)";
  ctx.beginPath(); ctx.roundRect(0, 0, w, h, 10); ctx.fill();
  const b = path.bbox, pad = 12;
  const sc = Math.min((w - pad * 2) / (b.maxX - b.minX || 1), (h - pad * 2) / (b.maxY - b.minY || 1));
  const ox = pad + ((w - pad * 2) - (b.maxX - b.minX) * sc) / 2, oy = pad + ((h - pad * 2) - (b.maxY - b.minY) * sc) / 2;
  const P = (x: number, y: number): [number, number] => [ox + (x - b.minX) * sc, oy + (y - b.minY) * sc];
  ctx.strokeStyle = "#b8b8b8"; ctx.lineWidth = 2;
  ctx.beginPath();
  const step = Math.max(1, Math.floor(path.x.length / 600));
  for (let i = 0; i < path.x.length; i += step) { const [x, y] = P(path.x[i], path.y[i]); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
  ctx.stroke();
  for (const cn of rp.file.course.corners) { const p = at(path, cn.apex_m); const [x, y] = P(p.x, p.y); ctx.fillStyle = cn.zoned ? "#ff6b6b" : "#ffb36b"; ctx.fillRect(x - 2, y - 2, 4, 4); }
  { const p = at(path, rp.length); const [x, y] = P(p.x, p.y); ctx.fillStyle = "#fff"; ctx.fillRect(x - 3, y - 3, 6, 6); }
  for (const g of scene.groups) {
    const p = at(path, g.head); const [x, y] = P(p.x, p.y);
    ctx.beginPath(); ctx.arc(x, y, 2.5 + Math.sqrt(g.size) * 0.6, 0, Math.PI * 2);
    ctx.fillStyle = g.short === "逃げ" ? "#ff5050" : g.short === "メイン集団" ? "#5b8cff" : "#dddddd"; ctx.fill();
  }
  { const p = at(path, camS); const [x, y] = P(p.x, p.y); ctx.strokeStyle = "#ffe14d"; ctx.lineWidth = 2; ctx.strokeRect(x - 6, y - 6, 12, 12); }
}

function hash(k: number): number {
  let x = (k * 2654435761) >>> 0;
  x ^= x >>> 15; x = Math.imul(x, 2246822519) >>> 0; x ^= x >>> 13;
  return x >>> 0;
}
