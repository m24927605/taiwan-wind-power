import { create } from 'zustand'

// Interface language: Traditional Chinese (the source) and English. Every message lives here; the
// English table is checked against the Chinese one, so a missing translation fails the build.

export type Lang = 'zh' | 'en'

const STORAGE_KEY = 'wind-tide:lang'

const zh = {
  locale: 'zh-TW',
  htmlLang: 'zh-Hant-TW',
  documentTitle: '風與潮 Wind & Tide — 台灣海峽即時數位孿生',
  switchTo: 'EN',
  switchLabel: 'Switch to English',

  subtitle: '台灣海峽 · 即時數位孿生',
  replay: '時光回放',
  snapshot: (when: string) => `資料快照 · ${when}`,
  live: 'LIVE · 即時資料',
  loadFailed: (error: string) => `即時資料載入失敗：${error}`,
  loading: '正在讀取 Open-Meteo 即時資料…',
  outputLabel: '海峽離岸風電 · 估算即時出力',
  capacityCaption: (factor: string, capacity: string, count: number) => `容量因數 ${factor}% · 裝置容量 ${capacity} MW · ${count} 座風機`,
  hubWind: '輪轂高度風速',
  windFrom: (direction: string) => `${direction}風`,
  peakCurrent: '黑潮最大流速',
  updated: '更新',
  snapshotTag: '快照',
  measuredOutput: (mw: string, when: string) => `台電實測 ${mw} MW · ${when}`,
  farmOutput: (measured: string, modelled: string, when: string) => `全場：台電實測 ${measured} MW · 模擬 ${modelled} MW · ${when}`,
  tide: '風場海域潮位',
  tideRising: '漲潮',
  tideFalling: '退潮',
  tideSlack: '平潮',
  sourceModel: '模式預報',
  sourceWaves: '實測浪高',
  sourceWind: '實測風速',
  sourceTide: '實測潮位',
  sourceOutput: '實測發電',
  taipower: '台電',
  stations: (n: number) => `氣象署 ${n} 站`,
  notMeasured: '未取得 · 使用模式值',
  staleFor: (hours: number) => `· 已 ${hours} 小時未更新`,

  timeline: '時間軸',
  pause: '暫停',
  play: '縮時播放',
  night: '夜',
  day: '日',
  now: '現在',
  forecast: '預報 →',
  sceneTime: '場景時間',

  tools: '工具',
  inspect: '檢視',
  inspectTitle: '檢視（點選風機）',
  measure: '量測',
  measureTitle: '量測距離 (M)',
  engineering: '工程',
  engineeringTitle: '工程師模式 (E)',
  overview: '總覽',
  overviewTitle: '重設視角 (R)',
  sound: '聲音',
  soundTitle: '聲音與配樂',
  backToOverview: '回到台灣全景',
  measureSecond: '點選第二個點（可吸附到風機）',
  measureFirst: '量測模式：點選海面、陸地或風機作為起點',
  bearing: '方位',

  turbineInfo: '風機資訊',
  close: '關閉',
  rated: (mw: number) => `額定 ${mw} MW`,
  stateIdle: '待機 · 低於切入風速',
  stateCutOut: (restart: number) => `停機保護 · 風速降到 ${restart} m/s 以下才重啟`,
  stateDerated: '高風速降載運轉',
  stateRated: '額定運轉',
  statePartial: '部分負載運轉',
  hubWindShort: '輪轂風速',
  windDirection: '風向',
  rotorSpeed: '轉速',
  outputNow: '即時出力',
  powerCurve: '功率曲線',
  powerCurveTitle: '功率曲線 · 風速 m/s',
  turbineFoot: '機艙剖面：主軸承 → 齒輪箱 → 發電機。風機位置為依公開資料推估的近似陣列。',
  partFoot: '規格為 8 MW 級離岸風機典型值',
  farmLabel: (turbines: number, mw: number) => `${turbines} 座 · ${mw} MW`,
  typhoon: (name: string | null, number: string, hpa: number, wind: number | null) =>
    `${name === null ? `熱帶性低氣壓 TD${number}` : `颱風 ${name}`} · ${hpa} hPa${wind === null ? '' : ` · 最大風速 ${wind} m/s`}`,

  legend: '圖例',
  legendCurrent: '洋流 0 – 1.5 m/s',
  legendLights: '風機航空警示燈',
  attributionLong: '衛星影像 Sentinel-2 cloudless 2024 © EOX IT Services GmbH（含 Copernicus Sentinel 資料）· CC BY-NC-SA 4.0',
  attributionShort: '影像 © EOX Sentinel-2 cloudless · CC BY-NC-SA 4.0',

  engineeringMode: '工程師模式 · E',
  lodTitle: '風機 LOD 分桶（每 3 幀以視錐 + 距離重排）',
  lod0: 'LOD0 完整網格',
  lod1: 'LOD1 簡化網格',
  lod2: 'LOD2 光點 / 剔除',
  pipeline: [
    ['大氣', 'Hillaire 2020 穿透率／多重散射／天空 LUT · 逐像素空氣透視'],
    ['雲', '向日葵 9 號紅外線與可見光雲圖定位 · 體積雲光線步進 · 雙邊升採樣'],
    ['海面', '雙峰頻譜 FFT · 三層位移 · Jacobian 白浪與殘留泡沫'],
    ['風機', '程序建模 → AO 烘焙 → meshopt LOD → 量化 + EXT_meshopt GLB'],
    ['風場', '513 座 · 2 級 LOD instancing · 偏航與轉子在 vertex shader 計算'],
    ['資料', 'Open-Meteo Marine + Forecast · NASA GIBS 向日葵 9 號 · 瀏覽器快取 30 分鐘'],
  ] as [string, string][],

  compass8: ['北', '東北', '東', '東南', '南', '西南', '西', '西北'],
  compass16: ['北', '北北東', '東北', '東北東', '東', '東南東', '東南', '南南東', '南', '南南西', '西南', '西南西', '西', '西北西', '西北', '北北西'],

  mixer: '聲音',
  soundOn: '開啟聲音',
  soundOff: '關閉聲音',
  master: '主音量',
  music: '配樂',
  ambience: '環境音',
  noise: '白噪音',
  effects: '音效',
  soundNote: '環境音與風聲隨即時風速、浪高、風機轉速與視角變化。',
  credits: '音源',
  creditMusic: '配樂 “Ocean Dream” Windpearl · CC BY 3.0（Jamendo）',
  creditSounds: '海浪、海風、海鷗、風機錄音來自 Freesound（rucisko、Potapooo、steaq、Snapper4298、eguaus）· CC0',
}

type Messages = { [K in keyof typeof zh]: (typeof zh)[K] extends (...args: infer A) => string ? (...args: A) => string : (typeof zh)[K] }

const en: Messages = {
  locale: 'en-GB',
  htmlLang: 'en',
  documentTitle: 'Wind & Tide — a live digital twin of the Taiwan Strait',
  switchTo: '中',
  switchLabel: '切換為繁體中文',

  subtitle: 'Taiwan Strait · live digital twin',
  replay: 'Replay',
  snapshot: (when: string) => `Data snapshot · ${when}`,
  live: 'LIVE · real-time data',
  loadFailed: (error: string) => `Live data failed to load: ${error}`,
  loading: 'Loading live data from Open-Meteo…',
  outputLabel: 'Strait offshore wind · estimated output now',
  capacityCaption: (factor: string, capacity: string, count: number) => `Capacity factor ${factor}% · installed ${capacity} MW · ${count} turbines`,
  hubWind: 'Hub-height wind',
  windFrom: (direction: string) => `from ${direction}`,
  peakCurrent: 'Kuroshio peak current',
  updated: 'updated',
  snapshotTag: 'snapshot',
  measuredOutput: (mw: string, when: string) => `Taipower measured ${mw} MW · ${when}`,
  farmOutput: (measured: string, modelled: string, when: string) => `Whole farm: Taipower ${measured} MW · modelled ${modelled} MW · ${when}`,
  tide: 'Tide at the farms',
  tideRising: 'rising',
  tideFalling: 'falling',
  tideSlack: 'slack',
  sourceModel: 'Forecast',
  sourceWaves: 'Measured waves',
  sourceWind: 'Measured wind',
  sourceTide: 'Measured tide',
  sourceOutput: 'Measured output',
  taipower: 'Taipower',
  stations: (n: number) => `CWA, ${n} stations`,
  notMeasured: 'unavailable · model values',
  staleFor: (hours: number) => `· ${hours} h old`,

  timeline: 'Timeline',
  pause: 'Pause',
  play: 'Play time-lapse',
  night: 'Night',
  day: 'Day',
  now: 'Now',
  forecast: 'Forecast →',
  sceneTime: 'Scene time',

  tools: 'Tools',
  inspect: 'Inspect',
  inspectTitle: 'Inspect (pick a turbine)',
  measure: 'Measure',
  measureTitle: 'Measure distance (M)',
  engineering: 'Engineer',
  engineeringTitle: 'Engineering mode (E)',
  overview: 'Overview',
  overviewTitle: 'Reset view (R)',
  sound: 'Sound',
  soundTitle: 'Sound and music',
  backToOverview: 'Back to the island',
  measureSecond: 'Pick a second point (snaps to turbines)',
  measureFirst: 'Measure: pick the sea, the land or a turbine to start',
  bearing: 'Bearing',

  turbineInfo: 'Turbine details',
  close: 'Close',
  rated: (mw: number) => `rated ${mw} MW`,
  stateIdle: 'Idle · below cut-in wind',
  stateCutOut: (restart: number) => `Shut down · restarts below ${restart} m/s`,
  stateDerated: 'Running derated in high wind',
  stateRated: 'Running at rated power',
  statePartial: 'Running at part load',
  hubWindShort: 'Hub wind',
  windDirection: 'Wind from',
  rotorSpeed: 'Rotor',
  outputNow: 'Output now',
  powerCurve: 'Power curve',
  powerCurveTitle: 'Power curve · wind m/s',
  turbineFoot: 'Nacelle cutaway: main bearing → gearbox → generator. Turbine positions are an approximate array from public data.',
  partFoot: 'Typical values for an 8 MW-class offshore turbine',
  farmLabel: (turbines: number, mw: number) => `${turbines} turbines · ${mw} MW`,
  typhoon: (name: string | null, number: string, hpa: number, wind: number | null) =>
    `${name === null ? `Tropical depression TD${number}` : `Typhoon ${name}`} · ${hpa} hPa${wind === null ? '' : ` · max wind ${wind} m/s`}`,

  legend: 'Legend',
  legendCurrent: 'Current 0 – 1.5 m/s',
  legendLights: 'Turbine aviation lights',
  attributionLong: 'Imagery Sentinel-2 cloudless 2024 © EOX IT Services GmbH (contains modified Copernicus Sentinel data) · CC BY-NC-SA 4.0',
  attributionShort: 'Imagery © EOX Sentinel-2 cloudless · CC BY-NC-SA 4.0',

  engineeringMode: 'Engineering mode · E',
  lodTitle: 'Turbine LOD buckets (re-sorted by frustum and distance every 3 frames)',
  lod0: 'LOD0 full mesh',
  lod1: 'LOD1 simplified',
  lod2: 'LOD2 point / culled',
  pipeline: [
    ['Sky', 'Hillaire 2020 transmittance / multi-scattering / sky LUTs · per-pixel aerial perspective'],
    ['Clouds', 'Placed by Himawari-9 infrared and visible imagery · volumetric ray march · bilateral upsample'],
    ['Sea', 'Two-peak spectrum FFT · three displaced cascades · Jacobian whitecaps and foam trails'],
    ['Turbine', 'Procedural model → baked AO → meshopt LOD → quantized + EXT_meshopt GLB'],
    ['Farms', '513 turbines · 2 LOD levels instanced · yaw and rotor in the vertex shader'],
    ['Data', 'Open-Meteo Marine + Forecast · Himawari-9 via NASA GIBS · cached in the browser for 30 minutes'],
  ],

  compass8: ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'],
  compass16: ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'],

  mixer: 'Sound',
  soundOn: 'Turn sound on',
  soundOff: 'Turn sound off',
  master: 'Master',
  music: 'Music',
  ambience: 'Ambience',
  noise: 'White noise',
  effects: 'Effects',
  soundNote: 'Ambience and wind follow the live wind, sea state, rotor speed and your viewpoint.',
  credits: 'Credits',
  creditMusic: 'Music “Ocean Dream” by Windpearl · CC BY 3.0 (Jamendo)',
  creditSounds: 'Waves, sea wind, gulls and turbine recordings from Freesound (rucisko, Potapooo, steaq, Snapper4298, eguaus) · CC0',
}

export const MESSAGES: Record<Lang, Messages> = { zh, en }

function initialLang(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved === 'zh' || saved === 'en') return saved
  } catch {
    // Storage blocked: fall back to the browser's language.
  }
  return typeof navigator !== 'undefined' && navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

export const useLang = create<{ lang: Lang }>(() => ({ lang: initialLang() }))

function applyDocument(lang: Lang) {
  document.documentElement.lang = MESSAGES[lang].htmlLang
  document.title = MESSAGES[lang].documentTitle
}
applyDocument(useLang.getState().lang)

export function setLang(lang: Lang) {
  useLang.setState({ lang })
  applyDocument(lang)
  try {
    localStorage.setItem(STORAGE_KEY, lang)
  } catch {
    // The choice still holds for this visit.
  }
}

/** The messages for the current language; re-renders the caller when it changes. */
export function useT(): Messages & { lang: Lang } {
  const lang = useLang((s) => s.lang)
  return { ...MESSAGES[lang], lang }
}
