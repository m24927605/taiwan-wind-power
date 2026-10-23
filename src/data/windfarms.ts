import { lonLatToWorld } from '../geo/domain'
import type { TurbineModel } from '../scene/turbine/spec'

// Commissioned offshore wind farms in the Taiwan Strait. Turbine counts and ratings follow
// public project data; turbine coordinates are an approximate grid layout around each farm
// centre, not surveyed positions.
export interface WindFarm {
  id: string
  name: string
  nameEn: string
  lon: number
  lat: number
  turbines: number
  ratedMW: number
  /** Grid orientation in degrees, clockwise from north. */
  heading: number
  spacingKm: number
  /** Rotor diameter of the farm's machine, m: the shared turbine model is scaled to it. */
  rotorM: number
  /** The farm's machine, which sets how it meets high wind. */
  model: TurbineModel
  /** Its units in Taipower's output data (taipower.ts). */
  taipowerUnits: string[]
}

export const WIND_FARMS: WindFarm[] = [
  { id: 'formosa1', name: '海洋竹南', nameEn: 'Formosa 1', lon: 120.81, lat: 24.71, turbines: 22, ratedMW: 5.5, heading: 30, spacingKm: 0.9, rotorM: 154, model: 'SWT-6.0-154', taipowerUnits: ['海洋竹南'] },
  { id: 'formosa2', name: '海能', nameEn: 'Formosa 2', lon: 120.66, lat: 24.6, turbines: 47, ratedMW: 8, heading: 30, spacingKm: 1.1, rotorM: 167, model: 'SG 8.0-167 DD', taipowerUnits: ['海能風'] },
  { id: 'tpc1', name: '台電一期', nameEn: 'TPC Phase 1', lon: 120.27, lat: 23.96, turbines: 21, ratedMW: 5.2, heading: 25, spacingKm: 0.9, rotorM: 136, model: 'HTW5.2-136', taipowerUnits: ['離岸一期'] },
  { id: 'zhongneng', name: '中能', nameEn: 'Zhong Neng', lon: 120.24, lat: 24.04, turbines: 31, ratedMW: 9.5, heading: 25, spacingKm: 1.1, rotorM: 174, model: 'V174-9.5', taipowerUnits: ['中能風'] },
  { id: 'changfang', name: '彰芳暨西島', nameEn: 'Changfang & Xidao', lon: 120.16, lat: 24.11, turbines: 62, ratedMW: 9.5, heading: 25, spacingKm: 1.15, rotorM: 174, model: 'V174-9.5', taipowerUnits: ['芳一風', '芳二風'] },
  { id: 'gc12a', name: '大彰化東南及西南', nameEn: 'Greater Changhua 1 & 2a', lon: 120.05, lat: 24.17, turbines: 111, ratedMW: 8, heading: 25, spacingKm: 1.1, rotorM: 167, model: 'SG 8.0-167 DD', taipowerUnits: ['沃一風', '沃二風'] },
  { id: 'gc2b4', name: '大彰化西北', nameEn: 'Greater Changhua 2b & 4', lon: 119.94, lat: 24.27, turbines: 66, ratedMW: 14, heading: 25, spacingKm: 1.4, rotorM: 222, model: 'SG 14-222 DD', taipowerUnits: ['沃南風', '沃四風'] },
  { id: 'hailong', name: '海龍', nameEn: 'Hai Long 2 & 3', lon: 119.9, lat: 24.0, turbines: 73, ratedMW: 14, heading: 25, spacingKm: 1.4, rotorM: 222, model: 'SG 14-222 DD', taipowerUnits: ['龍A風', '龍B風', '龍三風'] },
  { id: 'yunneng', name: '允能', nameEn: 'Yunneng', lon: 120.06, lat: 23.79, turbines: 80, ratedMW: 8, heading: 20, spacingKm: 1.1, rotorM: 167, model: 'SG 8.0-167 DD', taipowerUnits: ['允湖', '允西'] },
]

export interface Turbine {
  index: number
  farm: number
  x: number
  z: number
  /** Rotor phase offset in radians so neighbouring rotors are not in lockstep. */
  phase: number
}

function mulberry32(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function layout(): Turbine[] {
  const rand = mulberry32(20261018)
  const turbines: Turbine[] = []
  WIND_FARMS.forEach((farm, f) => {
    const [cx, cz] = lonLatToWorld(farm.lon, farm.lat)
    const cols = Math.ceil(Math.sqrt(farm.turbines * 1.6))
    const rows = Math.ceil(farm.turbines / cols)
    const h = (farm.heading * Math.PI) / 180
    // Rows run along the heading; columns are staggered by half a spacing like real arrays.
    const along = [Math.sin(h), -Math.cos(h)]
    const across = [Math.cos(h), Math.sin(h)]
    for (let k = 0; k < farm.turbines; k++) {
      const r = Math.floor(k / cols)
      const c = k % cols
      const a = (r - (rows - 1) / 2) * farm.spacingKm * 1.6 + (rand() - 0.5) * 0.12
      const b = (c - (cols - 1) / 2 + (r % 2) * 0.5) * farm.spacingKm + (rand() - 0.5) * 0.12
      turbines.push({
        index: turbines.length,
        farm: f,
        x: cx + along[0] * a + across[0] * b,
        z: cz + along[1] * a + across[1] * b,
        phase: rand() * Math.PI * 2,
      })
    }
  })
  return turbines
}

export const TURBINES = layout()
