import type { Replay } from "./data";
import { EVENT_STYLE } from "./render";
import type { Scene } from "./scene";

const FONT = "'Noto Sans JP', 'WenQuanYi Micro Hei', sans-serif";

export function drawProfile(ctx: CanvasRenderingContext2D, w: number, h: number, rp: Replay, scene: Scene, camS: number, selS: number | null): void {
  const c = rp.file.course;
  const L = rp.length, scale = rp.file.params.display_per_sim;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#141a22"; ctx.fillRect(0, 0, w, h);
  const alts = c.profile.map((p) => p[1]);
  const lo = Math.min(...alts), hi = Math.max(...alts, lo + 50);
  const padL = 44, padR = 10, padT = 14, padB = 20;
  const X = (s: number) => padL + (s / L) * (w - padL - padR);
  const Y = (a: number) => padT + (1 - (a - lo) / (hi - lo)) * (h - padT - padB);
  for (const cl of c.climbs) { ctx.fillStyle = "rgba(255,170,60,0.10)"; ctx.fillRect(X(cl.from_m), padT, X(cl.to_m) - X(cl.from_m), h - padT - padB); }
  const grad = ctx.createLinearGradient(0, padT, 0, h - padB);
  grad.addColorStop(0, "#7f9f6a"); grad.addColorStop(1, "#2d3d2a");
  ctx.beginPath(); ctx.moveTo(X(0), h - padB);
  for (const p of c.profile) ctx.lineTo(X(p[0]), Y(p[1]));
  ctx.lineTo(X(L), h - padB); ctx.closePath(); ctx.fillStyle = grad; ctx.fill();
  ctx.strokeStyle = "#cfe3b8"; ctx.lineWidth = 1.5;
  ctx.beginPath(); c.profile.forEach((p, i) => (i ? ctx.lineTo(X(p[0]), Y(p[1])) : ctx.moveTo(X(p[0]), Y(p[1])))); ctx.stroke();
  ctx.font = `10px ${FONT}`; ctx.fillStyle = "#8a96a8"; ctx.textAlign = "right"; ctx.textBaseline = "middle";
  ctx.fillText(`${Math.round(hi)}m`, padL - 6, Y(hi)); ctx.fillText(`${Math.round(lo)}m`, padL - 6, Y(lo));
  ctx.textAlign = "center"; ctx.textBaseline = "top";
  const total = (L * scale) / 1000;
  const kmStep = total > 80 ? 10 : 5;
  for (let km = 0; km <= total; km += kmStep) { ctx.fillText(`${km}km`, X((km * 1000) / scale), h - padB + 4); }
  for (const cn of c.corners) {
    const x = X(cn.apex_m);
    ctx.fillStyle = cn.zoned ? "#ff6b6b" : "#ffb36b";
    ctx.beginPath(); ctx.moveTo(x, padT - 2); ctx.lineTo(x - 4, padT - 9); ctx.lineTo(x + 4, padT - 9); ctx.fill();
  }
  ctx.strokeStyle = "rgba(255,225,77,0.8)"; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(X(camS), padT); ctx.lineTo(X(camS), h - padB); ctx.stroke();
  for (const g of scene.groups) {
    const s = Math.min(L, g.head);
    const x = X(s), y = Y(altAt(c.profile, s));
    ctx.beginPath(); ctx.arc(x, y, 3 + Math.sqrt(g.size) * 0.7, 0, Math.PI * 2);
    ctx.fillStyle = g.short === "逃げ" ? "#ff5050" : g.short === "メイン集団" ? "#5b8cff" : "#dddddd";
    ctx.fill(); ctx.strokeStyle = "#000"; ctx.stroke();
  }
  if (selS !== null) { const s = Math.min(L, selS); ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.arc(X(s), Y(altAt(c.profile, s)), 3, 0, Math.PI * 2); ctx.fill(); }
  ctx.font = `bold 11px ${FONT}`; ctx.fillStyle = "#e6edf5"; ctx.textAlign = "left"; ctx.textBaseline = "top";
  ctx.fillText(`残り ${Math.max(0, ((L - scene.leaderS) * scale) / 1000).toFixed(1)} km（先頭）`, padL + 4, 2);
}

function altAt(pr: number[][], s: number): number {
  for (let i = 0; i + 1 < pr.length; i++) if (s <= pr[i + 1][0]) { const f = (s - pr[i][0]) / ((pr[i + 1][0] - pr[i][0]) || 1); return pr[i][1] + (pr[i + 1][1] - pr[i][1]) * f; }
  return pr[pr.length - 1][1];
}

export const TIMELINE_KINDS = new Set(["attack", "corner_attack", "bonk", "catch", "sprint", "bridge", "chase", "finish"]);

export function drawTimeline(ctx: CanvasRenderingContext2D, w: number, h: number, rp: Replay, t: number): void {
  ctx.clearRect(0, 0, w, h);
  const pad = 8;
  const X = (tt: number) => pad + (tt / rp.duration) * (w - pad * 2);
  ctx.fillStyle = "#1c2430"; ctx.beginPath(); ctx.roundRect(pad, h / 2 - 4, w - pad * 2, 8, 4); ctx.fill();
  ctx.fillStyle = "#3d6fd9"; ctx.beginPath(); ctx.roundRect(pad, h / 2 - 4, Math.max(0, X(t) - pad), 8, 4); ctx.fill();
  for (const e of rp.file.events) {
    if (!TIMELINE_KINDS.has(e.kind)) continue;
    const x = X(e.t);
    ctx.fillStyle = EVENT_STYLE[e.kind]?.color ?? "#ccc";
    const tall = e.kind === "attack" || e.kind === "corner_attack" || e.kind === "catch" || e.kind === "finish";
    ctx.fillRect(x - 1, tall ? 2 : h / 2 - 9, 2, tall ? h / 2 - 4 : 5);
  }
  ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.arc(X(t), h / 2, 7, 0, Math.PI * 2); ctx.fill();
}

export function timelineToTime(rp: Replay, w: number, x: number): number {
  const pad = 8;
  return Math.max(0, Math.min(rp.duration, ((x - pad) / (w - pad * 2)) * rp.duration));
}
