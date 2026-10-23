// The cards laid over the scene: the left and right columns and the timeline. Labels drawn in the
// scene keep clear of them.

const PANELS = '.rail > *, .side > *, .timeline'

/** Where the cards are on screen, in CSS pixels; hidden ones are left out. */
export function panelRects(): DOMRect[] {
  return [...document.querySelectorAll(PANELS)].map((e) => e.getBoundingClientRect()).filter((r) => r.width > 0)
}
