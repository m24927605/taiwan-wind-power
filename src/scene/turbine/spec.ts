// Physical spec of the 8 MW-class offshore turbine used across Taiwan's Strait farms.
// The GLB is authored in metres with the turbine root at sea level, rotor facing +Z.

export const TURBINE = {
  hubHeight: 112,
  rotorRadius: 84,
  hubOffsetZ: 7.5,
  ratedPowerMW: 8,
  cutInMs: 3,
  ratedMs: 12,
  // High-wind ride-through, generic rather than any farm's own controller settings (which are not
  // public): from 25 m/s output and rotor speed ease down, at 30 m/s the rotor is feathered and
  // stops producing, and it restarts only once the wind is back below 22 m/s.
  derateMs: 25,
  cutOutMs: 30,
  restartMs: 22,
  ratedRpm: 10.6,
  /** Feathered rotors still idle in a breeze rather than stand dead still. */
  idleRpm: 1.5,
} as const

/** Share of rated output and speed left between the start of the derating and cut-out. */
function derating(windMs: number): number {
  const { derateMs, cutOutMs } = TURBINE
  return Math.min(1, (cutOutMs - windMs) / (cutOutMs - derateMs))
}

/**
 * Electrical output in MW for a hub-height wind speed, from a cubic power curve, derated in high
 * wind; nothing while shut down.
 */
export function powerAt(windMs: number, shutDown = false): number {
  const { cutInMs, ratedMs, cutOutMs, ratedPowerMW } = TURBINE
  if (shutDown || windMs < cutInMs || windMs >= cutOutMs) return 0
  if (windMs >= ratedMs) return ratedPowerMW * derating(windMs)
  return (ratedPowerMW * (windMs ** 3 - cutInMs ** 3)) / (ratedMs ** 3 - cutInMs ** 3)
}

/**
 * Rotor speed in rpm: tip-speed-ratio tracking up to rated, then held at rated rpm and eased down
 * with the derating. Outside the operating range the blades are feathered and the rotor idles
 * without producing power.
 */
export function rpmAt(windMs: number, shutDown = false): number {
  const { cutInMs, ratedMs, cutOutMs, ratedRpm, idleRpm } = TURBINE
  if (shutDown || windMs >= cutOutMs) return idleRpm
  if (windMs < cutInMs) return idleRpm * Math.min(1, windMs / cutInMs)
  const rpm = ratedRpm * Math.min(1, 0.35 + (0.65 * (windMs - cutInMs)) / (ratedMs - cutInMs))
  return idleRpm + (rpm - idleRpm) * derating(windMs)
}
