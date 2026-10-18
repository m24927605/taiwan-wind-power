import { create } from 'zustand'

// The soundscape, in Web Audio. Recorded beds (waves, sea wind, a turbine up close, gulls, music)
// are mixed with layers synthesised from noise so they can follow the live data: the wind's hiss
// tracks the hub-height wind with gusts, and each blade's whoosh is noise amplitude-modulated at
// the blade-pass frequency of the nearest turbine. Five channels reach the master: music,
// ambience, the wind noise, and interface effects.

export type Channel = 'master' | 'music' | 'ambience' | 'noise' | 'effects'
export const CHANNELS: Channel[] = ['master', 'music', 'ambience', 'noise', 'effects']

const DEFAULT_LEVELS: Record<Channel, number> = { master: 0.8, music: 0.4, ambience: 0.85, noise: 0.45, effects: 0.6 }
const STORAGE_KEY = 'wind-tide:sound'

interface SoundState {
  /** The viewer wants sound; it starts on their next gesture if the page loaded with it on. */
  enabled: boolean
  levels: Record<Channel, number>
  panelOpen: boolean
}

function saved(): Pick<SoundState, 'enabled' | 'levels'> {
  try {
    const s = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<SoundState> | null
    if (s) return { enabled: !!s.enabled, levels: { ...DEFAULT_LEVELS, ...s.levels } }
  } catch {
    // Storage blocked or corrupt: defaults.
  }
  return { enabled: false, levels: DEFAULT_LEVELS }
}

export const useSound = create<SoundState>(() => ({ ...saved(), panelOpen: false }))

useSound.subscribe(({ enabled, levels }) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ enabled, levels }))
  } catch {
    // The settings still hold for this visit.
  }
})

/** What the scene tells the soundscape each update. */
export interface SoundInputs {
  /** Camera altitude, km. */
  altitude: number
  /** Significant wave height of the combined sea, m. */
  waveHeight: number
  /** Hub-height wind where the camera is, m/s. */
  wind: number
  /** Nearest turbine: distance (km), rotor speed (rpm) and stereo position (-1 left to 1 right). */
  turbineDistance: number
  rotorRpm: number
  turbinePan: number
  /** 0 at night, 1 by day. */
  day: number
}

const FILES = {
  waves: 'audio/waves.mp3',
  seaWind: 'audio/sea-wind.mp3',
  turbine: 'audio/turbine.mp3',
  gull1: 'audio/gull1.mp3',
  gull2: 'audio/gull2.mp3',
} as const
const MUSIC = 'audio/ocean-dream.mp3'

const smoothstep = (x: number, a: number, b: number) => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1)
  return t * t * (3 - 2 * t)
}

/** Pink noise (Voss-McCartney approximation by Paul Kellet), a few seconds, looped. */
function pinkNoise(ctx: AudioContext, seconds: number): AudioBuffer {
  const buffer = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate)
  const data = buffer.getChannelData(0)
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0
  for (let i = 0; i < data.length; i++) {
    const white = Math.random() * 2 - 1
    b0 = 0.99886 * b0 + white * 0.0555179
    b1 = 0.99332 * b1 + white * 0.0750759
    b2 = 0.969 * b2 + white * 0.153852
    b3 = 0.8665 * b3 + white * 0.3104856
    b4 = 0.55 * b4 + white * 0.5329522
    b5 = -0.7616 * b5 - white * 0.016898
    data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11
    b6 = white * 0.115926
  }
  return buffer
}

class SoundEngine {
  readonly ctx = new AudioContext()
  private readonly buses: Record<Channel, GainNode>
  private readonly layers: Record<'waves' | 'seaWind' | 'turbine' | 'whoosh' | 'wind', GainNode>
  private readonly wavesFilter: BiquadFilterNode
  private readonly windFilter: BiquadFilterNode
  private readonly whoosh: { lfo: OscillatorNode; depth: GainNode; pan: StereoPannerNode }
  private readonly turbinePan: StereoPannerNode
  private readonly music = new Audio(MUSIC)
  private readonly buffers = new Map<keyof typeof FILES, AudioBuffer>()
  private gust = 0
  private gustTarget = 0
  private nextGull = 0

  constructor() {
    const ctx = this.ctx
    const compressor = ctx.createDynamicsCompressor()
    compressor.connect(ctx.destination)
    const gain = (to: AudioNode, value = 1) => {
      const g = ctx.createGain()
      g.gain.value = value
      g.connect(to)
      return g
    }
    const master = gain(compressor, 0)
    this.buses = {
      master,
      music: gain(master),
      ambience: gain(master),
      noise: gain(master),
      effects: gain(master),
    }

    // Recorded beds: waves muffle as the eye climbs away from the water.
    this.wavesFilter = ctx.createBiquadFilter()
    this.wavesFilter.type = 'lowpass'
    this.wavesFilter.connect(this.buses.ambience)
    this.turbinePan = ctx.createStereoPanner()
    this.turbinePan.connect(this.buses.ambience)
    this.layers = {
      waves: gain(this.wavesFilter, 0),
      seaWind: gain(this.buses.ambience, 0),
      turbine: gain(this.turbinePan, 0),
      whoosh: ctx.createGain(),
      wind: ctx.createGain(),
    }

    const noise = pinkNoise(ctx, 6)
    const loop = (buffer: AudioBuffer, to: AudioNode) => {
      const s = ctx.createBufferSource()
      s.buffer = buffer
      s.loop = true
      s.connect(to)
      s.start()
      return s
    }

    // The wind itself: band-passed pink noise, brighter and louder as it blows harder.
    this.windFilter = ctx.createBiquadFilter()
    this.windFilter.type = 'bandpass'
    this.windFilter.Q.value = 0.7
    loop(noise, this.windFilter)
    this.windFilter.connect(this.layers.wind)
    this.layers.wind.gain.value = 0
    this.layers.wind.connect(this.buses.noise)

    // Blade whoosh: mid-band noise whose gain swings at the blade-pass frequency.
    const whooshFilter = ctx.createBiquadFilter()
    whooshFilter.type = 'bandpass'
    whooshFilter.frequency.value = 520
    whooshFilter.Q.value = 1.1
    loop(noise, whooshFilter)
    const pan = ctx.createStereoPanner()
    whooshFilter.connect(this.layers.whoosh)
    this.layers.whoosh.gain.value = 0
    this.layers.whoosh.connect(pan)
    pan.connect(this.buses.ambience)
    const lfo = ctx.createOscillator()
    lfo.frequency.value = 0.5
    const depth = ctx.createGain()
    depth.gain.value = 0
    lfo.connect(depth)
    depth.connect(this.layers.whoosh.gain)
    lfo.start()
    this.whoosh = { lfo, depth, pan }

    // Music streams from a media element rather than being decoded whole.
    this.music.loop = true
    this.music.crossOrigin = 'anonymous'
    ctx.createMediaElementSource(this.music).connect(this.buses.music)

    void this.load(loop)
  }

  private async load(loop: (buffer: AudioBuffer, to: AudioNode) => AudioBufferSourceNode) {
    await Promise.all(
      (Object.keys(FILES) as (keyof typeof FILES)[]).map(async (key) => {
        try {
          const res = await fetch(FILES[key])
          this.buffers.set(key, await this.ctx.decodeAudioData(await res.arrayBuffer()))
        } catch (error) {
          // One missing recording costs that layer, not the soundscape.
          console.error(`[audio] ${FILES[key]} failed to load:`, error)
        }
      }),
    )
    for (const key of ['waves', 'seaWind', 'turbine'] as const) {
      const buffer = this.buffers.get(key)
      if (buffer) loop(buffer, this.layers[key])
    }
  }

  setLevels(levels: Record<Channel, number>, enabled: boolean) {
    const now = this.ctx.currentTime
    for (const c of CHANNELS) {
      // Perceived loudness is roughly logarithmic: square the slider.
      const target = c === 'master' ? (enabled ? levels.master ** 2 : 0) : levels[c] ** 2
      this.buses[c].gain.setTargetAtTime(target, now, c === 'master' ? 0.4 : 0.1)
    }
    if (enabled) {
      void this.ctx.resume()
      void this.music.play().catch(() => undefined)
    } else {
      // Let the fade finish, then stop the clock.
      setTimeout(() => {
        if (!useSound.getState().enabled) {
          this.music.pause()
          void this.ctx.suspend()
        }
      }, 1500)
    }
  }

  update(input: SoundInputs, dt: number) {
    const now = this.ctx.currentTime
    const set = (param: AudioParam, value: number, tc = 0.3) => param.setTargetAtTime(value, now, tc)
    const sea = 1 - smoothstep(input.altitude, 0.05, 3)
    const windy = smoothstep(input.wind, 2, 18)

    set(this.layers.waves.gain, sea * Math.min(0.45 + input.waveHeight / 3, 1.2))
    set(this.wavesFilter.frequency, 700 + 16000 * sea ** 2)
    set(this.layers.seaWind.gain, sea * (0.25 + 0.75 * windy) * 0.8)

    // Gusts: a slow random walk the wind noise follows.
    if (Math.random() < dt / 2.5) this.gustTarget = Math.random()
    this.gust += (this.gustTarget - this.gust) * Math.min(1, dt * 0.8)
    set(this.layers.wind.gain, (0.12 + 0.75 * windy) * (0.65 + 0.35 * this.gust) * (0.55 + 0.45 * (1 - sea)), 0.5)
    set(this.windFilter.frequency, 260 + input.wind * 38 + this.gust * 140, 0.5)

    // The nearest rotor: a whoosh per blade passing, and its machinery right under it.
    const spin = Math.min(input.rotorRpm / 10, 1)
    const whoosh = (1 - smoothstep(input.turbineDistance, 0.2, 3)) * spin
    set(this.whoosh.lfo.frequency, Math.max((3 * input.rotorRpm) / 60, 0.05))
    set(this.layers.whoosh.gain, whoosh * 0.35)
    set(this.whoosh.depth.gain, whoosh * 0.3)
    set(this.whoosh.pan.pan, input.turbinePan * 0.8)
    set(this.layers.turbine.gain, (1 - smoothstep(input.turbineDistance, 0.1, 0.9)) * (0.3 + 0.7 * spin) * 0.7)
    set(this.turbinePan.pan, input.turbinePan * 0.8)

    // Gulls by day, near the water, now and then.
    this.nextGull -= dt
    if (this.nextGull <= 0) {
      this.nextGull = 6 + Math.random() * 14
      if (input.day > 0.5 && sea > 0.6) this.play(Math.random() < 0.5 ? 'gull1' : 'gull2', 0.35 * sea, Math.random() * 1.6 - 0.8)
    }
  }

  private play(key: keyof typeof FILES, volume: number, pan: number) {
    const buffer = this.buffers.get(key)
    if (!buffer) return
    const source = this.ctx.createBufferSource()
    source.buffer = buffer
    source.playbackRate.value = 0.92 + Math.random() * 0.16
    const g = this.ctx.createGain()
    g.gain.value = volume
    const p = this.ctx.createStereoPanner()
    p.pan.value = pan
    source.connect(g).connect(p).connect(this.buses.ambience)
    source.start()
  }

  /** Interface sounds, synthesised. */
  effect(kind: 'click' | 'fly' | 'select') {
    const ctx = this.ctx
    const now = ctx.currentTime
    const out = ctx.createGain()
    out.connect(this.buses.effects)
    if (kind === 'fly') {
      // A breath of air that rises and falls over the camera's glide.
      const source = ctx.createBufferSource()
      source.buffer = pinkNoise(ctx, 2)
      const filter = ctx.createBiquadFilter()
      filter.type = 'bandpass'
      filter.Q.value = 1.4
      filter.frequency.setValueAtTime(300, now)
      filter.frequency.exponentialRampToValueAtTime(1800, now + 0.7)
      filter.frequency.exponentialRampToValueAtTime(400, now + 1.6)
      out.gain.setValueAtTime(0, now)
      out.gain.linearRampToValueAtTime(0.5, now + 0.6)
      out.gain.linearRampToValueAtTime(0, now + 1.7)
      source.connect(filter).connect(out)
      source.start(now)
      source.stop(now + 1.8)
      return
    }
    // A soft glassy tone: two sines a fifth apart for a selection, a single blip for a click.
    const notes = kind === 'select' ? [880, 1318.5] : [1400]
    notes.forEach((f, i) => {
      const osc = ctx.createOscillator()
      osc.type = 'sine'
      osc.frequency.value = f
      const g = ctx.createGain()
      const start = now + i * 0.07
      const length = kind === 'select' ? 0.6 : 0.09
      g.gain.setValueAtTime(0, start)
      g.gain.linearRampToValueAtTime(kind === 'select' ? 0.18 : 0.08, start + 0.01)
      g.gain.exponentialRampToValueAtTime(0.0001, start + length)
      osc.connect(g).connect(out)
      osc.start(start)
      osc.stop(start + length + 0.05)
    })
  }

  suspendForHiddenPage(hidden: boolean) {
    if (hidden) {
      this.music.pause()
      void this.ctx.suspend()
    } else if (useSound.getState().enabled) {
      void this.ctx.resume()
      void this.music.play().catch(() => undefined)
    }
  }
}

let engine: SoundEngine | null = null

/** The engine, created on first use; browsers only let audio start inside a user gesture. */
function ensureEngine(): SoundEngine {
  if (!engine) {
    engine = new SoundEngine()
    document.addEventListener('visibilitychange', () => engine?.suspendForHiddenPage(document.hidden))
    useSound.subscribe(({ levels, enabled }) => engine?.setLevels(levels, enabled))
  }
  return engine
}

/** Turn sound on or off; call from a click. */
export function setSoundEnabled(enabled: boolean) {
  useSound.setState({ enabled })
  ensureEngine().setLevels(useSound.getState().levels, enabled)
}

// A viewer who left sound on gets it back on their first gesture of the next visit.
if (typeof window !== 'undefined' && useSound.getState().enabled) {
  const resume = () => {
    window.removeEventListener('pointerdown', resume)
    window.removeEventListener('keydown', resume)
    setSoundEnabled(true)
  }
  window.addEventListener('pointerdown', resume)
  window.addEventListener('keydown', resume)
}

export function updateSound(input: SoundInputs, dt: number) {
  if (engine && useSound.getState().enabled) engine.update(input, dt)
}

export function playEffect(kind: 'click' | 'fly' | 'select') {
  if (engine && useSound.getState().enabled) engine.effect(kind)
}
