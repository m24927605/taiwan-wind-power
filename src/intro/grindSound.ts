// Procedural foley for the intro: band-passed noise whose level follows the brush speed,
// and a soft bowl-like chime when the stone is finished. Created on the first user gesture.

export interface GrindSound {
  setIntensity(v: number): void
  chime(): void
  dispose(): void
}

export function createGrindSound(): GrindSound {
  const ctx = new AudioContext()
  const noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate)
  const samples = noise.getChannelData(0)
  for (let i = 0; i < samples.length; i++) samples[i] = Math.random() * 2 - 1

  const source = ctx.createBufferSource()
  source.buffer = noise
  source.loop = true
  const band = ctx.createBiquadFilter()
  band.type = 'bandpass'
  band.frequency.value = 1400
  band.Q.value = 0.8
  const low = ctx.createBiquadFilter()
  low.type = 'lowpass'
  low.frequency.value = 5200
  const gain = ctx.createGain()
  gain.gain.value = 0
  source.connect(band).connect(low).connect(gain).connect(ctx.destination)
  source.start()

  return {
    setIntensity(v) {
      const t = ctx.currentTime
      gain.gain.setTargetAtTime(Math.min(v, 1) * 0.16, t, 0.05)
      band.frequency.setTargetAtTime(900 + v * 1600, t, 0.08)
    },
    chime() {
      const t = ctx.currentTime
      for (const [freq, level] of [
        [523.25, 0.12],
        [784.0, 0.06],
        [1046.5, 0.03],
      ]) {
        const osc = ctx.createOscillator()
        osc.type = 'sine'
        osc.frequency.value = freq
        const env = ctx.createGain()
        env.gain.setValueAtTime(0, t)
        env.gain.linearRampToValueAtTime(level, t + 0.02)
        env.gain.exponentialRampToValueAtTime(0.0001, t + 3.2)
        osc.connect(env).connect(ctx.destination)
        osc.start(t)
        osc.stop(t + 3.3)
      }
    },
    dispose() {
      source.stop()
      void ctx.close()
    },
  }
}
