export function Legend() {
  return (
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
  )
}
