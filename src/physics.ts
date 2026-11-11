// Physics in integer units: mm, mm/s, mm/s^2, g (mass), mW, mJ, ppm.
import { idiv, isqrt, mulDiv, mulP, PPM } from "./fixed.js";

export interface Slope {
  /** (Crr·cosθ + sinθ) in ppm */
  resist: number;
  grade: number; // ppm
}

export function slopeFor(gradePpm: number, crrPpm: number): Slope {
  const denom = isqrt(PPM * PPM + gradePpm * gradePpm); // ppm·sqrt(1+g^2)
  const cos = mulDiv(PPM, PPM, denom);
  const sin = mulDiv(gradePpm, PPM, denom);
  return { resist: mulP(crrPpm, cos) + sin, grade: gradePpm };
}

/**
 * Power needed [mW] to ride at v [mm/s].
 * massG: total mass incl. bike [g]; gMm: gravity [mm/s^2]; aeroCoef: 0.5·ρ·CdA·k in µkg/m; windMm: headwind [mm/s]
 */
export function pNeed(v: number, massG: number, gMm: number, slope: Slope, aeroCoef: number, windMm: number): number {
  const fGrav = mulDiv(massG * gMm, slope.resist, PPM); // µN
  const u = v + windMm;
  const fAero = mulDiv(aeroCoef, u * (u < 0 ? -u : u), PPM); // µN
  return mulDiv(fGrav + fAero, v, PPM); // mW
}

/** aero coefficient 0.5·ρ·CdA·k in µkg/m. rho in g/m³ (1.2 kg/m³ -> 1200), cda in µm² (ppm m²), k in ppm. */
export function aeroCoef(rhoGm3: number, cdaPpm: number, kPpm: number): number {
  return idiv(mulP(mulDiv(rhoGm3, cdaPpm, 1000), kPpm), 2);
}

/** Acceleration [mm/s^2] from net power [mW], effective mass [g], speed [mm/s]. */
export function accel(netMw: number, mEffG: number, v: number, vMin: number): number {
  return mulDiv(netMw, PPM, mEffG * (v > vMin ? v : vMin));
}

/** Steady speed [mm/s] for a given power (bisection; deterministic). */
export function steadySpeed(powerMw: number, massG: number, gMm: number, slope: Slope, coef: number, windMm: number, vMax: number): number {
  let lo = 0, hi = vMax;
  if (pNeed(hi, massG, gMm, slope, coef, windMm) <= powerMw) return hi;
  while (hi - lo > 1) {
    const mid = idiv(lo + hi, 2);
    if (pNeed(mid, massG, gMm, slope, coef, windMm) <= powerMw) lo = mid;
    else hi = mid;
  }
  return lo;
}
