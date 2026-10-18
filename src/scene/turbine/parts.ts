import { WIND_FARMS } from '../../data/windfarms'
import type { Lang } from '../../i18n'
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

interface PartText {
  name: string
  role: string
  facts: [label: string, value: string][]
}

export interface Part {
  id: string
  /** Label anchor in model metres, matching the parts laid out in scripts/build-turbine.ts. */
  at: [number, number, number]
  /** Leader line height (px), staggered so neighbouring labels never overlap. */
  lift: number
  text: Record<Lang, PartText>
  live: (farm: number, lang: Lang) => Reading
}

const farmOutputMW = (farm: number) => (powerAt(farmDynamics.wind[farm]) * WIND_FARMS[farm].ratedMW) / TURBINE.ratedPowerMW

export const PARTS: Part[] = [
  {
    id: 'bearing',
    at: [0, 113.8, 4],
    lift: 34,
    text: {
      zh: {
        name: '主軸承',
        role: '撐起轉子與主軸的重量，吸收風推力和彎矩，只讓扭矩往後傳進齒輪箱，避免齒輪承受不該承受的力。',
        facts: [
          ['型式', '雙列圓錐滾子軸承'],
          ['承載轉子', '約 250 公噸'],
          ['設計壽命', '25 年'],
        ],
      },
      en: {
        name: 'Main bearing',
        role: 'Carries the weight of the rotor and main shaft and absorbs the wind thrust and bending moments, so only torque passes back into the gearbox and the gears never take loads they were not built for.',
        facts: [
          ['Type', 'Double-row tapered roller'],
          ['Rotor carried', 'about 250 t'],
          ['Design life', '25 years'],
        ],
      },
    },
    live: (farm, lang) => ({
      label: lang === 'zh' ? '主軸轉速' : 'Shaft speed',
      value: farmDynamics.rpm[farm].toFixed(1),
      unit: 'rpm',
    }),
  },
  {
    id: 'gearbox',
    at: [0, 114.2, -2.6],
    lift: 92,
    text: {
      zh: {
        name: '齒輪箱',
        role: '把轉子每分鐘約十轉的低速大扭矩，經兩級行星齒輪提升到發電機需要的轉速。中速型設計比高速型更耐用、體積更小。',
        facts: [
          ['增速比', `約 1:${GEAR_RATIO}`],
          ['額定輸入扭矩', '約 7.2 MN·m'],
          ['潤滑', '強制循環油冷'],
        ],
      },
      en: {
        name: 'Gearbox',
        role: 'Steps the rotor’s ten or so turns a minute of slow, heavy torque up to the speed the generator needs, through two planetary stages. A medium-speed design outlasts a high-speed one and is more compact.',
        facts: [
          ['Ratio', `about 1:${GEAR_RATIO}`],
          ['Rated input torque', 'about 7.2 MN·m'],
          ['Lubrication', 'forced-circulation oil cooling'],
        ],
      },
    },
    live: (farm, lang) => ({
      label: lang === 'zh' ? '輸出轉速' : 'Output speed',
      value: (farmDynamics.rpm[farm] * GEAR_RATIO).toFixed(0),
      unit: 'rpm',
    }),
  },
  {
    id: 'generator',
    at: [0, 114.6, -8.6],
    lift: 54,
    text: {
      zh: {
        name: '發電機',
        role: '永磁同步發電機，轉子上的稀土磁鐵切割定子線圈，把機械能轉成電能。不需勵磁電流，低風速下效率仍高。',
        facts: [
          ['型式', '永磁同步'],
          ['額定功率', `${TURBINE.ratedPowerMW} MW`],
          ['效率', '約 97%'],
        ],
      },
      en: {
        name: 'Generator',
        role: 'A permanent-magnet synchronous machine: rare-earth magnets on the rotor sweep past the stator windings and turn mechanical energy into electricity. It needs no excitation current and stays efficient in light winds.',
        facts: [
          ['Type', 'Permanent-magnet synchronous'],
          ['Rated power', `${TURBINE.ratedPowerMW} MW`],
          ['Efficiency', 'about 97%'],
        ],
      },
    },
    live: (farm, lang) => ({
      label: lang === 'zh' ? '目前出力' : 'Output now',
      value: farmOutputMW(farm).toFixed(2),
      unit: 'MW',
    }),
  },
  {
    id: 'converter',
    at: [3.3, 113.2, -12],
    lift: 120,
    text: {
      zh: {
        name: '變流器',
        role: '發電機輸出的交流電頻率隨轉速變動。全功率變流器先整流成直流，再逆變為穩定的 60 Hz 併入電網，並提供電壓與無效功率支援。',
        facts: [
          ['型式', '全功率背對背'],
          ['輸出頻率', '60 Hz'],
          ['升壓', '機艙變壓器 → 66 kV'],
        ],
      },
      en: {
        name: 'Converter',
        role: 'The generator’s frequency follows the rotor speed. A full-power converter rectifies it to DC, then inverts it to a steady 60 Hz for the grid, and supports voltage and reactive power.',
        facts: [
          ['Type', 'Full-power back-to-back'],
          ['Output frequency', '60 Hz'],
          ['Step-up', 'nacelle transformer → 66 kV'],
        ],
      },
    },
    live: (farm, lang) => {
      const rated = WIND_FARMS[farm].ratedMW
      return {
        label: lang === 'zh' ? '負載率' : 'Load',
        value: ((farmOutputMW(farm) / rated) * 100).toFixed(0),
        unit: '%',
      }
    },
  },
  {
    id: 'yaw',
    at: [0, 108.6, -2],
    lift: 14,
    text: {
      zh: {
        name: '偏航系統',
        role: '數組馬達和小齒輪咬合塔頂的大齒圈，依風向計的讀數轉動整個機艙，讓轉子持續正對來風。',
        facts: [
          ['驅動', '多組電動馬達'],
          ['偏航速度', '約 0.3°/s'],
          ['剎車', '液壓卡鉗'],
        ],
      },
      en: {
        name: 'Yaw drive',
        role: 'Several motors drive pinions round the large toothed ring at the tower top, turning the whole nacelle to the wind vane’s reading so the rotor keeps facing the wind.',
        facts: [
          ['Drive', 'multiple electric motors'],
          ['Yaw rate', 'about 0.3°/s'],
          ['Brakes', 'hydraulic calipers'],
        ],
      },
    },
    live: (farm, lang) => {
      const deg = ((((farmDynamics.windFrom[farm] * 180) / Math.PI) % 360) + 360) % 360
      return {
        label: lang === 'zh' ? '機艙朝向' : 'Nacelle heading',
        value: `${compass8(deg, lang)} ${deg.toFixed(0)}°`,
        unit: '',
      }
    },
  },
]
