// Turns the artifact-mode Vite build in dist-artifact/ into a claude.ai artifact:
//   dist-artifact/artifact.html  the page: body content with the app's CSS and JS inlined, since the
//                                host wraps it in its own skeleton and admits stylesheets only from
//                                Google Fonts
//   dist-artifact/models/*.gltf  each .glb repackaged losslessly as a self-contained .gltf (the
//                                binary chunk becomes a base64 data URI), since the host serves only
//                                web types; the artifact-mode build requests these
// Everything else in dist-artifact/ (textures, data) is published beside the page as is.
//
// Run through `npm run build:artifact`, after `npm run snapshot:weather`.

import { readFile, readdir, rm, writeFile } from 'node:fs/promises'

const OUT = 'dist-artifact'
/** Artifact titles are names, not captions; the explanation goes in the publish description. */
const TITLE = '風與潮 Wind &amp; Tide'

const html = await readFile(`${OUT}/index.html`, 'utf8')
const fonts = html.match(/<link\s+href="(https:\/\/fonts\.googleapis\.com\/css2[^"]+)"/)?.[1]
const script = html.match(/<script type="module" crossorigin src="\.\/(assets\/[^"]+\.js)"><\/script>/)?.[1]
const style = html.match(/<link rel="stylesheet" crossorigin href="\.\/(assets\/[^"]+\.css)">/)?.[1]
if (!fonts || !script || !style) throw new Error(`${OUT}/index.html: unexpected shape`)

const css = await readFile(`${OUT}/${style}`, 'utf8')
// An inline script ends at the first "</script", wherever it appears.
const js = (await readFile(`${OUT}/${script}`, 'utf8')).replaceAll('</script', '<\\/script')
const page = `<title>${TITLE}</title>
<meta name="theme-color" content="#04070d">
<link rel="stylesheet" href="${fonts}">
<style>${css}</style>
<div id="root"></div>
<script type="module">${js}</script>
`
await writeFile(`${OUT}/artifact.html`, page)
console.log(`wrote ${OUT}/artifact.html (${(page.length / 1e6).toFixed(2)} MB)`)

/** GLB: 12-byte header, then a JSON chunk and an optional BIN chunk, each length + type + data. */
function glbToGltf(glb: Buffer): string {
  if (glb.readUInt32LE(0) !== 0x46546c67) throw new Error('not a GLB')
  const jsonLength = glb.readUInt32LE(12)
  const json = JSON.parse(glb.subarray(20, 20 + jsonLength).toString('utf8'))
  const binStart = 20 + jsonLength
  if (binStart < glb.length) {
    const binLength = glb.readUInt32LE(binStart)
    const bin = glb.subarray(binStart + 8, binStart + 8 + binLength)
    json.buffers[0].uri = `data:application/octet-stream;base64,${bin.toString('base64')}`
  }
  return JSON.stringify(json)
}

for (const file of await readdir(`${OUT}/models`)) {
  if (!file.endsWith('.glb')) continue
  const gltf = glbToGltf(await readFile(`${OUT}/models/${file}`))
  await writeFile(`${OUT}/models/${file.replace(/\.glb$/, '.gltf')}`, gltf)
  await rm(`${OUT}/models/${file}`)
  console.log(`repackaged ${file} as .gltf (${(gltf.length / 1e6).toFixed(2)} MB)`)
}
