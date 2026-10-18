export function Legend() {
  return (
    <>
      <div className="legend" aria-label="圖例">
        <div className="legend__row">
          <span className="legend__ramp" />
          <span>洋流 0 – 1.5 m/s</span>
        </div>
        <div className="legend__row">
          <span className="legend__blink" />
          <span>風機航空警示燈</span>
        </div>
      </div>
      <a className="attribution" href="https://s2maps.eu" target="_blank" rel="noreferrer">
        <span className="attribution__long">
          衛星影像 Sentinel-2 cloudless 2024 © EOX IT Services GmbH（含 Copernicus Sentinel 資料）· CC BY-NC-SA 4.0
        </span>
        <span className="attribution__short">影像 © EOX Sentinel-2 cloudless · CC BY-NC-SA 4.0</span>
      </a>
    </>
  )
}
