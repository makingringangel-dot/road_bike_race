// Parameter definitions: the only "code-side" table (race-core-model §9-3 param_definitions).
// Every tunable value lives in a parameter set file (CSV/JSON) that the admin edits.
// Values are decimal literals in the file and are parsed exactly into scaled integers.

export interface ParamDef {
  key: string;
  group: string;
  def: string; // default, decimal literal
  min: string;
  max: string;
  scale: number; // stored integer = value * scale
  unit: string;
  desc: string;
  ref: string; // spec section
}

const defs: ParamDef[] = [];
function p(key: string, def: string, min: string, max: string, scale: number, unit: string, desc: string, ref: string) {
  defs.push({ key, group: key.split(".")[0], def, min, max, scale, unit, desc, ref });
}
const K = 1000;
const M = 1_000_000;

// --- scale ---
p("scale.display_per_sim", "2", "1", "10", 1, "倍", "縮尺。表示距離 = シム距離 × この値（D27: 1/2 → 2）", "core §8");

p("race.start_speed_ms", "10", "0", "20", K, "m/s", "スタート時の集団の速度（ローリングスタート）", "実装");

// --- physics ---
p("physics.g", "9.81", "9", "10", K, "m/s²", "重力加速度", "core §4-1");
p("physics.rho", "1.20", "0.9", "1.4", K, "kg/m³", "空気密度 ρ", "core §4-1");
p("physics.crr", "0.004", "0.001", "0.01", M, "", "転がり抵抗係数 Crr", "core §4-1");
p("physics.bike_mass_kg", "7.5", "5", "12", K, "kg", "自転車の重量", "core §4-1");
p("physics.wheel_mass_kg", "1.5", "0.5", "3", K, "kg", "ホイールの重量（自転車の重量の内数。加速時にもう一度足す）", "core §2-8");
p("physics.v_max_descent_ms", "20", "10", "30", K, "m/s", "下りの最高速度", "core §4-1");
p("physics.v_min_accel_ms", "3.0", "1", "6", K, "m/s", "加速の式で使う最低速度 max(v, 3.0)", "core §4-2");
p("physics.brake_ms2", "4.0", "1", "8", K, "m/s²", "ブレーキの強さ b（全員共通）", "core §1-5");
p("physics.a_lat_ms2", "5.9", "3", "9", K, "m/s²", "コーナーの横加速度 a_lat（v_c = √(a_lat·R)）", "core §1-5");

// --- stats -> physics (core §4-1) ---
p("stat.cp_base_w", "260", "100", "400", K, "W", "CP = base + per_flat × Flat", "core §4-1");
p("stat.cp_per_flat_w", "1.6", "0", "5", K, "W", "Flat 1あたりのCP", "core §4-1");
p("stat.mass_base_kg", "80", "50", "100", K, "kg", "体重 = base − per_climb × Climb", "core §4-1");
p("stat.mass_per_climb_kg", "0.22", "0", "0.5", K, "kg", "Climb 1あたりの体重の減少", "core §4-1");
p("stat.cda_ref", "0.30", "0.15", "0.5", K, "m²", "体の CdA = cda_ref × (m / cda_ref_mass)^(2/3)", "core §4-1");
p("stat.cda_ref_mass_kg", "70", "40", "100", K, "kg", "CdA の基準体重", "core §4-1");
p("stat.pmax_base_w", "900", "400", "2000", K, "W", "Pmax = base + per_sprint × Sprint", "core §4-1");
p("stat.pmax_per_sprint_w", "6", "0", "20", K, "W", "Sprint 1あたりの Pmax", "core §4-1");
p("stat.wmax_base_kj", "12", "4", "40", K, "kJ", "W'max = base + per_sprint × Sprint", "core §4-1");
p("stat.wmax_per_sprint_kj", "0.12", "0", "0.5", K, "kJ", "Sprint 1あたりの W'max", "core §4-1");
p("stat.tau_base_s", "300", "60", "600", K, "s", "バースト回復の時定数 τ = base − per_stamina × Stamina", "core §4-1");
p("stat.tau_per_stamina_s", "1.5", "0", "4", K, "s", "Stamina 1あたりの τ の短縮", "core §4-1");
p("stat.sg_base", "1.15", "0.5", "2", K, "", "燃料の消費係数 s_G = base − per_stamina × Stamina", "core §4-1");
p("stat.sg_per_stamina", "0.003", "0", "0.01", M, "", "Stamina 1あたりの s_G の減少", "core §4-1");
p("stat.react_base_s", "3.0", "0", "10", K, "s", "反応の遅れ = round(base − per_iq × IQ)", "core §4-1");
p("stat.react_per_iq_s", "0.02", "0", "0.1", M, "s", "IQ 1あたりの反応の短縮", "core §4-1");

// --- equipment (core §1-2) ---
p("equip.frame_aero_cda", "-0.010", "-0.05", "0", M, "m²", "エアロフレームの CdA 変化", "core §1-2");
p("equip.frame_light_kg", "-0.8", "-3", "0", K, "kg", "軽量フレームの重量変化", "core §1-2");
p("equip.frame_allround_cda", "-0.005", "-0.05", "0", M, "m²", "オールラウンドフレームの CdA 変化", "core §1-2");
p("equip.frame_allround_kg", "-0.4", "-3", "0", K, "kg", "オールラウンドフレームの重量変化", "core §1-2");
p("equip.wheel_deep_cda", "-0.012", "-0.05", "0", M, "m²", "ディープリムの CdA 変化", "core §1-2");
p("equip.wheel_deep_kg", "0.4", "0", "2", K, "kg", "ディープリムの重量変化（ホイール重量）", "core §1-2");
p("equip.wheel_low_kg", "-0.5", "-2", "0", K, "kg", "ロープロの重量変化（ホイール重量）", "core §1-2");
p("equip.wear_basic_cda", "-0.004", "-0.03", "0", M, "m²", "ウェア（標準）の CdA 変化", "core §1-2");
p("equip.wear_aero_cda", "-0.008", "-0.03", "0", M, "m²", "ウェア（エアロ）の CdA 変化", "core §1-2");
p("equip.computer_accel_loss", "0.15", "0", "0.5", K, "", "サイコンによる加減速ロスの軽減率", "core §1-2");
p("equip.computer_fuel", "0.03", "0", "0.2", K, "", "サイコンによる燃料消費の軽減率", "core §1-2");

// --- job (core §1-4) ---
const jobs: [string, string, string, string, string][] = [
  ["climber", "0.06", "-0.01", "-0.02", "-0.04"],
  ["rouleur", "-0.03", "-0.02", "0.04", "0"],
  ["puncheur", "-0.01", "0.05", "0", "0.02"],
  ["sprinter", "-0.04", "-0.03", "0", "0.06"],
  ["allrounder", "0", "0", "0", "0"],
];
for (const [j, a, b, f, s] of jobs) {
  p(`job.${j}.A`, a, "-0.1", "0.1", K, "", `${j}: 長い登りの項 A`, "core §1-4");
  p(`job.${j}.B`, b, "-0.1", "0.1", K, "", `${j}: 登り始め・短い登りの項 B`, "core §1-4");
  p(`job.${j}.F`, f, "-0.1", "0.1", K, "", `${j}: 平地の項 F`, "core §1-4");
  p(`job.${j}.S`, s, "-0.1", "0.1", K, "", `${j}: ゴール前スプリントの項 S`, "core §1-4");
}
p("job.tau_short_s", "75", "30", "300", K, "s", "τS（短い登りの項が消える時定数）", "core §1-4");
p("job.tau_long_s", "400", "60", "1500", K, "s", "τL（長い登りの項が効く時定数）", "core §1-4");
p("job.c_decay_s", "60", "10", "600", K, "s", "平地・下りでの登り累積量 c の減衰時定数", "core §1-4");
p("job.w_grade_lo", "0.01", "0", "0.05", M, "", "登りの度合い w の smoothstep 下端（勾配）", "core §1-4");
p("job.w_grade_hi", "0.05", "0.01", "0.15", M, "", "登りの度合い w の smoothstep 上端（勾配）", "core §1-4");
p("job.u_dist_lo_m", "300", "0", "2000", K, "表示m", "スプリントの重み u: 残り表示距離がこれ以下で u=1", "core §1-4");
p("job.u_dist_hi_m", "1000", "100", "5000", K, "表示m", "スプリントの重み u: 残り表示距離がこれ以上で u=0", "core §1-4");

// --- draft (core §2-1, §2-2) ---
p("draft.k_line1", "1.00", "0.5", "1", K, "", "先頭交代の列 1番手の k", "core §2-2");
p("draft.k_line2", "0.75", "0.5", "1", K, "", "先頭交代の列 2番手の k", "core §2-2");
p("draft.k_line3", "0.70", "0.5", "1", K, "", "先頭交代の列 3番手の k", "core §2-2");
p("draft.k_line4_6", "0.68", "0.5", "1", K, "", "先頭交代の列 4〜6番手の k", "core §2-2");
p("draft.k_body_row1", "0.68", "0.5", "1", K, "", "本体 1列目の k", "core §2-2");
p("draft.k_body_row2", "0.64", "0.5", "1", K, "", "本体 2列目の k", "core §2-2");
p("draft.k_body_mid", "0.60", "0.5", "1", K, "", "本体 3列目〜前から rear_fraction 手前までの k", "core §2-2");
p("draft.k_body_rear", "0.65", "0.5", "1", K, "", "本体の後ろ rear_fraction の k", "core §2-2");
p("draft.rear_fraction", "0.30", "0", "0.9", K, "", "本体の後方とみなす割合", "core §2-2");
p("draft.k_moving", "0.75", "0.5", "1", K, "", "集団内で前に上がる途中の k", "core §2-5");
p("group.gap_s", "1.0", "0.2", "5", K, "s", "同じ集団とみなす時間差", "core §2-1");
p("group.row_spacing_m", "2", "0.5", "5", K, "m", "本体の1列の間隔", "core §2-1");
p("group.lanes", "6", "6", "6", 1, "人", "道幅（横の人数。D16で6に固定）", "core §2-1");
p("group.paceline_max", "6", "1", "12", 1, "人", "先頭交代の列の最大人数", "core §2-1");
p("group.drop_cooldown_s", "30", "0", "300", 1, "s", "切れた選手が同じ集団に再合流できるまでの最短時間", "実装");

// --- pace / tactics (core §2-3, §2-8, §4-2) ---
p("pace.tempo_factor", "0.95", "0.5", "1.2", K, "×CP", "牽引（テンポ）の出力", "core §2-3");
p("pace.chase_factor", "1.05", "0.5", "1.3", K, "×CP", "追走の出力", "core §2-3");
p("pace.wait_factor", "0.85", "0.3", "1.0", K, "×CP", "様子見の先頭の出力", "core §2-3");
p("pace.soft_factor", "0.60", "0.3", "1.0", K, "×CP", "流し（全員チェック・ブロック役）の出力", "core §2-3 D13");
p("pace.solo_factor", "1.00", "0.5", "1.2", K, "×CP", "単独の逃げ（アタック後）の出力", "stamina §3-1");
p("pace.rotate_s", "15", "1", "120", 1, "s", "先頭交代の秒数", "core §2-1");
p("pace.wait_rotate_s", "30", "1", "300", 1, "s", "様子見の交代の秒数", "core §2-1");
p("pace.exit_factor", "1.2", "0.5", "2", K, "×CP", "コーナー立ち上がりでペースを作る選手の出力", "core §2-8");
p("pace.close_f", "0.4", "0", "1", K, "", "差を詰める出力 CP + f·(Pmax − CP)", "core §2-8");
p("pace.bridge_f", "0.4", "0", "1", K, "", "ブリッジの出力 CP + f·(Pmax − CP)", "core §4-2");
p("block.per_rider", "0.02", "0", "0.1", K, "", "ブロック役1人あたりの追走効率の低下", "core §2-3");
p("block.max", "0.08", "0", "0.5", K, "", "ブロックによる低下の上限", "core §2-3");
p("block.slots", "12", "0", "36", 1, "枠", "ブロックが効く本体前方の枠数", "core §2-3");

// --- positioning (core §2-5, §2-10) ---
p("pos.ace_escort_bonus", "15", "0", "100", 1, "", "エース（同じ集団に護衛役の味方）への優先度の加点", "core §2-5");
p("pos.escort_bonus", "10", "0", "100", 1, "", "護衛の指示を受けている選手への加点", "core §2-5");
p("pos.corner_bonus", "10", "0", "100", 1, "", "次のコーナーが近いときの加点（× IQ/100）", "core §2-5");
p("pos.corner_bonus_km", "2", "0", "10", K, "表示km", "コーナーの加点が付く距離", "core §2-5");
p("pos.low_burst_penalty", "20", "0", "100", 1, "", "バーストが少ないときの減点", "core §2-5");
p("pos.low_burst_ratio", "0.20", "0", "1", K, "", "減点されるバーストの割合", "core §2-5");
p("pos.move_period_s", "2", "1", "10", 1, "s", "前に上がる速さ（1列あたりの秒数。D26）", "core §2-5");
p("pos.move_cost_j", "40", "0", "500", K, "J", "1列上がるごとのバーストの消費", "core §2-5");
p("pos.move_cost_iq", "0.004", "0", "0.01", M, "", "IQ 1あたりの消費の軽減（× (1 − x·IQ)）", "core §2-5");

// --- corners (core §2-8, §2-9, §2-11) ---
p("corner.iq_line_base", "0.97", "0.8", "1.2", M, "", "コーナー上限の IQ 補正 = base + per_iq × IQ", "core §2-8 D28");
p("corner.iq_line_per_iq", "0.0006", "0", "0.003", M, "", "IQ 1あたりのラインの上手さ", "core §2-8 D28");
p("corner.accordion_max", "0.15", "0", "0.5", K, "", "後方の進入速度の最大低下率", "core §2-8");
p("corner.accordion_rows", "40", "1", "200", 1, "列", "最大低下に達する列", "core §2-8");
p("corner.accordion_iq", "0.004", "0", "0.01", M, "", "IQ による低下の軽減（× (1 − x·IQ)）", "core §2-8");
p("corner.zone_max_vc_kmh", "68", "20", "120", K, "km/h", "ゾーンを作るコーナー（v_c がこれ未満。アイコンの付くコーナー）", "core §2-11");
p("corner.no_attack_zone_m", "200", "0", "1000", K, "表示m", "アタック禁止ゾーンの長さ（頂点の手前。D44）", "core §2-11");
p("corner.exit_zone_m", "200", "0", "1000", K, "表示m", "立ち上がりゾーンの長さ（頂点の後。D43）", "core §2-11");
p("corner.lane_window_s", "8", "0", "20", 1, "s", "立ち上がりアタックの空きレーン判定の時間", "core §2-9");
p("accordion.dv_ms", "0.8", "0.1", "5", K, "m/s", "加減速のロスが発生する速度変化", "core §2-8 (4)");
p("accordion.window_s", "5", "1", "30", 1, "s", "速度変化を見る時間", "core §2-8 (4)");
p("accordion.cost_j", "300", "0", "2000", K, "J", "最後尾での加減速のロス", "core §2-8 (4)");

// --- stamina (core §3, stamina §1) ---
p("stamina.fatigue_base", "0.30", "0", "0.5", K, "", "疲労係数 = base − per_stamina × Stamina（D35）", "stamina §1-1");
p("stamina.fatigue_per_stamina", "0.002", "0", "0.005", M, "", "Stamina 1あたりの疲労係数の減少", "stamina §1-1");
p("stamina.fatigue_full_multiple", "4", "1", "10", K, "×W'max", "容量が最大まで下がる累積消費", "stamina §1-1");
p("stamina.fuel_coefficient", "0.5", "0.3", "1.2", K, "", "燃料係数（D34）。K_G = 100% / (係数 × T_ref)", "stamina §1-2");
p("stamina.fuel_warn_pct", "40", "0", "100", K, "%", "燃料の注意表示（黄）のしきい値", "stamina §1-3");
p("stamina.fuel_low_pct", "25", "0", "100", K, "%", "実効CPが下がり始める燃料", "stamina §1-3");
p("stamina.fuel_low_cp_min", "0.90", "0.5", "1", K, "×CP", "燃料0%直前の実効CP", "stamina §1-3");
p("stamina.bonk_cp_factor", "0.75", "0.5", "1", K, "×CP", "ハンガーノック中の実効CP", "stamina §1-3");
p("stamina.bonk_burst_recovery", "0.5", "0.2", "1", K, "×", "ハンガーノック中のバースト回復", "stamina §1-3");
p("stamina.bonk_recover_pct", "20", "0", "50", K, "%", "ハンガーノックから立ち直る燃料（D38）", "stamina §1-3");
p("stamina.t_ref_speed_ms", "11.1", "5", "20", K, "m/s", "コースに T_ref がないときの想定速度（平地の基準）", "core §2-7");

// --- items (stamina §2) ---
p("item.recovery_amount_pct", "25", "5", "50", K, "%", "回復系: 燃料の回復量", "stamina §2-1 D39");
p("item.recovery_duration_s", "120", "10", "600", 1, "s", "回復系: 回復にかかる時間", "stamina §2-1 D39");
p("item.recovery_burst_bonus", "1.2", "1.0", "1.5", K, "×", "回復系: 効果中のバースト回復倍率", "stamina §2-1 D39");
p("item.recovery_auto_threshold_pct", "40", "10", "80", K, "%", "回復系: 自動使用のしきい値（既定。作戦で上書き可）", "stamina §2-2");
p("item.boost_power_factor", "1.05", "1.00", "1.08", K, "×", "加速系: 出力倍率", "stamina §2-1 D39");
p("item.boost_duration_s", "12", "3", "30", 1, "s", "加速系: 効果時間", "stamina §2-1 D39");
p("item.carry_total_max", "10", "0", "20", 1, "個", "1人の持ち込み上限（2種類の合計。D40）", "stamina §2-3");
p("item.carry_boost_max", "3", "0", "10", 1, "個", "加速系の持ち込み上限", "stamina §2-3");

// --- attacks / checks (stamina §3, D36, D41) ---
p("attack.sharp_f", "0.6", "0", "1", K, "", "鋭い: 出力 CP + f·(Pmax − CP)", "stamina §3-1 D36");
p("attack.sharp_s", "12", "3", "120", 1, "s", "鋭い: 長さ", "stamina §3-1 D36");
p("attack.standard_f", "0.4", "0", "1", K, "", "標準: 出力係数", "stamina §3-1 D36");
p("attack.standard_s", "20", "3", "120", 1, "s", "標準: 長さ", "stamina §3-1 D36");
p("attack.long_f", "0.2", "0", "1", K, "", "ロング: 出力係数", "stamina §3-1 D36");
p("attack.long_s", "40", "3", "120", 1, "s", "ロング: 長さ", "stamina §3-1 D36");
p("attack.start_burst_ratio", "0.8", "0", "1", K, "", "アタック開始に必要なバースト（その種類の消費量に対する割合）", "stamina §3-2");
p("attack.wait_max_km", "2", "0", "10", K, "表示km", "バースト回復待ちの最大距離", "stamina §3-2");
p("attack.sit_up_after_check_s", "10", "0", "60", 1, "s", "付かれたら止めるまでの秒数（D41）", "stamina §3-3");
p("check.chase_power_factor", "1.1", "1.0", "1.3", K, "×", "チェック役が追いつくまでの出力（アタックの出力に対して）", "stamina §3-6");
p("check.wheel_k", "0.75", "0.6", "1.0", K, "", "チェック役が後ろに付いたときの k", "stamina §3-6");

// --- sprint (D31, core §8-1) ---
p("sprint.launch_min_m", "300", "100", "1500", K, "表示m", "スプリント発動地点の下限", "D31");
p("sprint.launch_max_m", "700", "100", "1500", K, "表示m", "スプリント発動地点の上限", "D31");
p("sprint.launch_step_m", "100", "10", "500", K, "表示m", "発動地点の刻み", "D31");
p("sprint.launch_default_m", "400", "100", "1500", K, "表示m", "発動地点の既定値", "D31");
p("sprint.ai_launch_m", "400", "100", "1500", K, "表示m", "AI・ピンなしの選手の発動地点", "core §9-2");
p("sprint.power_decay_per_s", "0.02", "0", "0.05", K, "", "スプリント出力の1秒あたりの低下", "D31");
p("sprint.draft_s", "2", "0", "10", 1, "s", "発動から前の選手の後ろにいる秒数（k = draft.k_line2）", "core §8-1");

// --- AI / chase (core §2-7) ---
p("ai.alpha_aggressive", "1.0", "0", "10", K, "s/表示km", "追走開始のしきい値 α（積極）", "core §2-7");
p("ai.alpha_normal", "1.5", "0", "10", K, "s/表示km", "追走開始のしきい値 α（普通）", "core §2-7");
p("ai.mix_aggressive", "0.2", "0", "1", K, "", "AIチームの方針の割合: 積極", "core §2-7");
p("ai.mix_normal", "0.5", "0", "1", K, "", "AIチームの方針の割合: 普通", "core §2-7");
p("ai.mix_none", "0.3", "0", "1", K, "", "AIチームの方針の割合: しない", "core §2-7");
p("ai.pull_budget_km", "30", "0", "300", K, "表示km", "1チームあたりの牽引の予算", "core §2-7");
p("ai.chase_riders_per_team", "3", "1", "6", 1, "人", "追走するチームが先頭交代に出す人数（実装上の補足）", "実装");
p("ai.max_chase_teams", "2", "1", "50", 1, "チーム", "同時に追走できるチーム数（ただ乗りの表現。実装上の補足）", "実装");
p("ai.template_mix.flat.breakaway", "0.14", "0", "1", K, "", "平地: AIの作戦テンプレート「逃げ狙い」の割合", "stamina §4");
p("ai.template_mix.flat.sprint", "0.56", "0", "1", K, "", "平地: 「スプリント勝負」の割合", "stamina §4");
p("ai.template_mix.flat.balanced", "0.30", "0", "1", K, "", "平地: 「バランス」の割合", "stamina §4");
p("ai.template_mix.mountain.breakaway", "0.14", "0", "1", K, "", "山岳: 「逃げ狙い」の割合", "stamina §4");
p("ai.template_mix.mountain.climb", "0.56", "0", "1", K, "", "山岳: 「山岳勝負」の割合", "stamina §4");
p("ai.template_mix.mountain.balanced", "0.30", "0", "1", K, "", "山岳: 「バランス」の割合", "stamina §4");
p("ai.break_attack_km", "6", "0", "100", K, "表示km", "逃げ狙いテンプレートのアタック地点", "stamina §4");
p("ai.check_last_km", "30", "0", "300", K, "表示km", "テンプレートのチェック区間（ゴールまでの残り）", "stamina §4");
p("ai.pull_last_km", "25", "0", "300", K, "表示km", "スプリント勝負の牽引区間の開始（ゴールまでの残り）", "stamina §4");
p("ai.climb_attack_frac", "0.5", "0", "1", K, "", "山岳勝負: 最後の登りのどこでアタックするか（割合）", "stamina §4");
p("ai.rider_stat_base", "50", "0", "100", 1, "", "AIが埋める選手の能力値の中心", "実装");
p("ai.rider_stat_spread", "12", "0", "50", 1, "", "AIが埋める選手の能力値のばらつき幅", "実装");
for (const [role, r, b] of [["leader", "2", "2"], ["breakaway", "5", "1"], ["puller", "4", "0"], ["climber", "3", "3"], ["escort", "3", "0"]] as const) {
  p(`ai.loadout.${role}.recovery`, r, "0", "20", 1, "個", `役割 ${role} の回復系の持ち込み`, "stamina §2-4");
  p(`ai.loadout.${role}.boost`, b, "0", "10", 1, "個", `役割 ${role} の加速系の持ち込み`, "stamina §2-4");
}
p("ui.pins_per_rider_max", "5", "1", "20", 1, "本", "1人あたりのピンの上限", "stamina §4-1");

// --- report ---
p("report.breakaway_min_frac", "0.25", "0", "1", K, "", "逃げ切りの判定: 勝者の逃げがレースの最後のこの割合より前に始まっていること", "core §9-5");

export const PARAM_DEFS: readonly ParamDef[] = defs;
export const PARAM_DEF_MAP: ReadonlyMap<string, ParamDef> = new Map(defs.map((d) => [d.key, d]));
export const JOBS = ["climber", "rouleur", "puncheur", "sprinter", "allrounder"] as const;
export type Job = (typeof JOBS)[number];
