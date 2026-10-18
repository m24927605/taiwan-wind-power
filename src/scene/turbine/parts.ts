import { WIND_FARMS } from '../../data/windfarms'
import { compass8 } from '../../ui/format'
import { farmDynamics } from './dynamics'
import { TURBINE, powerAt } from './spec'

/** Medium-speed drivetrain: two planetary stages between the main shaft and the generator. */
const GEAR_RATIO = 40

export interface Reading {
  label: string
  value: string
  unit: string
}

export interface Part {
  id: string
  name: string
  en: string
  /** Label anchor in model metres, matching the parts laid out in scripts/build-turbine.ts. */
  at: [number, number, number]
  /** Leader line height (px), staggered so neighbouring labels never overlap. */
  lift: number
  role: string
  facts: [label: string, value: string][]
  live: (farm: number) => Reading
}

const farmOutputMW = (farm: number) => (powerAt(farmDynamics.wind[farm]) * WIND_FARMS[farm].ratedMW) / TURBINE.ratedPowerMW

export const PARTS: Part[] = [
  {
    id: 'bearing',
    name: '主軸承',
    en: 'Main bearing',
    at: [0, 113.8, 4],
    lift: 34,
    role: '撐起轉子與主軸的重量，吸收風推力和彎矩，只讓扭矩往後傳進齒輪箱，避免齒輪承受不該承受的力。',
    facts: [
      ['型式', '雙列圓錐滾子軸承'],
      ['承載轉子', '約 250 公噸'],
      ['設計壽命', '25 年'],
    ],
    live: (farm) => ({
      label: '主軸轉速',
      value: farmDynamics.rpm[farm].toFixed(1),
      unit: 'rpm',
    }),
  },
  {
    id: 'gearbox',
    name: '齒輪箱',
    en: 'Gearbox',
    at: [0, 114.2, -2.6],
    lift: 92,
    role: '把轉子每分鐘約十轉的低速大扭矩，經兩級行星齒輪提升到發電機需要的轉速。中速型設計比高速型更耐用、體積更小。',
    facts: [
      ['增速比', `約 1:${GEAR_RATIO}`],
      ['額定輸入扭矩', '約 7.2 MN·m'],
      ['潤滑', '強制循環油冷'],
    ],
    live: (farm) => ({
      label: '輸出轉速',
      value: (farmDynamics.rpm[farm] * GEAR_RATIO).toFixed(0),
      unit: 'rpm',
    }),
  },
  {
    id: 'generator',
    name: '發電機',
    en: 'Generator',
    at: [0, 114.6, -8.6],
    lift: 54,
    role: '永磁同步發電機，轉子上的稀土磁鐵切割定子線圈，把機械能轉成電能。不需勵磁電流，低風速下效率仍高。',
    facts: [
      ['型式', '永磁同步'],
      ['額定功率', `${TURBINE.ratedPowerMW} MW`],
      ['效率', '約 97%'],
    ],
    live: (farm) => ({
      label: '目前出力',
      value: farmOutputMW(farm).toFixed(2),
      unit: 'MW',
    }),
  },
  {
    id: 'converter',
    name: '變流器',
    en: 'Converter',
    at: [3.3, 113.2, -12],
    lift: 120,
    role: '發電機輸出的交流電頻率隨轉速變動。全功率變流器先整流成直流，再逆變為穩定的 60 Hz 併入電網，並提供電壓與無效功率支援。',
    facts: [
      ['型式', '全功率背對背'],
      ['輸出頻率', '60 Hz'],
      ['升壓', '機艙變壓器 → 66 kV'],
    ],
    live: (farm) => {
      const rated = WIND_FARMS[farm].ratedMW
      return {
        label: '負載率',
        value: ((farmOutputMW(farm) / rated) * 100).toFixed(0),
        unit: '%',
      }
    },
  },
  {
    id: 'yaw',
    name: '偏航系統',
    en: 'Yaw drive',
    at: [0, 108.6, -2],
    lift: 14,
    role: '數組馬達和小齒輪咬合塔頂的大齒圈，依風向計的讀數轉動整個機艙，讓轉子持續正對來風。',
    facts: [
      ['驅動', '多組電動馬達'],
      ['偏航速度', '約 0.3°/s'],
      ['剎車', '液壓卡鉗'],
    ],
    live: (farm) => {
      const deg = ((((farmDynamics.windFrom[farm] * 180) / Math.PI) % 360) + 360) % 360
      return {
        label: '機艙朝向',
        value: `${compass8(deg)} ${deg.toFixed(0)}°`,
        unit: '',
      }
    },
  },
]
