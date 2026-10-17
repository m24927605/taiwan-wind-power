// Physical spec of the 8 MW-class offshore turbine used across Taiwan's Strait farms.
// The GLB is authored in metres with the turbine root at sea level, rotor facing +Z.

export const TURBINE = {
  hubHeight: 112,
  rotorRadius: 84,
  hubOffsetZ: 7.5,
  ratedPowerMW: 8,
  cutInMs: 3,
  ratedMs: 12,
  cutOutMs: 25,
  ratedRpm: 10.6,
} as const

export const TURBINE_GLB_URL = '/models/turbine.glb'

/** Electrical output in MW for a hub-height wind speed, from a cubic power curve. */
export function powerAt(windMs: number): number {
  const { cutInMs, ratedMs, cutOutMs, ratedPowerMW } = TURBINE
  if (windMs < cutInMs || windMs >= cutOutMs) return 0
  if (windMs >= ratedMs) return ratedPowerMW
  return (ratedPowerMW * (windMs ** 3 - cutInMs ** 3)) / (ratedMs ** 3 - cutInMs ** 3)
}

/** Rotor speed in rpm: tip-speed-ratio tracking up to rated, then held at rated rpm. */
export function rpmAt(windMs: number): number {
  const { cutInMs, ratedMs, cutOutMs, ratedRpm } = TURBINE
  if (windMs < cutInMs || windMs >= cutOutMs) return 0
  return ratedRpm * Math.min(1, 0.35 + (0.65 * (windMs - cutInMs)) / (ratedMs - cutInMs))
}
