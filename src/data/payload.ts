import type { Buoy, Cyclone, TideGauge } from './cwa'
import type { OpenMeteo } from './openMeteo'
import type { Generation } from './taipower'

/**
 * What the weather service (worker/) returns: the Open-Meteo responses and whatever measurements
 * it holds: CWA's stations and tropical cyclones, and Taipower's output.
 */
export interface WeatherPayload extends OpenMeteo {
  buoys?: Buoy[]
  tides?: TideGauge[]
  cyclones?: Cyclone[]
  generation?: Generation
}
