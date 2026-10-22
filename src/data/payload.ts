import type { Buoy, TideGauge } from './cwa'
import type { OpenMeteo } from './openMeteo'
import type { Generation } from './taipower'

/**
 * What the weather service (worker/) returns: the Open-Meteo responses and whatever measurements
 * it holds, CWA's stations and Taipower's output.
 */
export interface WeatherPayload extends OpenMeteo {
  buoys?: Buoy[]
  tides?: TideGauge[]
  generation?: Generation
}
