import { WIND_FARMS } from '../../data/windfarms'
import { windAt, type Weather } from '../../data/weather'
import { TURBINE, powerAt, rpmAt } from './spec'

/** Turbines are drawn 2.5x life size so the arrays stay legible from the overview. */
const TURBINE_EXAGGERATION = 2.5

/** Metres in the GLB to world units (km). */
export const TURBINE_SCALE = 0.001 * TURBINE_EXAGGERATION

const n = WIND_FARMS.length

// Per-farm live state, advanced once per frame and read by instancing shaders, the hero
// turbine and the UI. Plain typed arrays so the render loop never allocates.
export const farmDynamics = {
  /** Hub-height wind speed, m/s. */
  wind: new Float32Array(n),
  /** Direction the wind blows from, radians clockwise from north. */
  windFrom: new Float32Array(n),
  /** Nacelle yaw about +Y, radians (rotor faces into the wind). */
  yaw: new Float32Array(n),
  /** Accumulated rotor angle, radians. */
  spin: new Float32Array(n),
  rpm: new Float32Array(n),
  /** Per-turbine output, MW. */
  power: new Float32Array(n),
  initialised: false,
}

function shortestAngle(from: number, to: number): number {
  return ((((to - from) % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2)) - Math.PI
}

export function advanceFarms(weather: Weather, time: number, dt: number) {
  for (let f = 0; f < n; f++) {
    const { speed, fromRad } = windAt(weather, f, time)
    const target = Math.PI - fromRad
    farmDynamics.wind[f] = speed
    farmDynamics.windFrom[f] = fromRad
    farmDynamics.yaw[f] = farmDynamics.initialised
      ? farmDynamics.yaw[f] + shortestAngle(farmDynamics.yaw[f], target) * Math.min(1, dt * 0.8)
      : target
    const rpm = rpmAt(speed)
    farmDynamics.rpm[f] = farmDynamics.initialised ? farmDynamics.rpm[f] + (rpm - farmDynamics.rpm[f]) * Math.min(1, dt * 0.5) : rpm
    farmDynamics.spin[f] = (farmDynamics.spin[f] + (farmDynamics.rpm[f] / 60) * Math.PI * 2 * dt) % (Math.PI * 2)
    farmDynamics.power[f] = powerAt(speed) * (WIND_FARMS[f].ratedMW / TURBINE.ratedPowerMW)
  }
  farmDynamics.initialised = true
}

export function totalOutputMW(): number {
  let total = 0
  for (let f = 0; f < n; f++) total += farmDynamics.power[f] * WIND_FARMS[f].turbines
  return total
}
