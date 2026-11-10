// Integer-only arithmetic helpers. All simulation state is held in safe integers
// (|x| < 2^53); no Math.exp/pow/cbrt (engine-dependent) is ever used.
import { createHash } from "node:crypto";

export const PPM = 1_000_000;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;

/** Floor division, exact for safe integers. */
export function idiv(a: number, b: number): number {
  if (b === 0) throw new Error("idiv by zero");
  let q = Math.floor(a / b);
  const r = a - q * b;
  if (b > 0) {
    if (r < 0) q -= 1;
    else if (r >= b) q += 1;
  } else {
    if (r > 0) q -= 1;
    else if (r <= b) q += 1;
  }
  return q;
}

/** floor(a*b/c); falls back to BigInt when the product is not a safe integer. */
export function mulDiv(a: number, b: number, c: number): number {
  const p = a * b;
  if (p <= MAX_SAFE && p >= -MAX_SAFE) return idiv(p, c);
  const bp = BigInt(a) * BigInt(b);
  const bc = BigInt(c);
  let q = bp / bc;
  if ((bp % bc !== 0n) && ((bp < 0n) !== (bc < 0n))) q -= 1n;
  return Number(q);
}

/** a*b/PPM (a in any unit, b in ppm). */
export function mulP(a: number, b: number): number {
  return mulDiv(a, b, PPM);
}

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/** floor(sqrt(n)) for 0 <= n <= MAX_SAFE. Math.sqrt is correctly rounded (IEEE), then fixed up. */
export function isqrt(n: number): number {
  if (n <= 0) return 0;
  let r = Math.floor(Math.sqrt(n));
  while (r * r > n) r -= 1;
  while ((r + 1) * (r + 1) <= n) r += 1;
  return r;
}

export function icbrtBig(n: bigint): bigint {
  if (n <= 0n) return 0n;
  let x = 1n;
  while (x * x * x <= n) x <<= 1n;
  let lo = x >> 1n;
  let hi = x;
  while (lo < hi) {
    const mid = (lo + hi + 1n) >> 1n;
    if (mid * mid * mid <= n) lo = mid;
    else hi = mid - 1n;
  }
  return lo;
}

/** smoothstep(a,b,x) in ppm (0..PPM). a,b,x in the same integer unit. */
export function smoothstep(a: number, b: number, x: number): number {
  if (x <= a) return 0;
  if (x >= b) return PPM;
  const t = mulDiv(x - a, PPM, b - a);
  // t^2 (3 - 2t)
  const t2 = mulP(t, t);
  return mulP(t2, 3 * PPM - 2 * t);
}

// e^(-x) table at 1/1000 resolution, built with BigInt from an exact constant.
const EXP_TABLE_MAX = 30_000; // x up to 30.0
const EXP_SCALE = 1_000_000_000_000; // 1e12
let expTable: number[] | null = null;

function buildExpTable(): number[] {
  // e^(-1/1000) to 40 digits: 0.9990004998333749916680553571676559747024
  const S = 10n ** 30n;
  const step = 999000499833374991668055357168n; // * 1e-30
  const out: number[] = new Array(EXP_TABLE_MAX + 2);
  let v = S;
  const toOut = 10n ** 18n; // 1e30 -> 1e12
  for (let i = 0; i <= EXP_TABLE_MAX + 1; i++) {
    out[i] = Number(v / toOut);
    v = (v * step) / S;
  }
  return out;
}

/** e^(-x) where x is given in ppm (x >= 0); result in ppm. */
export function expNegPpm(xPpm: number): number {
  if (xPpm <= 0) return PPM;
  if (!expTable) expTable = buildExpTable();
  const idx = idiv(xPpm, 1000);
  if (idx >= EXP_TABLE_MAX) return 0;
  const frac = xPpm - idx * 1000;
  const t0 = expTable[idx];
  const t1 = expTable[idx + 1];
  const v = t0 - idiv((t0 - t1) * frac, 1000);
  return idiv(v, EXP_SCALE / PPM);
}

/**
 * Parse a decimal literal (string or JSON number) into an integer scaled by `scale`
 * (a power of ten). Exact: never goes through floating point arithmetic.
 * Throws if the literal has more fractional digits than the scale can hold.
 */
export function parseDecimal(input: string | number, scale: number, what = "value"): number {
  const str = typeof input === "number" ? numberToLiteral(input) : String(input).trim();
  const m = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(str);
  if (!m || (m[2] === "" && (m[3] === undefined || m[3] === ""))) {
    throw new Error(`${what}: 数値として読めません: "${str}"`);
  }
  const sign = m[1] === "-" ? -1n : 1n;
  let digits = (m[2] || "") + (m[3] || "");
  let exp10 = (m[4] ? parseInt(m[4], 10) : 0) - (m[3] ? m[3].length : 0);
  let scaleDigits = 0;
  for (let s = scale; s > 1; s = s / 10) scaleDigits++;
  if (10 ** scaleDigits !== scale) throw new Error(`scale must be a power of ten: ${scale}`);
  exp10 += scaleDigits;
  digits = digits.replace(/^0+(?=\d)/, "");
  let big = BigInt(digits === "" ? "0" : digits);
  if (exp10 >= 0) {
    big = big * 10n ** BigInt(exp10);
  } else {
    const div = 10n ** BigInt(-exp10);
    if (big % div !== 0n) {
      throw new Error(`${what}: 小数点以下の桁が多すぎます（最小単位 ${1 / scale}）: "${str}"`);
    }
    big = big / div;
  }
  const out = sign * big;
  if (out > BigInt(MAX_SAFE) || out < -BigInt(MAX_SAFE)) throw new Error(`${what}: 値が大きすぎます: "${str}"`);
  return Number(out);
}

function numberToLiteral(n: number): string {
  if (!Number.isFinite(n)) throw new Error(`not a finite number: ${n}`);
  // Number#toString yields the shortest round-trip literal (ECMAScript spec), deterministic.
  return n.toString();
}

/** Format a scaled integer as a decimal string (exact). */
export function formatScaled(v: number, scale: number, maxFrac?: number): string {
  const neg = v < 0;
  const a = Math.abs(v);
  const ip = Math.floor(a / scale);
  let fp = a - ip * scale;
  let fd = 0;
  for (let s = scale; s > 1; s /= 10) fd++;
  let fs = fd > 0 ? String(fp).padStart(fd, "0") : "";
  if (maxFrac !== undefined && fs.length > maxFrac) fs = fs.slice(0, maxFrac);
  fs = fs.replace(/0+$/, "");
  return (neg ? "-" : "") + String(ip) + (fs ? "." + fs : "");
}

/** sha256 (first 16 hex chars) of a canonical text. */
export function checksum(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}
