import { PARAM_DEFS, JOBS } from "./definitions.js";
import { fmtParam, ParamSet } from "./paramset.js";
import { idiv, isqrt, parseDecimal } from "../fixed.js";

export interface ValidationResult {
  errors: string[];
  warnings: string[];
}

/** Validation rules of core-model §9-4 and stamina §5. */
export function validateParams(ps: ParamSet, base?: ParamSet | null): ValidationResult {
  const errors: string[] = [...ps.loadErrors];
  const warnings: string[] = [];
  const v = ps.values;

  // 1. type / range
  for (const d of PARAM_DEFS) {
    const lo = parseDecimal(d.min, d.scale), hi = parseDecimal(d.max, d.scale);
    const x = v[d.key];
    if (!Number.isInteger(x)) errors.push(`[型] ${d.key} が整数に変換できません`);
    else if (x < lo || x > hi) errors.push(`[範囲] ${d.key} = ${fmtParam(d.key, x)} は範囲 ${d.min}〜${d.max} の外です`);
  }
  if (ps.defaulted.length > 0) warnings.push(`[注意] ファイルにないキー ${ps.defaulted.length} 個は既定値を使いました: ${ps.defaulted.slice(0, 8).join(", ")}${ps.defaulted.length > 8 ? " …" : ""}`);

  // 2. relations
  const rel = (cond: boolean, msg: string) => { if (!cond) errors.push(`[関係] ${msg}`); };
  const warn = (cond: boolean, msg: string) => { if (!cond) warnings.push(`[警告] ${msg}`); };
  rel(v["job.tau_short_s"] < v["job.tau_long_s"], "τS < τL であること（job.tau_short_s < job.tau_long_s）");
  const kChain = ["draft.k_line1", "draft.k_line2", "draft.k_line3", "draft.k_line4_6", "draft.k_body_row1", "draft.k_body_row2", "draft.k_body_mid"];
  for (let i = 1; i < kChain.length; i++) rel(v[kChain[i - 1]] >= v[kChain[i]], `k は前ほど大きいこと（${kChain[i - 1]} ≥ ${kChain[i]}）`);
  rel(v["draft.k_body_rear"] >= v["draft.k_body_mid"], "本体後方の k は中ほど以上（後方は風よけが悪い）であること");
  rel(v["stamina.fuel_warn_pct"] >= v["stamina.fuel_low_pct"] && v["stamina.fuel_low_pct"] >= 0, "燃料の表のしきい値が単調であること（warn ≥ low ≥ 0）");
  rel(v["stamina.fuel_low_cp_min"] >= v["stamina.bonk_cp_factor"], "燃料の表の実効CPが単調であること（fuel_low_cp_min ≥ bonk_cp_factor）");
  warn(v["stamina.bonk_recover_pct"] <= v["item.recovery_amount_pct"], "ハンガーノックからの立ち直りのしきい値が回復系アイテム1個の回復量を上回っています");
  rel(v["job.w_grade_lo"] < v["job.w_grade_hi"], "job.w_grade_lo < job.w_grade_hi");
  rel(v["job.u_dist_lo_m"] < v["job.u_dist_hi_m"], "job.u_dist_lo_m < job.u_dist_hi_m");
  rel(v["sprint.launch_min_m"] <= v["sprint.launch_default_m"] && v["sprint.launch_default_m"] <= v["sprint.launch_max_m"], "スプリント発動地点: min ≤ default ≤ max");
  warn((v["sprint.launch_default_m"] - v["sprint.launch_min_m"]) % v["sprint.launch_step_m"] === 0, "スプリントの既定値が刻みに乗っていません");
  const mixSum = v["ai.mix_aggressive"] + v["ai.mix_normal"] + v["ai.mix_none"];
  rel(mixSum === 1000, `AIの方針の割合の合計が1であること（現在 ${mixSum / 1000}）`);
  for (const t of ["flat", "mountain"]) {
    const keys = PARAM_DEFS.filter((d) => d.key.startsWith(`ai.template_mix.${t}.`)).map((d) => d.key);
    const s = keys.reduce((a, k) => a + v[k], 0);
    rel(s === 1000, `ai.template_mix.${t}.* の合計が1であること（現在 ${s / 1000}）`);
  }
  rel(v["item.carry_total_max"] >= v["item.carry_boost_max"], "持ち込みの合計の上限 ≥ 加速系の上限");
  for (const role of ["leader", "breakaway", "puller", "climber", "escort"]) {
    const r = v[`ai.loadout.${role}.recovery`], b = v[`ai.loadout.${role}.boost`];
    rel(r + b <= v["item.carry_total_max"] && b <= v["item.carry_boost_max"], `ai.loadout.${role} が持ち込みの上限を超えています`);
  }
  // boost × (1 + max job coefficient) ≤ 1.15
  let maxCoef = 0;
  for (const j of JOBS) for (const t of ["A", "B", "F", "S"]) maxCoef = Math.max(maxCoef, v[`job.${j}.${t}`]);
  rel(idiv(v["item.boost_power_factor"] * (1000 + maxCoef), 1000) <= 1150, "加速系の効果 × (1 + 脚質の最大の係数) ≤ 1.15");
  // attack consumption within 2x (consumption ∝ f × duration)
  const cons = ["sharp", "standard", "long"].map((a) => v[`attack.${a}_f`] * v[`attack.${a}_s`]);
  rel(Math.max(...cons) <= 2 * Math.min(...cons), "アタック3種類の消費量の差が2倍以内であること");
  // no-attack zone ≥ braking distance at the fastest entry (warning)
  const vmax = v["physics.v_max_descent_ms"]; // mm/s
  const vcHairpin = isqrt(v["physics.a_lat_ms2"] * 6000); // hairpin R = 6 m; sqrt(a_lat[mm/s2] * R[mm]) -> mm/s
  const brakeSimMm = idiv(vmax * vmax - vcHairpin * vcHairpin, 2 * v["physics.brake_ms2"]);
  const brakeDispM = idiv(brakeSimMm * v["scale.display_per_sim"], 1000);
  warn(v["corner.no_attack_zone_m"] >= brakeDispM * 1000, `アタック禁止ゾーン（表示${fmtParam("corner.no_attack_zone_m", v["corner.no_attack_zone_m"])}m）が、最も速い進入（${vmax / 1000}m/s → ヘアピン）でのブレーキの距離（表示約${brakeDispM}m）より短いです`);

  // 3. game promises (decisions)
  for (const t of ["A", "B", "F", "S"]) {
    const xs = JOBS.map((j) => v[`job.${j}.${t}`]);
    rel(Math.max(...xs) - Math.min(...xs) <= 100, `[D7] 脚質の最大差（${t} の最大 − 最小）が10%以内であること（現在 ${(Math.max(...xs) - Math.min(...xs)) / 10}%）`);
  }
  for (const t of ["A", "B", "F", "S"]) rel(v[`job.allrounder.${t}`] === 0, `[D11] オールラウンダーの係数 ${t} が0であること`);
  for (const d of PARAM_DEFS) if (/random|seed|rng/i.test(d.key)) errors.push(`[D5] 乱数に関わる値があります: ${d.key}`);

  // 4. change vs previous version (warning)
  if (base) {
    for (const d of PARAM_DEFS) {
      const a = base.values[d.key], b = v[d.key];
      if (a === b) continue;
      const big = a === 0 ? b !== 0 : Math.abs(b - a) * 5 >= Math.abs(a);
      if (big) warnings.push(`[変更] ${d.key}: ${fmtParam(d.key, a)} → ${fmtParam(d.key, b)}（20%以上の変更）`);
    }
    if (base.version >= 0 && ps.version >= 0 && ps.version <= base.version) warnings.push(`[版] 新しい版の番号（${ps.version}）が比較元（${base.version}）以下です`);
  }
  return { errors, warnings };
}
