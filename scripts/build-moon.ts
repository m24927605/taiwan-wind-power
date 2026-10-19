// Builds public/textures/moon.webp: the lunar surface as an equirectangular albedo map (longitude 0
// at the centre, north up), from Solar System Scope's 2k moon texture (CC BY 4.0, after NASA LRO
// imagery). The sky shader drapes it over the moon's near side.

import sharp from 'sharp'
import { mkdir } from 'node:fs/promises'

const SOURCE = 'https://www.solarsystemscope.com/textures/download/2k_moon.jpg'

const res = await fetch(SOURCE, { headers: { 'user-agent': 'Mozilla/5.0' } })
if (!res.ok) throw new Error(`${SOURCE}: HTTP ${res.status}`)
await mkdir('public/textures', { recursive: true })
// The moon is about thirty pixels across on screen: 1024 x 512 is far more than it can show.
await sharp(Buffer.from(await res.arrayBuffer()))
  .resize(1024, 512)
  .greyscale()
  .webp({ quality: 85 })
  .toFile('public/textures/moon.webp')
console.log('public/textures/moon.webp')
