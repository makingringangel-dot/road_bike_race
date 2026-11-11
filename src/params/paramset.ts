import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { checksum, formatScaled, parseDecimal } from "../fixed.js";
import { csvLine, parseCsv } from "../csv.js";
import { PARAM_DEFS, PARAM_DEF_MAP } from "./definitions.js";

export type ParamStatus = "draft" | "validated" | "published" | "archived";

export interface ParamSet {
  version: number;
  parentVersion: number | null;
  status: ParamStatus;
  note: string;
  /** scaled integer values, complete (missing keys filled with defaults) */
  values: Record<string, number>;
  /** keys that were missing from the file and filled from defaults */
  defaulted: string[];
  /** problems found while reading (unknown keys, bad literals) */
  loadErrors: string[];
  checksum: string;
  source: string;
}

export function defaultValues(): Record<string, number> {
  const v: Record<string, number> = {};
  for (const d of PARAM_DEFS) v[d.key] = parseDecimal(d.def, d.scale, d.key);
  return v;
}

export function paramChecksum(values: Record<string, number>, version: number): string {
  const keys = Object.keys(values).sort();
  return checksum(`version=${version}\n` + keys.map((k) => `${k}=${values[k]}`).join("\n"));
}

interface RawSet {
  meta: Record<string, string>;
  entries: [string, string | number][];
}

function readRaw(path: string): RawSet {
  const text = readFileSync(path, "utf8");
  const meta: Record<string, string> = {};
  const entries: [string, string | number][] = [];
  if (extname(path).toLowerCase() === ".json") {
    const j = JSON.parse(text);
    for (const k of ["version", "parent_version", "status", "note"]) if (j[k] !== undefined) meta[k] = String(j[k]);
    for (const [k, v] of Object.entries(j.values ?? {})) entries.push([k, v as string | number]);
  } else {
    const rows = parseCsv(text);
    for (const r of rows) {
      const key = (r[0] ?? "").trim();
      if (!key || key.startsWith("#") || key === "key") continue;
      const val = (r[1] ?? "").trim();
      if (key.startsWith("meta.")) meta[key.slice(5)] = val;
      else entries.push([key, val]);
    }
  }
  return { meta, entries };
}

export function loadParamSet(path: string | null): ParamSet {
  const values = defaultValues();
  if (!path) {
    return {
      version: 0, parentVersion: null, status: "draft", note: "built-in defaults",
      values, defaulted: [], loadErrors: [], checksum: paramChecksum(values, 0), source: "(defaults)",
    };
  }
  const raw = readRaw(path);
  const loadErrors: string[] = [];
  const seen = new Set<string>();
  for (const [k, v] of raw.entries) {
    const d = PARAM_DEF_MAP.get(k);
    if (!d) {
      loadErrors.push(`未知のキー: ${k}`);
      continue;
    }
    if (seen.has(k)) loadErrors.push(`キーが重複しています: ${k}`);
    seen.add(k);
    try {
      values[k] = parseDecimal(v, d.scale, k);
    } catch (e) {
      loadErrors.push((e as Error).message);
    }
  }
  const defaulted = PARAM_DEFS.filter((d) => !seen.has(d.key)).map((d) => d.key);
  const version = raw.meta.version !== undefined ? parseInt(raw.meta.version, 10) : NaN;
  if (!Number.isInteger(version) || version < 0) loadErrors.push(`meta.version が整数ではありません: "${raw.meta.version ?? ""}"`);
  const pv = raw.meta.parent_version ? parseInt(raw.meta.parent_version, 10) : null;
  const status = (raw.meta.status ?? "draft") as ParamStatus;
  if (!["draft", "validated", "published", "archived"].includes(status)) loadErrors.push(`meta.status が不正です: ${status}`);
  const ver = Number.isInteger(version) ? version : -1;
  return {
    version: ver, parentVersion: pv !== null && Number.isInteger(pv) ? pv : null, status, note: raw.meta.note ?? "",
    values, defaulted, loadErrors, checksum: paramChecksum(values, ver), source: path,
  };
}

/** Export a full parameter set as CSV (all keys, with unit/range/description columns for the admin). */
export function exportCsv(values: Record<string, number>, meta: { version: number; parentVersion?: number | null; status?: string; note?: string }): string {
  const lines: string[] = [];
  lines.push("# パラメータセット（管理者が編集するファイル）。key と value の列だけが読み込まれます。");
  lines.push("# 値は小数で書けます（内部では固定小数点の整数に変換。最小単位より細かい桁はエラー）。");
  lines.push(csvLine(["key", "value", "unit", "min", "max", "default", "description", "ref"]));
  lines.push(csvLine(["meta.version", meta.version, "", "", "", "", "版（公開した版は変更せず、新しい版を作る）", "core §9-1"]));
  lines.push(csvLine(["meta.parent_version", meta.parentVersion ?? "", "", "", "", "", "元にした版", "core §9-3"]));
  lines.push(csvLine(["meta.status", meta.status ?? "draft", "", "", "", "", "draft / validated / published / archived", "core §9-3"]));
  lines.push(csvLine(["meta.note", meta.note ?? "", "", "", "", "", "メモ", ""]));
  let group = "";
  for (const d of PARAM_DEFS) {
    if (d.group !== group) {
      group = d.group;
      lines.push(`# --- ${group} ---`);
    }
    lines.push(csvLine([d.key, formatScaled(values[d.key], d.scale), d.unit, d.min, d.max, d.def, d.desc, d.ref]));
  }
  return lines.join("\n") + "\n";
}

/** Value as a human decimal string. */
export function fmtParam(key: string, v: number): string {
  const d = PARAM_DEF_MAP.get(key);
  return d ? formatScaled(v, d.scale) : String(v);
}
