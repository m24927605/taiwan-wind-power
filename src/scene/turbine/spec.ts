// Physical spec of the 8 MW-class offshore turbine used across Taiwan's Strait farms.
// The GLB is authored in metres with the turbine root at sea level, rotor facing +Z.

export const TURBINE = {
  hubHeight: 112,
  rotorRadius: 84,
  hubOffsetZ: 7.5,
  ratedPowerMW: 8,
  cutInMs: 3,
  ratedMs: 12,
  /** After a high-wind shutdown a turbine restarts only once the wind is back below this. */
  restartMs: 22,
  ratedRpm: 10.6,
  /** Feathered rotors still idle in a breeze rather than stand dead still. */
  idleRpm: 1.5,
} as const

/**
 * How each machine in the Strait meets high wind: from `derateMs` output and rotor speed ease down,
 * and at `cutOutMs` the rotor is feathered and stops producing; where the two match it stops at
 * once. Manufacturers' figures where published, otherwise the turbine databases':
 * - Hitachi HTW5.2-136, Siemens SWT-6.0-154, SG 8.0-167 DD and SG 14-222 DD stop at 25 m/s.
 *   Siemens Gamesa sells high-wind ride-through as an option (to 32 m/s on the SG 14-222 DD), but
 *   Taipower's output shows these farms stopped in 26-29 m/s.
 * - Vestas V174-9.5 lists a 25 m/s cut-out offshore and 31 m/s with its high-wind operation, which
 *   Zhong Neng and Changfang keep producing through.
 */
export const TURBINE_MODELS = {
  'HTW5.2-136': { derateMs: 25, cutOutMs: 25 },
  'SWT-6.0-154': { derateMs: 25, cutOutMs: 25 },
  'SG 8.0-167 DD': { derateMs: 25, cutOutMs: 25 },
  'V174-9.5': { derateMs: 25, cutOutMs: 31 },
  'SG 14-222 DD': { derateMs: 25, cutOutMs: 25 },
} as const satisfies Record<string, { derateMs: number; cutOutMs: number }>

export type TurbineModel = keyof typeof TURBINE_MODELS

/** Share of rated output and speed left between the start of the derating and cut-out. */
function derating(windMs: number, model: TurbineModel): number {
  const { derateMs, cutOutMs } = TURBINE_MODELS[model]
  return windMs <= derateMs ? 1 : (cutOutMs - windMs) / (cutOutMs - derateMs)
}

/**
 * Electrical output in MW for a hub-height wind speed, from a cubic power curve, derated in high
 * wind; nothing while shut down.
 */
export function powerAt(windMs: number, model: TurbineModel, shutDown = false): number {
  const { cutInMs, ratedMs, ratedPowerMW } = TURBINE
  if (shutDown || windMs < cutInMs || windMs >= TURBINE_MODELS[model].cutOutMs) return 0
  if (windMs >= ratedMs) return ratedPowerMW * derating(windMs, model)
  return (ratedPowerMW * (windMs ** 3 - cutInMs ** 3)) / (ratedMs ** 3 - cutInMs ** 3)
}

/**
 * Rotor speed in rpm: tip-speed-ratio tracking up to rated, then held at rated rpm and eased down
 * with the derating. Outside the operating range the blades are feathered and the rotor idles
 * without producing power.
 */
export function rpmAt(windMs: number, model: TurbineModel, shutDown = false): number {
  const { cutInMs, ratedMs, ratedRpm, idleRpm } = TURBINE
  if (shutDown || windMs >= TURBINE_MODELS[model].cutOutMs) return idleRpm
  if (windMs < cutInMs) return idleRpm * Math.min(1, windMs / cutInMs)
  const rpm = ratedRpm * Math.min(1, 0.35 + (0.65 * (windMs - cutInMs)) / (ratedMs - cutInMs))
  return idleRpm + (rpm - idleRpm) * derating(windMs, model)
}
