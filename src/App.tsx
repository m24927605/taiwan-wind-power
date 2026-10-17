import { useEffect } from 'react'
import { loadElevation } from './data/elevation'
import { fetchWeather } from './data/weather'
import { Scene } from './scene/Scene'
import { useStore } from './state'
import { EngineeringPanel } from './ui/EngineeringPanel'
import { Metrics, Title } from './ui/Hud'
import { Legend } from './ui/Legend'
import { Timeline } from './ui/Timeline'
import { ToolHint, Toolbar } from './ui/Toolbar'
import { TurbinePanel } from './ui/TurbinePanel'
import './ui/ui.css'

export default function App() {
  useEffect(() => {
    const fail = (e: unknown) => useStore.setState({ error: e instanceof Error ? e.message : String(e) })
    loadElevation().then((elevation) => useStore.setState({ elevation }), fail)
    fetchWeather().then((weather) => useStore.setState({ weather }), fail)
  }, [])

  return (
    <main className="app">
      <Scene />
      <div className="ui">
        <Title />
        <Metrics />
        <Toolbar />
        <ToolHint />
        <EngineeringPanel />
        <TurbinePanel />
        <Legend />
        <Timeline />
      </div>
    </main>
  )
}
