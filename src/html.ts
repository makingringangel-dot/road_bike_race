import { RaceReport } from "./race.js";

/** Self-contained HTML view: gap-to-leader over time + a course map with rider positions. */
export function renderHtml(rep: RaceReport): string {
  const tr = rep.trace;
  if (!tr) return "<p>no trace</p>";
  const top = rep.ranking.slice(0, 12).map((r) => r.rider_id);
  const data = {
    meta: rep.meta, outcome: rep.outcome, top, trace: tr,
    ranking: rep.ranking.slice(0, 30).map((r) => [r.rank, r.rider_id, r.team_id, r.job, r.time_ms, r.group_gap_ms]),
  };
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>${rep.meta.course_id} – レース表示</title>
<style>
body{font-family:system-ui,"Hiragino Sans","Noto Sans JP",sans-serif;margin:16px;background:#0f1218;color:#e6e8ee}
h1{font-size:18px;margin:0 0 4px} .sub{color:#9aa3b2;font-size:12px;margin-bottom:10px}
canvas{background:#161b24;border-radius:8px;display:block;margin:8px 0}
.row{display:flex;gap:16px;flex-wrap:wrap} table{border-collapse:collapse;font-size:12px}
td,th{padding:2px 8px;border-bottom:1px solid #263041;text-align:left} .ctl{display:flex;gap:8px;align-items:center;font-size:13px}
input[type=range]{width:520px}
</style></head><body>
<h1>${rep.meta.course_id}（表示 ${rep.meta.course_display_km} km）</h1>
<div class="sub">パラメータ版 v${rep.meta.param_version}（${rep.meta.param_checksum}） / エンジン ${rep.meta.engine_version} / 勝者 ${rep.outcome.winner}（${rep.outcome.type}）</div>
<div class="ctl"><span>時刻</span><input id="t" type="range" min="0" value="0"><span id="tl"></span><button id="play">▶</button></div>
<canvas id="map" width="1100" height="220"></canvas>
<div class="row"><canvas id="gap" width="760" height="360"></canvas><div><b>上位</b><table id="rk"></table></div></div>
<div class="sub">上: コース断面（灰色）と選手の位置（点。大きい丸 = 集団、色 = 上位の選手）。下: 先頭とのタイム差（秒、上位12人）。</div>
<script>
const D=${JSON.stringify(data)};
const T=D.trace, F=T.frames, idx=new Map(T.riders.map((r,i)=>[r.id,i]));
const cols=["#ff6b6b","#ffd166","#06d6a0","#4cc9f0","#b388ff","#ff9f1c","#f72585","#90be6d","#43aa8b","#577590","#e9c46a","#e76f51"];
const slider=document.getElementById("t"); slider.max=F.length-1;
const fmt=ms=>{const s=Math.floor(ms/1000);return Math.floor(s/3600)+":"+String(Math.floor(s%3600/60)).padStart(2,"0")+":"+String(s%60).padStart(2,"0")};
document.getElementById("rk").innerHTML="<tr><th>#</th><th>選手</th><th>チーム</th><th>脚質</th><th>タイム</th><th>差</th></tr>"+D.ranking.map(r=>"<tr><td>"+r[0]+"</td><td>"+r[1]+"</td><td>"+r[2]+"</td><td>"+r[3]+"</td><td>"+fmt(r[4])+"</td><td>"+(r[5]>0?"+"+(r[5]/1000).toFixed(0)+"s":"")+"</td></tr>").join("");
function drawMap(fi){
  const c=document.getElementById("map"),x=c.getContext("2d"),W=c.width,H=c.height;x.clearRect(0,0,W,H);
  const P=T.profile,maxA=Math.max(1,...P.map(p=>p.alt)),minA=Math.min(0,...P.map(p=>p.alt));
  const X=km=>20+(W-40)*km/T.displayLenKm, Y=a=>H-30-(H-70)*(a-minA)/(maxA-minA||1);
  x.fillStyle="#2a3344";x.beginPath();x.moveTo(X(0),H-30);P.forEach(p=>x.lineTo(X(p.km),Y(p.alt)));x.lineTo(X(T.displayLenKm),H-30);x.fill();
  x.fillStyle="#9aa3b2";x.font="11px sans-serif";T.corners.forEach(cn=>{x.fillText(cn.vc_kmh<35?"↩":"›",X(cn.km)-3,H-14)});
  const fr=F[fi]; if(!fr)return; const altAt=km=>{let a=P[0].alt;for(let i=1;i<P.length;i++){if(P[i].km>=km){const p0=P[i-1],p1=P[i];a=p0.alt+(p1.alt-p0.alt)*(km-p0.km)/((p1.km-p0.km)||1);break}}return a};
  const groups=new Map(); fr.km.forEach((km,i)=>{const g=fr.grp[i];if(!g)return;const e=groups.get(g)||{n:0,km:0};e.n++;e.km=Math.max(e.km,km);groups.set(g,e)});
  for(const [g,e] of groups){x.fillStyle="rgba(230,232,238,0.25)";x.beginPath();x.arc(X(e.km),Y(altAt(e.km))-10,4+Math.sqrt(e.n)*1.6,0,7);x.fill();x.fillStyle="#e6e8ee";x.fillText(e.n,X(e.km)-4,Y(altAt(e.km))-24)}
  D.top.forEach((id,k)=>{const i=idx.get(id);const km=fr.km[i];x.fillStyle=cols[k%cols.length];x.beginPath();x.arc(X(km),Y(altAt(km))-10,3,0,7);x.fill()});
  document.getElementById("tl").textContent=fmt(fr.t*1000)+"  先頭 "+Math.max(...fr.km).toFixed(1)+" km";
}
function drawGap(){
  const c=document.getElementById("gap"),x=c.getContext("2d"),W=c.width,H=c.height;x.clearRect(0,0,W,H);
  const series=D.top.map(id=>{const i=idx.get(id);return F.map(fr=>{const lead=Math.max(...fr.km);return (lead-fr.km[i])})});
  const maxG=Math.max(0.05,...series.flat());
  const X=i=>40+(W-60)*i/(F.length-1||1), Y=g=>20+(H-50)*g/maxG;
  x.strokeStyle="#263041";x.fillStyle="#9aa3b2";x.font="11px sans-serif";
  for(let k=0;k<=4;k++){const g=maxG*k/4;x.beginPath();x.moveTo(40,Y(g));x.lineTo(W-20,Y(g));x.stroke();x.fillText(g.toFixed(2)+"km",2,Y(g)+4)}
  series.forEach((s,k)=>{x.strokeStyle=cols[k%cols.length];x.beginPath();s.forEach((g,i)=>i?x.lineTo(X(i),Y(g)):x.moveTo(X(i),Y(g)));x.stroke();x.fillStyle=cols[k%cols.length];x.fillText(D.top[k],W-140+(k%2)*70,14+Math.floor(k/2)*12)});
  x.fillStyle="#9aa3b2";x.fillText("先頭との差（表示km、下ほど遅れ）",40,H-8);
}
slider.oninput=()=>drawMap(+slider.value); drawGap(); drawMap(0);
let timer=null; document.getElementById("play").onclick=()=>{if(timer){clearInterval(timer);timer=null;return}timer=setInterval(()=>{slider.value=(+slider.value+1)%F.length;drawMap(+slider.value)},60)};
</script></body></html>`;
}
