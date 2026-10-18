// Physical spec of the 8 MW-class offshore turbine used across Taiwan's Strait farms.
// The GLB is authored in metres with the turbine root at sea level, rotor facing +Z.

import { modelUrl } from '../../modelUrl'

export const TURBINE = {
  hubHeight: 112,
  rotorRadius: 84,
  hubOffsetZ: 7.5,
  ratedPowerMW: 8,
  cutInMs: 3,
  ratedMs: 12,
  cutOutMs: 25,
  ratedRpm: 10.6,
  /** Feathered rotors still idle in a breeze rather than stand dead still. */
  idleRpm: 1.5,
} as const

export const TURBINE_GLB_URL = modelUrl('turbine')

/** Electrical output in MW for a hub-height wind speed, from a cubic power curve. */
export function powerAt(windMs: number): number {
  const { cutInMs, ratedMs, cutOutMs, ratedPowerMW } = TURBINE
  if (windMs < cutInMs || windMs >= cutOutMs) return 0
  if (windMs >= ratedMs) return ratedPowerMW
  return (ratedPowerMW * (windMs ** 3 - cutInMs ** 3)) / (ratedMs ** 3 - cutInMs ** 3)
}

/**
 * Rotor speed in rpm: tip-speed-ratio tracking up to rated, then held at rated rpm. Outside the
 * operating range the blades are feathered and the rotor idles without producing power.
 */
export function rpmAt(windMs: number): number {
  const { cutInMs, ratedMs, cutOutMs, ratedRpm, idleRpm } = TURBINE
  if (windMs < cutInMs) return idleRpm * Math.min(1, windMs / cutInMs)
  if (windMs >= cutOutMs) return idleRpm
  return ratedRpm * Math.min(1, 0.35 + (0.65 * (windMs - cutInMs)) / (ratedMs - cutInMs))
}
