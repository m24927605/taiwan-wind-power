import { WIND_FARMS } from '../../data/windfarms'
import { hourIndex, windAt, type Weather } from '../../data/weather'
import { lonLatToWorld } from '../../geo/domain'
import { TURBINE, TURBINE_MODELS, powerAt, rpmAt } from './spec'

const n = WIND_FARMS.length

/** Kilometres (world units) per metre of the GLB. */
const KM_PER_M = 0.001
/**
 * At sea level turbines are life size, so arrays keep their real spacing of six to eight rotor
 * diameters. From the overview they would vanish, so they grow with the eye's altitude, up to this.
 */
const MAX_EXAGGERATION = 2.5
const LIFE_SIZE_BELOW_KM = 1
const FULL_SIZE_ABOVE_KM = 40
/** Each farm's machine relative to the shared model, by rotor diameter. */
const FARM_SIZE = WIND_FARMS.map((f) => f.rotorM / (2 * TURBINE.rotorRadius))

/** How much larger than life turbines are drawn for the current camera; set once per frame. */
export const turbineView = { exaggeration: 1 }

/** Eases the exaggeration in over altitude (km) on a log scale, as the view widens. */
export function updateTurbineView(altitudeKm: number) {
  const t = Math.log(Math.max(altitudeKm, LIFE_SIZE_BELOW_KM) / LIFE_SIZE_BELOW_KM) / Math.log(FULL_SIZE_ABOVE_KM / LIFE_SIZE_BELOW_KM)
  const k = Math.min(t, 1)
  turbineView.exaggeration = 1 + (MAX_EXAGGERATION - 1) * k * k * (3 - 2 * k)
}

/** Life-size world units per model metre for a farm's turbines. */
export function lifeScale(farm: number): number {
  return KM_PER_M * FARM_SIZE[farm]
}

/** World units per model metre for a farm's turbines as drawn now. */
export function turbineScale(farm: number): number {
  return lifeScale(farm) * turbineView.exaggeration
}

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
  /** 1 while the farm is shut down by high wind. */
  shutDown: new Uint8Array(n),
  initialised: false,
}

function shortestAngle(from: number, to: number): number {
  return ((((to - from) % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2)) - Math.PI
}

/**
 * Whether a farm stands shut down at time t, given its wind there: once the wind reaches its
 * machine's cut-out it
 * stays down until the wind falls below the restart speed. Worked out from the hourly wind rather
 * than carried from frame to frame, so it holds wherever the timeline is scrubbed to. The wind is
 * interpolated linearly, so between samples it never goes beyond them and the samples suffice.
 */
function shutDownAt(weather: Weather, farm: number, t: number, speed: number): boolean {
  const { cutOutMs } = TURBINE_MODELS[WIND_FARMS[farm].model]
  const { restartMs } = TURBINE
  if (speed >= cutOutMs) return true
  if (speed < restartMs) return false
  const w = weather.wind[farm]
  for (let h = Math.floor(hourIndex(weather, t)); h >= 0; h--) {
    if (w[h * 2] >= cutOutMs) return true
    if (w[h * 2] < restartMs) return false
  }
  return false
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
    const shutDown = shutDownAt(weather, f, time, speed)
    farmDynamics.shutDown[f] = shutDown ? 1 : 0
    const { model, ratedMW } = WIND_FARMS[f]
    const rpm = rpmAt(speed, model, shutDown)
    farmDynamics.rpm[f] = farmDynamics.initialised ? farmDynamics.rpm[f] + (rpm - farmDynamics.rpm[f]) * Math.min(1, dt * 0.5) : rpm
    farmDynamics.spin[f] = (farmDynamics.spin[f] + (farmDynamics.rpm[f] / 60) * Math.PI * 2 * dt) % (Math.PI * 2)
    farmDynamics.power[f] = powerAt(speed, model, shutDown) * (ratedMW / TURBINE.ratedPowerMW)
  }
  farmDynamics.initialised = true
}

const farmXZ = WIND_FARMS.map((f) => lonLatToWorld(f.lon, f.lat))

/**
 * Hub-height wind at a world position, m/s: the farms' winds weighted by inverse squared
 * distance, so among a farm it is that farm's wind and between farms it blends.
 */
export function windNear(x: number, z: number): number {
  let sum = 0
  let weight = 0
  for (let f = 0; f < n; f++) {
    const w = 1 / ((x - farmXZ[f][0]) ** 2 + (z - farmXZ[f][1]) ** 2 + 1)
    sum += farmDynamics.wind[f] * w
    weight += w
  }
  return sum / weight
}

export function totalOutputMW(): number {
  let total = 0
  for (let f = 0; f < n; f++) total += farmDynamics.power[f] * WIND_FARMS[f].turbines
  return total
}
