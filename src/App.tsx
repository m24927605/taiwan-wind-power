import { useEffect } from 'react'
import { loadElevation } from './data/elevation'
import { fetchWeather, type Weather } from './data/weather'
import { Scene } from './scene/Scene'
import { useStore } from './state'
import { EngineeringPanel } from './ui/EngineeringPanel'
import { Metrics, Title } from './ui/Hud'
import { Attribution, Legend } from './ui/Legend'
import { Timeline } from './ui/Timeline'
import { OverviewReturn, ToolHint, Toolbar } from './ui/Toolbar'
import { TurbinePanel } from './ui/TurbinePanel'
import './ui/ui.css'

/** The weather service stores new buoy observations every ten minutes; an open page follows. */
const WEATHER_REFRESH_MS = 10 * 60 * 1000

export default function App() {
  useEffect(() => {
    const fail = (e: unknown) => useStore.setState({ error: e instanceof Error ? e.message : String(e) })
    loadElevation().then((elevation) => useStore.setState({ elevation }), fail)
    fetchWeather().then((weather) => useStore.setState({ weather }), fail)
    // Only newer data replaces what is shown; a failed refresh keeps it.
    const refresh = setInterval(() => {
      if (document.hidden) return
      fetchWeather().then((weather) => {
        const shown = useStore.getState().weather
        const observedAt = (w: Weather) => w.observed.waves?.at ?? 0
        const newer = !shown || weather.fetchedAt > shown.fetchedAt || (weather.fetchedAt === shown.fetchedAt && observedAt(weather) > observedAt(shown))
        if (newer) useStore.setState({ weather })
      }, () => {})
    }, WEATHER_REFRESH_MS)
    return () => clearInterval(refresh)
  }, [])

  return (
    <main className="app">
      <Scene />
      <div className="ui">
        {/* The left-hand column: the title, and the tools below it. */}
        <div className="rail">
          <Title />
          <Toolbar />
        </div>
        {/* The right-hand column: the metrics, the turbine panel below them, and the legend. */}
        <div className="side">
          <Metrics />
          <TurbinePanel />
          <Legend />
        </div>
        <div className="top-center">
          <OverviewReturn />
          <ToolHint />
        </div>
        <EngineeringPanel />
        <Attribution />
        <Timeline />
      </div>
    </main>
  )
}
