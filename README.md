# ロードレース・シミュレーター（試作）

チーム戦術ロードレースゲームの「レース計算エンジン」の試作です。仕様書（コアモデル v6・スタミナ/アイテム/アタック v2・決定事項 D1〜D45）に沿って、1レース（50チーム × 6人 = 300人）を計算します。

- **決定論**: 乱数を使いません。同じ入力なら、どのマシンでも必ず同じ結果になります（計算はすべて固定小数点の整数。`Math.exp` などの浮動小数点も使いません）。
- **1tick = 1秒**、**縮尺 1/2**（表示 1km = シム 500m）。
- パラメータはすべて CSV（または JSON）に置き、コードを触らずに調整できます。使った版とチェックサムは結果に記録されます。

## 動かし方

Node.js 20 以上が必要です。

```bash
npm install
npm run build

# 1レース（平地）。出力は out/flat/ に
node dist/src/cli.js run --course samples/courses/flat-coast.json --roster samples/roster.csv \
  --plans samples/plans/flat-coast --params samples/params/params-v2.csv --out out/flat

# 山岳
node dist/src/cli.js run --course samples/courses/mountain-pass.json --roster samples/roster.csv \
  --plans samples/plans/mountain-pass --params samples/params/params-v2.csv --out out/mountain

# ドライラン比較（同じ入力で、2つのパラメータセットの順位・タイム差の違いを表示）
node dist/src/cli.js compare --course samples/courses/flat-coast.json --roster samples/roster.csv \
  --plans samples/plans/flat-coast --params samples/params/params-v1.csv --params-b samples/params/params-v2.csv --out out/compare

# 一括テスト（逃げ切り率を目標と比べる。AIチームの組み合わせをレースごとに変える）
node dist/src/cli.js batch --courses samples/courses/flat-coast.json,samples/courses/mountain-pass.json \
  --races 30 --roster samples/roster.csv --plans-dir samples/plans \
  --params samples/params/params-v1.csv --params-b samples/params/params-v2.csv --out out/batch

# パラメータの検証（--base に前の版を渡すと、20%以上変えた値を警告）
node dist/src/cli.js params validate --params samples/params/params-v2.csv --base samples/params/params-v1.csv

# テスト
npm test
```

1レースの計算は、1秒ごとのログとビューア付きで約4〜5秒、ログなしで約1.2〜1.4秒です（300人・約5,000〜6,000tick）。

## 入力ファイル

| 入力 | 形式 | サンプル |
|---|---|---|
| コース | JSON。区間（`length_km`・`grade_pct`・`wind_ms` 向かい風）とコーナー（`at_km`・`radius_m`）。距離はすべて**表示km**。`type` は `flat` / `mountain`、`t_ref_s` は燃料の基準時間（シム秒） | `samples/courses/flat-coast.json`（120km・コーナー5）、`samples/courses/mountain-pass.json`（94km・ヘアピンあり・山頂ゴール） |
| 選手・チーム | CSV。`team_id,team_name,rider_id,rider_name,job,flat,climb,sprint,stamina,iq,frame,wheel,wear,computer`。脚質は `sprinter / climber / rouleur / puncheur / allrounder` | `samples/roster.csv`（8チーム48人） |
| 作戦 | JSON（1ファイル1チーム、またはフォルダごと指定）。テンプレート（`sprint / breakaway / climb / balanced`）、追走方針、選手ごとの役割・アイテム数・回復系の自動使用しきい値・ピン（最大5本） | `samples/plans/<コースid>/` |
| パラメータ | CSV（`key,value` の2列だけ読む。他の列は説明）か JSON | `samples/params/params-v1.csv`（仕様書の初期値）、`params-v2.csv`（逃げ切り率を調整した版） |

- 作戦がないチームと、50チームに足りない分は **AIチーム**で埋めます（能力値・脚質・テンプレート・追走方針は、チーム番号から決定論的に決まります。`--ai-seed` で組み合わせを変えられます）。
- ピンの種類: `attack`（`at_km`・`kind`: sharp/standard/long・`on_check`: stop/continue・`boost`）、`check`（区間・対象）、`bridge`（区間・対象）、`sprint`（`at_m`: 残り300〜700m、100m刻み）、`item`（地点で回復系/加速系を使う）、`pull`（区間を牽引）。
- コーナー手前のアタック禁止ゾーンに置いたピンは「コーナー前はアタックできません！」と表示して無視します（D44）。立ち上がりゾーンに置いたアタックは立ち上がりアタックになります（D43）。

## パラメータの編集

1. 今の版を書き出す: `node dist/src/cli.js params export --params samples/params/params-v2.csv --out my-v3.csv`
2. `my-v3.csv` を表計算ソフトなどで開き、`value` 列だけを書き換える。`meta.version` を新しい番号に、`meta.parent_version` を元の版にする（公開した版は書き換えず、新しい版を作る。§9-1）。
3. 検証: `params validate --params my-v3.csv --base samples/params/params-v2.csv`
   - **エラー**（公開できない）: 範囲外、未知のキー、桁が細かすぎる値、τS ≥ τL、k が前ほど大きくない、燃料の表が単調でない、脚質の最大差が10%超（D7）、オールラウンダーの係数が0でない（D11）など。
   - **警告**: 前の版から20%以上変えた値、立ち直りのしきい値が回復系アイテム1個の回復量を超える、アタック禁止ゾーンがブレーキの距離より短い、など。`--course` を付けるとコースごとのチェック（ゴール前5kmの禁止ゾーンの割合など）もします。
4. `compare` と `batch` で、今の版との違いを確認してから使う。

値は小数で書けますが、内部では固定小数点の整数に変換します（各キーの最小単位より細かい桁はエラー）。各キーの単位・範囲・説明・仕様書の参照箇所は CSV の列にあります。キーを省略すると初期値が使われます。

## 出力（`run --out <dir>`）

| ファイル | 内容 |
|---|---|
| `summary.txt` | 勝者と勝ち方（逃げ切り / 終盤のアタック / 集団）、上位50人の順位・タイム・実際の差・集団の差（同じ集団なら差なし）、指標 |
| `ranking.csv` | 全員の順位・タイム・差 |
| `riders.csv` | 選手ごと: 燃料の消費・残り、バーストの消費（kJ）、ハンガーノック回数、アイテムの使用数・残り、アタック回数（立ち上がり・行き場なし・脚なし）、チェック、遅れた回数、牽引の秒数、スプリントの秒数 |
| `log.csv` | 1秒ごと・1人ごとのログ（距離・速度・集団・モード・出力・k・バースト・燃料・ボンク・先頭との差・アイテム）。300人×約5,000秒で約120MBになります。`--log-every 10` で間引き、`--no-log` で省略 |
| `result.json` | 上の内容と、パラメータの版・チェックサム、コース・名簿・作戦のチェックサム、エンジンの版 |
| `view.html` | ブラウザで開くだけの簡易ビューア（高低図上の位置と、先頭とのタイム差の推移。スライダーで時間を動かす） |

タイムと差は**シムの秒**です（1/2 縮尺なので、表示距離に対しては速く見えます）。

## サンプルの結果（一括テスト・各コース30レース）

`batch` の「逃げ切り」は、勝者の先行がレースの最後の25%より前に始まったもの（`report.breakaway_min_frac`）。「終盤アタック」はそれより後の先行での勝ち。

**① AIだけの標準テストレース（仕様 §9-5 のドライラン。目標の確認はこちら）**

| パラメータ | 平地 flat-coast（目標 20〜30%） | 山岳 mountain-pass（目標 約40%） |
|---|---|---|
| v1（仕様書の初期値: α 普通1.5・積極1.0） | **93.3%**（勝者 rouleur 28/30） | **76.7%**（rouleur 23/30） |
| v2（α 普通0.3・積極0.2、山岳のAI逃げテンプレート 0.14→0.20） | **26.7%**（集団ゴール 73%、勝者 sprinter 20/30） | **46.7%**（終盤アタック 50%、climber 14・rouleur 14） |

**② サンプルの名簿・作戦（8チーム）＋AI 42チーム**

| パラメータ | 平地 | 山岳 |
|---|---|---|
| v1 | 100% | 56.7% |
| v2 | 13.3%（終盤アタック 30%。勝者 puncheur 26/30 = T04 の最終盤の立ち上がりアタック） | **6.7%**（終盤アタック 93%、climber 25/30） |

- v1 で逃げが勝ちすぎる原因は α ではありません（次の節の 2.）。1人・2人の逃げは v1 でも全敗します。
- v2 は①に合わせたもので、**入力によって割合が大きく変わります**（②の山岳は 6.7%）。山岳の逃げテンプレートの比率は 0.18 → 23%、0.20 → 43%、0.22 → 60% と敏感です（追走の不具合の修正前の測定）。本番に近い作戦の分布で、もう一度ドライランして合わせる必要があります。
- 再現: `batch --courses ... --races 30 --params samples/params/params-v1.csv --params-b samples/params/params-v2.csv`（②は `--roster samples/roster.csv --plans-dir samples/plans` を追加）。1レースの計算は約1.2〜1.4秒（ログなし）。

## レースの再生（リプレイビューア）

シムの結果を、上から見たコースの地図の上で再生するWebアプリです（`viewer/`、Vite + TypeScript + Canvas）。サンプルの2コースのリプレイが `viewer/public/replays/` に入っているので、そのまま開けます。

```sh
cd viewer
npm install
npm run dev          # http://127.0.0.1:5173 を開く
npm run build        # 静的ファイルを viewer/dist/ に（どこかのサーバーに置けば動く）
```

リプレイの作り直し・別のレースのリプレイ:

```sh
npm run build                       # リポジトリの直下で
sh scripts/make-replays.sh          # サンプル2コースを作り直す
node dist/src/replay-cli.js --course samples/courses/flat-coast.json --roster samples/roster.csv \
  --plans samples/plans/flat-coast --params samples/params/params-v2.csv --out my-race.json.gz
```

`my-race.json.gz` は、ビューアの「ファイルを開く」か、画面へのドラッグ＆ドロップで開けます。リプレイは、各選手の位置・レーン・状態のキーフレーム（中盤は10秒ごと、アタックやコーナーの前後と最後の1kmは1秒ごと）とイベントのgzip JSONで、1レース250〜600KBです。

画面と操作:

- **地図**: コース、コーナー（名前と半径）、アタック禁止ゾーン（赤）、立ち上がりゾーン（緑）、残り距離。選手はチームの色。集団は横6列で、先頭交代の列も描きます。集団のラベルに人数と先頭からの差
- **カメラ**: 「先頭を追う」「集団を追う」（選んだ選手の集団）「選手を追う」「自由」（ドラッグで移動）。ホイール・＋／−でズーム。「進行方向を上に」で地図が回る
- **選手**: 地図の選手をクリックすると、燃料・バースト・アイテムの残りと、その選手のイベントを表示。ダブルクリックでその選手を追う。右の「集団とタイム差」の行をクリックするとその集団を追う
- **再生**: スペースで再生／停止、←→で30秒戻る／進む。下のタイムラインをクリック・ドラッグで移動（色の線はイベント: アタック、ハンガーノック、スプリント開始、吸収など）。速度は1〜30倍で、「自動」は1レースが約5分になる倍率
- **高低図**: 登りの区間、コーナーの位置、各集団の位置
- URL で始め方を指定できます: `?replay=mountain-pass.json.gz&t=1800&speed=5&z=6&rider=T04-1&cam=rider&paused=1`

注意: 時間・タイム差はシムの秒、距離はコースの表示の距離（シムの2倍）です。先頭交代の入れ替わりの動き、コーナーの曲がる角度（半径から決めた形）、レーンの間の移動は、ビューアの演出です（シムには先頭交代の順番の変化・コースの2次元の形・レーンの間の連続した位置がないため）。シムのロジックを変えたら、リプレイも作り直してください。

## 仕様の穴・矛盾と、この試作での決め方

1. **tick の長さ**: 仕様 §4-2 は dt = 0.5秒（何も起きていない区間は1.0秒）。今回の依頼は「1秒tick」なので、**全区間1秒**にしました。コーナーのブレーキやスプリント（約10秒）の解像度が粗くなります。
2. **v1 で逃げが勝ちすぎる（平地93%・山岳77%）**: 原因は3つの重なりです。① AIの「逃げ狙い」の選手が全員同じ地点（表示6km）でアタックするので、毎回4〜7人の逃げができる（1〜2人の逃げは v1 でも全敗）。② 4〜7人の逃げの先頭交代は、追走の列（最大6人）と風よけがほぼ同じ。追走の出力の上乗せ（CP×1.05 対 0.95）も、逃げのチームメイトのブロック（−8%）でほぼ消え、速度の差は約1%しかない。追走は差を保つだけで縮められない（追走するチームを増やしても列は6人までなので速くならない）。③ 燃料は回復系アイテム（AIの逃げ役は5個持ち込み、3個使用）で足り、ハンガーノックしない（持ち込み0個にすると逃げ切りは0%）。仕様 §2-7 の見積もり（13.5m/s 対 12.7m/s）は、3人の逃げ・ブロックなしの場合です。v2 は α を下げて「差が小さいうちに追走を始め、小さい差のまま保つ」ことで割合を合わせただけで、追走が縮められない問題は残っています。詳しい調査は PR の説明を参照。
3. **「逃げ切り」の定義がない**: 「勝者の先行がレースの最後の25%より前に始まった」を逃げ切りとし、パラメータ `report.breakaway_min_frac` にしました。
4. **AIの作戦の中身がない**: 仕様にあるのは追走方針の混ぜ方（2:5:3）だけです。AIチームのテンプレートの比率（`ai.template_mix.*`）、AIのピンの位置（逃げのアタックは表示6km、山岳のアタックは最後の登りの50%地点、チェックは残り30km、牽引は残り25km）、AIの持ち込みアイテム数（`ai.loadout.*`）、空き枠のAI選手の能力値（`ai.rider_stat_base` 50・`spread` 12）を追加パラメータにしました。
5. **表の形の値**（§9-3 `param_tables`: k の表・燃料の表）: 1つのCSVで編集できるように、個別のキー（`draft.k_line1` など）に展開しました。
6. **コースの種類と T_ref**: 仕様は「コースごと」とだけ書いています。コースのファイルに `type`（flat / mountain）と `t_ref_s` を持たせました。
7. **タイムの単位**: 結果のタイムと差はシムの秒です。プレイヤーに見せるときに表示の距離に合わせて換算するかは決まっていません。
8. **能力値の効き方の差（バランス上の懸念）**: §4-1 の式では、平地 +1 で CP +1.6W（+0.47%）、登坂 +1 で体重 −0.22kg（−0.32%）。脚質の補正の前は、平地型が登りでもクライマーにあまり負けません。v2 の山岳でも勝者は climber 14・rouleur 13 です。
9. **最終盤の立ち上がりアタックが強い**: サンプルの作戦 T04（残り表示2.7kmの「駅前」コーナーの立ち上がりで鋭いアタック＋加速系）が、v2 の平地30レースのうち22レースで勝ちました。立ち上がりの空きレーンの判定、またはチェック役の反応を見直す余地があります。

## コードの構成

| ファイル | 内容 |
|---|---|
| `src/fixed.ts` | 固定小数点の演算（整数の割り算・平方根・立方根・exp の表・小数の文字列の読み込み） |
| `src/physics.ts` | 必要な出力・加速・定常速度（mW・mm・g・ppm の整数） |
| `src/course.ts` | コースの読み込み、コーナーの限界速度とゾーン、コースの検証 |
| `src/params/` | パラメータの定義（キー・単位・範囲・初期値・説明）、読み書き、検証 |
| `src/roster.ts` | 名簿、能力値 → 物理量、AI選手・AIチームの生成 |
| `src/plans.ts` | テンプレートとピンを、シムの単位の作戦に変換 |
| `src/engine.ts` | 1秒ごとの計算（集団の形・先頭交代・位置取り・コーナー・アタック・チェック・追走・スタミナ・アイテム・スプリント） |
| `src/race.ts` | レースの実行、順位・差・選手ごとの集計、ログ |
| `src/cli.ts` | コマンド（run / compare / batch / params） |
| `src/replay.ts`・`src/replay-cli.ts` | リプレイの書き出し（`onTick` で毎秒の状態を読み、キーフレームとイベントにまとめる） |
| `viewer/` | リプレイビューア（`data.ts` 読み込み、`geom.ts` コースの形、`scene.ts` 補間、`render.ts` 地図、`panels.ts` 高低図・タイムライン、`main.ts` 操作） |
