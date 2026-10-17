import { useEffect } from 'react'
import { loadElevation } from './data/elevation'
import { fetchWeather } from './data/weather'
import { Scene } from './scene/Scene'
import { useStore } from './state'

export default function App() {
  useEffect(() => {
    const fail = (e: unknown) => useStore.setState({ error: e instanceof Error ? e.message : String(e) })
    loadElevation().then((elevation) => useStore.setState({ elevation }), fail)
    fetchWeather().then((weather) => useStore.setState({ weather }), fail)
  }, [])

  return (
    <main className="app">
      <Scene />
    </main>
  )
}
