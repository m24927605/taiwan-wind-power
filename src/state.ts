import { create } from 'zustand'
import type { Elevation } from './data/elevation'
import type { Weather } from './data/weather'

export type Tool = 'inspect' | 'measure'

export interface RenderStats {
  fps: number
  frameMs: number
  calls: number
  triangles: number
  points: number
  geometries: number
  textures: number
  programs: number
  dpr: number
  lod: [near: number, mid: number, far: number]
  particles: number
}

interface State {
  elevation: Elevation | null
  weather: Weather | null
  error: string | null

  /** Scene time, unix seconds. */
  time: number
  /** Follow the wall clock; otherwise scene time advances at `speed` hours per second. */
  live: boolean
  speed: number

  tool: Tool
  hovered: number | null
  /** Farm area under the pointer, while farms are picked as a whole (from afar). */
  hoveredFarm: number | null
  selected: number | null
  measure: [x: number, z: number][]

  engineering: boolean
  /** The camera rests at (or near) the overview of the whole island. */
  atOverview: boolean
  stats: RenderStats | null
}

export const useStore = create<State>(() => ({
  elevation: null,
  weather: null,
  error: null,
  time: Date.now() / 1000,
  live: true,
  speed: 0,
  tool: 'inspect',
  hovered: null,
  hoveredFarm: null,
  selected: null,
  measure: [],
  engineering: false,
  atOverview: true,
  stats: null,
}))
