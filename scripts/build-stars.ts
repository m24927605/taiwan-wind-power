// Builds public/data/stars.json from the Yale Bright Star Catalogue, 5th revised edition (Hoffleit &
// Warren 1991, CDS catalogue V/50): every star down to magnitude 6, as one flat array of
// [right ascension rad, declination rad, V magnitude, B-V colour] records, J2000. Precession since J2000
// moves the sky by about a third of a degree, which the scene does not resolve.

import { gunzipSync } from 'node:zlib'
import { mkdir, writeFile } from 'node:fs/promises'

const SOURCE = 'https://cdsarc.cds.unistra.fr/ftp/V/50/catalog.gz'
const FAINTEST = 6

const res = await fetch(SOURCE)
if (!res.ok) throw new Error(`${SOURCE}: HTTP ${res.status}`)
const lines = gunzipSync(Buffer.from(await res.arrayBuffer())).toString('latin1').split('\n')

// Fixed-width columns from the catalogue's ReadMe (1-based, inclusive).
const field = (line: string, from: number, to: number) => line.slice(from - 1, to).trim()
const records: number[] = []
for (const line of lines) {
  const ra = field(line, 76, 83)
  const vmag = Number(field(line, 103, 107))
  // A few entries are novae or non-stellar objects with no J2000 position.
  if (!ra || !field(line, 103, 107) || vmag > FAINTEST) continue
  const raRad = ((Number(field(line, 76, 77)) + Number(field(line, 78, 79)) / 60 + Number(field(line, 80, 83)) / 3600) * Math.PI) / 12
  const sign = field(line, 84, 84) === '-' ? -1 : 1
  const decDeg = sign * (Number(field(line, 85, 86)) + Number(field(line, 87, 88)) / 60 + Number(field(line, 89, 90)) / 3600)
  const bv = Number(field(line, 110, 114) || '0.6')
  records.push(+raRad.toFixed(5), +((decDeg * Math.PI) / 180).toFixed(5), vmag, bv)
}

await mkdir('public/data', { recursive: true })
await writeFile('public/data/stars.json', JSON.stringify(records))
console.log(`public/data/stars.json: ${records.length / 4} stars`)
