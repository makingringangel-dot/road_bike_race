import { decode, loadReplayBytes, Replay, statAt } from "./data";
import { at, buildPath, Path } from "./geom";
import { drawProfile, drawTimeline, timelineToTime } from "./panels";
import { Bubble, Camera, drawMap, drawMinimap, EVENT_STYLE, modeJa } from "./render";
import { buildScene, fmtClock, fmtGap, Scene } from "./scene";

type CamMode = "lead" | "group" | "rider" | "free";
const JOB_JA: Record<string, string> = { sprinter: "スプリンター", climber: "クライマー", rouleur: "ルーラー", puncheur: "パンチャー", allrounder: "オールラウンダー" };
const ROLE_JA: Record<string, string> = { leader: "エース", escort: "護衛", puller: "牽引役", breakaway: "逃げ役", climber: "山岳エース", free: "自由" };
const BUBBLE_KINDS = new Set(["attack", "corner_attack", "attack_fail", "bridge", "bridge_ok", "bonk", "item_recovery", "item_boost", "sprint", "finish"]);
// dozens fire at once when a big group reacts; only shown for the selected rider
const QUIET_KINDS = new Set(["check", "check_shed", "drop"]);
const SPEEDS = [1, 2, 5, 10, 15, 20, 30];

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const mapCv = $<HTMLCanvasElement>("map");
const miniCv = $<HTMLCanvasElement>("mini");
const profCv = $<HTMLCanvasElement>("profile");
const tlCv = $<HTMLCanvasElement>("timeline");
const mapCtx = mapCv.getContext("2d")!;
const miniCtx = miniCv.getContext("2d")!;
const profCtx = profCv.getContext("2d")!;
const tlCtx = tlCv.getContext("2d")!;

interface State {
  rp: Replay | null;
  path: Path | null;
  scene: Scene | null;
  t: number;
  playing: boolean;
  speed: number; // 0 = auto
  camMode: CamMode;
  follow: number; // rider index anchoring group / rider camera
  selected: number;
  cam: Camera;
  camS: number;
  camOffset: number;
  rot: number;
  headUp: boolean;
  bubbles: (Bubble & { born: number })[];
  banner: { text: string; until: number };
  screenPos: Float32Array;
  lastPanel: number;
}

const st: State = {
  rp: null, path: null, scene: null, t: 0, playing: false, speed: 0, camMode: "lead", follow: -1, selected: -1,
  cam: { x: 0, y: 0, rot: 0, zoom: 14 }, camS: 0, camOffset: 0, rot: 0, headUp: true, bubbles: [], banner: { text: "", until: 0 },
  screenPos: new Float32Array(0), lastPanel: 0,
};

const autoSpeed = () => (st.rp ? Math.max(1, Math.min(30, Math.round(st.rp.duration / 300))) : 15);
const speedNow = () => (st.speed === 0 ? autoSpeed() : st.speed);

function fitCanvas(cv: HTMLCanvasElement): [number, number] {
  const r = cv.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  cv.getContext("2d")!.setTransform(dpr, 0, 0, dpr, 0, 0);
  return [r.width, r.height];
}

async function loadFrom(buf: ArrayBuffer) {
  $("loading").style.display = "flex";
  try {
    const file = await loadReplayBytes(buf);
    const rp = decode(file);
    st.rp = rp;
    st.path = buildPath(file.course);
    st.t = 0;
    st.selected = -1; st.follow = -1; st.camMode = "lead"; st.camOffset = 0;
    st.screenPos = new Float32Array(rp.n * 2);
    st.bubbles = [];
    $("courseName").textContent = `${file.meta.course_name}（パラメータ 版${file.meta.param_version}・${rp.n}人・${file.frames.length}キーフレーム）`;
    fillSpeeds();
    setCamButtons();
    st.scene = buildScene(rp, 0);
    st.camS = st.scene.leaderS;
    st.playing = true;
    $("play").textContent = "⏸";
  } catch (e) {
    alert(`読み込めませんでした: ${(e as Error).message}`);
  } finally {
    $("loading").style.display = "none";
  }
}

async function loadUrl(url: string) {
  $("loading").style.display = "flex";
  const res = await fetch(url);
  await loadFrom(await res.arrayBuffer());
}

function fillSpeeds() {
  const sel = $<HTMLSelectElement>("speed");
  sel.innerHTML = `<option value="0">自動 ×${autoSpeed()}（約5分）</option>` + SPEEDS.map((s) => `<option value="${s}">×${s}</option>`).join("");
  sel.value = String(st.speed);
}

function setCamButtons() {
  document.querySelectorAll<HTMLButtonElement>("#camBar button[data-cam]").forEach((b) => b.classList.toggle("on", b.dataset.cam === st.camMode));
}

function setCam(mode: CamMode) {
  if ((mode === "group" || mode === "rider") && st.follow < 0) {
    if (st.selected >= 0) st.follow = st.selected;
    else if (st.scene?.groups.length) st.follow = st.scene.groups[0].riders[0];
  }
  const before = st.camS;
  st.camMode = mode;
  const tgt = cameraTarget();
  if (tgt !== null) st.camOffset = before - tgt;
  setCamButtons();
}

function seek(t: number) {
  if (!st.rp) return;
  st.t = Math.max(0, Math.min(st.rp.duration, t));
  st.bubbles = [];
  const prev = st.camS;
  st.scene = buildScene(st.rp, st.t, st.scene ?? undefined);
  const tgt = cameraTarget();
  if (tgt !== null) st.camOffset = Math.abs(prev - tgt) > 2000 ? 0 : prev - tgt;
}

function cameraTarget(): number | null {
  const sc = st.scene;
  if (!sc || !sc.groups.length) return sc ? sc.leaderS : null;
  if (st.camMode === "free") return null;
  if (st.camMode === "rider" && st.follow >= 0) return sc.riders[st.follow].s;
  let g = sc.groups[0];
  if (st.camMode === "group" && st.follow >= 0) {
    const gi = sc.riders[st.follow].grp;
    g = sc.groups.find((x) => x.idx === gi) ?? g;
    if (sc.riders[st.follow].finished) return sc.riders[st.follow].s;
  }
  return g.head - Math.min(35, (g.head - g.tail) / 2);
}

let lastReal = performance.now();
function frame(now: number) {
  const dt = Math.min(0.1, (now - lastReal) / 1000);
  lastReal = now;
  const rp = st.rp, path = st.path;
  if (rp && path) {
    const t0 = st.t;
    if (st.playing) {
      st.t = Math.min(rp.duration, st.t + dt * speedNow());
      if (st.t >= rp.duration) { st.playing = false; $("play").textContent = "▶"; }
    }
    st.scene = buildScene(rp, st.t, st.scene ?? undefined);
    if (st.t > t0) collectEvents(t0, st.t, now);
    st.bubbles = st.bubbles.filter((b) => now - b.born < 1700);
    // camera
    const tgt = cameraTarget();
    if (tgt !== null) {
      st.camOffset *= Math.exp(-dt * 2.5);
      st.camS = tgt + st.camOffset;
      const p = at(path, Math.min(st.camS, path.length + 100));
      st.cam.x = p.x; st.cam.y = p.y;
      if (st.camMode === "rider" && st.follow >= 0) {
        const q = at(path, Math.min(st.camS, path.length + 100), st.scene.riders[st.follow].d);
        st.cam.x = q.x; st.cam.y = q.y;
      }
    }
    const a = at(path, Math.max(0, st.camS - 35)), b = at(path, Math.min(path.length + 100, st.camS + 35));
    const want = st.headUp ? -Math.PI / 2 - Math.atan2(b.y - a.y, b.x - a.x) : 0;
    let dr = want - st.rot;
    while (dr > Math.PI) dr -= 2 * Math.PI;
    while (dr < -Math.PI) dr += 2 * Math.PI;
    st.rot += dr * (1 - Math.exp(-dt * 2));
    st.cam.rot = st.rot;
    const [w, h] = fitCanvas(mapCv);
    drawMap(mapCtx, w, h, { rp, path, scene: st.scene, cam: st.cam, selected: st.selected, bubbles: st.bubbles.map((b) => ({ ...b, age: (now - b.born) / 1000 })), banner: now < st.banner.until ? st.banner.text : "", screenPos: st.screenPos });
    drawMinimap(miniCtx, 230, 230, path, st.scene, rp, st.camS);
    const [pw, ph] = fitCanvas(profCv);
    drawProfile(profCtx, pw, ph, rp, st.scene, st.camS, st.selected >= 0 ? st.scene.riders[st.selected].s : null);
    const [tw, th] = fitCanvas(tlCv);
    drawTimeline(tlCtx, tw, th, rp, st.t);
    $("clock").textContent = `経過 ${fmtClock(st.t)} / ${fmtClock(rp.duration)}　×${speedNow()}`;
    if (now - st.lastPanel > 200) { st.lastPanel = now; updatePanels(); }
  }
  requestAnimationFrame(frame);
}

function collectEvents(t0: number, t1: number, now: number) {
  const rp = st.rp!;
  for (const e of rp.file.events) {
    if (e.t <= t0 || e.t > t1) continue;
    if (e.rider >= 0 && (BUBBLE_KINDS.has(e.kind) || (e.rider === st.selected && QUIET_KINDS.has(e.kind)))) {
      const sty = EVENT_STYLE[e.kind];
      st.bubbles.push({ rider: e.rider, text: sty.label, color: sty.color, age: 0, born: now });
    } else if (e.kind === "catch" || e.kind === "chase" || e.kind === "chase_end") {
      st.banner = { text: e.kind === "catch" ? e.text : `${rp.file.teams[e.team]?.name ?? e.text.split(":")[0]}：${EVENT_STYLE[e.kind].label}`, until: now + 2500 };
    }
  }
  if (st.bubbles.length > 24) st.bubbles.splice(0, st.bubbles.length - 24);
}

function updatePanels() {
  const rp = st.rp!, sc = st.scene!;
  const followGrp = st.follow >= 0 ? sc.riders[st.follow].grp : -1;
  $("groups").innerHTML = sc.groups.slice(0, 12).map((g) => {
    const color = g.short === "逃げ" ? "#c83232" : g.short === "メイン集団" ? "#2b4f9e" : "#444";
    return `<div class="grp${st.camMode === "group" && g.idx === followGrp ? " sel" : ""}" data-r="${g.riders[0]}"><span class="name"><span class="tag" style="background:${color}">${g.short}</span>${g.size}人</span><span class="gap">${g.idx === sc.groups[0].idx ? "先頭" : fmtGap(g.gapS)}</span><span class="spd">${(g.v * 3.6).toFixed(1)}km/h</span></div>`;
  }).join("") + (sc.groups.length > 12 ? `<div class="muted">ほか ${sc.groups.length - 12} 集団</div>` : "");
  if (st.selected >= 0) {
    const i = st.selected, r = rp.file.riders[i], v = sc.riders[i];
    const s = statAt(rp, i, st.t);
    const team = rp.file.teams[r.team];
    const g = sc.groups.find((x) => x.idx === v.grp);
    const recent = rp.file.events.filter((e) => e.rider === i && e.t <= st.t).slice(-4).reverse();
    $("rider").innerHTML = `
      <div class="row"><b><span class="swatch" style="background:${rp.teamColor[r.team]}"></span>${r.name}</b><span>${team.name}</span></div>
      <div class="row"><span>${JOB_JA[r.job] ?? r.job}・${ROLE_JA[r.role] ?? r.role}</span><span>${v.finished ? `ゴール ${r.rank}位` : modeJa(v.mode)}${v.bonk ? "・<b style='color:#b36bff'>ハンガーノック</b>" : ""}</span></div>
      <div class="row"><span>速度 ${(v.v * 3.6).toFixed(1)} km/h</span><span>${g ? `${g.short} ${g.size}人 ${g.idx === sc.groups[0].idx ? "" : fmtGap(g.gapS)}` : ""}</span></div>
      <div>燃料 ${s.fuel.toFixed(0)}%</div><div class="bar"><div style="width:${Math.max(0, Math.min(100, s.fuel))}%;background:#4cc35a"></div></div>
      <div>バースト ${s.burst.toFixed(0)}%</div><div class="bar"><div style="width:${Math.max(0, Math.min(100, s.burst))}%;background:#e04848"></div></div>
      <div class="row"><span>アイテム 回復系 ${s.rec}個・加速系 ${s.boost}個</span><button id="followBtn">この選手を追う</button></div>
      ${recent.map((e) => `<div class="muted">${fmtClock(e.t)} ${e.text.replace(/^[^:]+: /, "")}</div>`).join("")}`;
    $("followBtn").onclick = () => { st.follow = st.selected; setCam("rider"); };
  }
  const showItems = $<HTMLInputElement>("showItems").checked;
  const evs = rp.file.events.filter((e) => e.t <= st.t && (showItems || (e.kind !== "item_recovery" && e.kind !== "item_boost")) && e.kind !== "other").slice(-80).reverse();
  $("events").innerHTML = evs.map((e) => `<div class="ev" data-t="${e.t}" data-r="${e.rider}"><span class="t">${fmtClock(e.t)}</span><span><span style="color:${EVENT_STYLE[e.kind]?.color}">●</span> ${e.text}</span></div>`).join("");
}

// ---- UI wiring ----
$("play").onclick = () => { if (!st.rp) return; if (st.t >= st.rp.duration) seek(0); st.playing = !st.playing; $("play").textContent = st.playing ? "⏸" : "▶"; };
$<HTMLSelectElement>("speed").onchange = (e) => { st.speed = parseInt((e.target as HTMLSelectElement).value, 10); };
document.querySelectorAll<HTMLButtonElement>("#camBar button[data-cam]").forEach((b) => (b.onclick = () => setCam(b.dataset.cam as CamMode)));
$("zoomIn").onclick = () => (st.cam.zoom = Math.min(40, st.cam.zoom * 1.4));
$("zoomOut").onclick = () => (st.cam.zoom = Math.max(0.02, st.cam.zoom / 1.4));
$<HTMLInputElement>("headUp").onchange = (e) => (st.headUp = (e.target as HTMLInputElement).checked);
$("groups").onclick = (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>(".grp");
  if (!el) return;
  st.follow = parseInt(el.dataset.r!, 10);
  setCam("group");
};
$("events").onclick = (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>(".ev");
  if (!el) return;
  const r = parseInt(el.dataset.r!, 10);
  seek(parseFloat(el.dataset.t!) - 3);
  if (r >= 0) { st.selected = r; st.follow = r; setCam("rider"); st.cam.zoom = Math.max(st.cam.zoom, 6); }
};
let dragging: { x: number; y: number; moved: boolean } | null = null;
mapCv.addEventListener("mousedown", (e) => (dragging = { x: e.clientX, y: e.clientY, moved: false }));
window.addEventListener("mouseup", () => (dragging = null));
window.addEventListener("mousemove", (e) => {
  if (!dragging) return;
  const dx = e.clientX - dragging.x, dy = e.clientY - dragging.y;
  if (!dragging.moved && Math.hypot(dx, dy) < 4) return;
  dragging.moved = true;
  dragging.x = e.clientX; dragging.y = e.clientY;
  if (st.camMode !== "free") setCam("free");
  const c = Math.cos(-st.cam.rot), s = Math.sin(-st.cam.rot);
  st.cam.x -= (dx * c - dy * s) / st.cam.zoom;
  st.cam.y -= (dx * s + dy * c) / st.cam.zoom;
});
const pick = (e: MouseEvent): number => {
  const r = mapCv.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  let best = -1, bd = 16;
  for (let i = 0; i < st.screenPos.length / 2; i++) {
    const px = st.screenPos[i * 2], py = st.screenPos[i * 2 + 1];
    if (!Number.isFinite(px)) continue;
    const d = Math.hypot(px - x, py - y);
    if (d < bd) { bd = d; best = i; }
  }
  return best;
};
mapCv.addEventListener("click", (e) => { if (dragging?.moved) return; const i = pick(e); if (i >= 0) { st.selected = i; updatePanels(); } });
mapCv.addEventListener("dblclick", (e) => { const i = pick(e); if (i >= 0) { st.selected = i; st.follow = i; setCam("rider"); } });
mapCv.addEventListener("wheel", (e) => { e.preventDefault(); st.cam.zoom = Math.max(0.02, Math.min(40, st.cam.zoom * Math.exp(-e.deltaY * 0.0015))); }, { passive: false });
let tlDrag = false;
const tlSeek = (e: MouseEvent) => { if (!st.rp) return; const r = tlCv.getBoundingClientRect(); seek(timelineToTime(st.rp, r.width, e.clientX - r.left)); };
tlCv.addEventListener("mousedown", (e) => { tlDrag = true; tlSeek(e); });
window.addEventListener("mousemove", (e) => { if (tlDrag) tlSeek(e); });
window.addEventListener("mouseup", () => (tlDrag = false));
window.addEventListener("keydown", (e) => {
  if ((e.target as HTMLElement).tagName === "SELECT") return;
  if (e.code === "Space") { e.preventDefault(); $("play").click(); }
  else if (e.code === "ArrowRight") seek(st.t + 30);
  else if (e.code === "ArrowLeft") seek(st.t - 30);
  else if (e.key === "+" || e.key === "=") $("zoomIn").click();
  else if (e.key === "-") $("zoomOut").click();
});
$<HTMLInputElement>("fileIn").onchange = async (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (f) await loadFrom(await f.arrayBuffer());
};
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", async (e) => {
  e.preventDefault();
  const f = e.dataTransfer?.files[0];
  if (f) await loadFrom(await f.arrayBuffer());
});

async function init() {
  const sel = $<HTMLSelectElement>("replaySel");
  let list: { file: string; title: string }[] = [];
  try { list = await (await fetch("replays/index.json")).json(); } catch { /* no samples */ }
  sel.innerHTML = list.map((x) => `<option value="${x.file}">${x.title}</option>`).join("");
  sel.onchange = () => loadUrl(`replays/${sel.value}`);
  const q = new URLSearchParams(location.search);
  const want = q.get("replay") ?? list[0]?.file;
  if (q.get("speed")) st.speed = parseInt(q.get("speed")!, 10);
  if (want) { sel.value = want; await loadUrl(`replays/${want}`); }
  else $("loading").textContent = "リプレイファイルを開いてください";
  if (q.get("z")) st.cam.zoom = parseFloat(q.get("z")!);
  if (q.get("t")) seek(parseFloat(q.get("t")!));
  if (q.get("rider")) {
    const i = st.rp?.file.riders.findIndex((r) => r.id === q.get("rider")) ?? -1;
    if (i >= 0) { st.selected = i; st.follow = i; setCam((q.get("cam") as CamMode) ?? "rider"); }
  }
  if (q.get("paused")) { st.playing = false; $("play").textContent = "▶"; }
}
init();
requestAnimationFrame(frame);
