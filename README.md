# 風與潮 Wind & Tide

**English** · [繁體中文](README.zh-TW.md)

A live digital twin of the Taiwan Strait, built with Three.js and React Three Fiber.

It opens straight onto the strait: Sentinel-2 imagery draped over the island, an FFT ocean raised by today's wave forecast,
the Kuroshio current streaming past the east coast, and 513 offshore turbines turning to the
wind that is blowing over the strait right now.

**Open it live: https://m24927605.github.io/taiwan-wind-power/app/**

## Film

[![Wind & Tide: a two-minute film recorded from the live site](docs/teaser.webp)](https://m24927605.github.io/taiwan-wind-power/)

Watch the two-minute film: **[English](https://m24927605.github.io/taiwan-wind-power/#en)** ·
**[繁體中文](https://m24927605.github.io/taiwan-wind-power/)**

Every shot is the site's own real-time renderer at real dates and times from the forecast
window: ripples at dawn, a time-lapse sunset, the moon setting into the strait at its true phase.
Frames were captured on a virtual clock, so the film runs at 60 fps whatever the machine.
Narration by Gemini TTS.

```bash
npm install
npm run dev            # http://localhost:5199
npm run build
npm test               # unit tests (Vitest); CI runs them before every deploy
```

Every push to `main` builds the app and publishes it to the `gh-pages` branch under `app/`
(`.github/workflows/pages.yml`); the film page sits at the root of that branch.

The weather comes through a small Cloudflare Worker (`worker/`). On a schedule it fetches
Open-Meteo every hour, and CWA's buoys and tide gauges in turn between, into KV (each ten-minute
run does one share, which keeps it inside the free plan's CPU budget), and every visitor is served
that stored copy, so upstream calls stay fixed whatever the traffic and a failed fetch leaves the
last good copy in place; the CWA key lives only there. The app refreshes every ten minutes while
open. It reads the Worker's origin from `VITE_WEATHER_SERVICE` (`.env.production`); without it, or
when it is out of reach, the app fetches Open-Meteo itself and shows the model uncorrected. The metrics
panel lists each source with the time of its newest data, in red once an update is overdue (the
model after two hours, measurements after three) or when no measurements came.

```bash
npx wrangler secret put CWA_API_KEY --config worker/wrangler.jsonc   # once; a CWA open data key
npx wrangler deploy --config worker/wrangler.jsonc
```

For `wrangler dev`, put the key in `worker/.dev.vars` (`CWA_API_KEY=...`, git-ignored).

## What is live

| Layer | Source | Notes |
| --- | --- | --- |
| Bathymetry | AWS Terrain Tiles (Terrarium, z9) | Baked by `scripts/build-elevation.ts` into a 1024² Terrarium-encoded PNG (1.5 MB, lossless metres) |
| Land surface | AWS Terrain Tiles (Terrarium, z11) | Baked by `scripts/build-terrain.ts` into a simplified 1.13M-triangle GLB (3.1 MB), true scale |
| Land imagery | Sentinel-2 cloudless 2024, EOX | Baked by `scripts/build-imagery.ts` into a 4096² WebP over the domain (1.2 MB), a 4096 × 8192 WebP over the island (4.2 MB, desktop only) and a 4096² normal map |
| Ocean currents | Open-Meteo Marine API | 24 × 14 grid over the domain (about 36 km apart), hourly, yesterday through three days ahead |
| Sea state | Open-Meteo Marine API | Wind sea and swell (height, period, direction) on the same grid, sampled where the camera is; the two peaks of the wave spectrum |
| Measured waves | Central Weather Administration open data (O-B0075-001, O-B0076-001) | Hourly significant wave height at the moored buoys in the domain (24 in October 2026), the last 24 hours. Each measurement scales the modelled heights toward itself within about 30 km and 6 hours (log ratio, at most ×2 either way), so near the buoys the sea is the measured one and far into the forecast the model stands |
| Sea level | Open-Meteo Marine API (MeteoFrance SMOC, about 8 km) | Sea level against mean sea level, tides included, on the same grid. The whole sea surface rises and falls with it at the camera, so the waterline moves on the turbine foundations; the metrics panel reads it at the farms. Land is lifted 4 m above mean sea level, beyond the strait's highest tides |
| Tidal flats | Derived by `scripts/build-tidal-flats.ts` from Copernicus Sentinel-2 L2A (AWS Earth Search), CWA tide gauges and Copernicus DEM GLO-30 | The Changhua and Yunlin flats (93 km²), which the sea uncovers below their elevation. No open dataset gives their elevation (Copernicus DEM flattens them into the sea; GTF30 and Murray's maps give extent only), so it is derived as Australia's NIDEM is: in each of the 128 clear Sentinel-2 mornings since 2023, NDWI tells which 40 m pixels were wet, and the tide then, predicted from constituents fitted to the Taichung, Mailiao and Bozailiao gauges' last 30 days, tells how high the water stood; a pixel's elevation is the tide that best splits its dry looks from its wet ones. Kept are the flats the open sea reaches without crossing land, where Copernicus DEM has sea, which leaves out the fish ponds behind the seawalls. A 63 KB PNG, about 40 m a texel. Sentinel-2 passes at about 10:40, when the tide here never falls below about -1.4 m, so the flats that only dry at the lowest spring tides (to about -2.3 m) are not in it |
| Measured tide | CWA open data (O-B0075-001) | Hourly sea level at the tide gauges in the domain (40 reporting in October 2026), the last 30 hours. Each gauge reads against its own datum, so its mean offset from the model over the hours both cover is taken out; the rest (the timing and range of the tide where the model is wrong, and surges) pulls the modelled sea level within about 30 km and 6 hours |
| Hub-height wind | Open-Meteo Forecast API, 100 m | One point per wind farm; drives yaw, rotor rpm, output and cloud drift, and the whitecaps, blended between farms by inverse squared distance from the camera |
| Tropical cyclones | CWA open data (W-C0034-005) | Every active tropical cyclone: its hourly track so far and CWA's forecast, about four days ahead. Drawn above the clouds once the eye is high: the track, the forecast dashed with the circles its centre falls within at 70 % probability, and, at the scene time, the centre with its gale (15 m/s) and storm (25 m/s) radii and a label with pressure and maximum wind |
| Measured output | Taipower open data (data.gov.tw 8931) | Net output of every generating unit every ten minutes; each farm sums its offshore units (Formosa 2 is 海能風, Greater Changhua 1 & 2a is 沃一風 and 沃二風, and so on). The farms run as it measured: as many turbines turn as the output calls for, the rest stand still, and the total matches it. That holds within 45 minutes of the reading, where the metrics panel and the turbine panel also give the reading and the model's own figure, and fades back to the model by three hours either side, Taipower publishing no history or forecast. It carries no CORS headers, so the Worker fetches it |
| Measured wind | CWA open data (O-B0075-001) and Open-Meteo 10 m wind | The buoys within 80 km of a farm that measure wind (six in October 2026). Each measurement, taken from the anemometer (about 3.5 m up; CWA does not publish the height) to 10 m by the log law, gives a ratio to the model's 10 m wind at the buoy, and the farms' hub-height wind takes the blended ratio within about 40 km and 6 hours. The model keeps more weight than against the waves, since anemometers ride among breaking seas |
| Clouds | Himawari-9 AHI via NASA GIBS | The only clouds: hourly scans over 113.5–131.5 E, 16.5–33 N (everything the camera can see), about 30 minutes behind real time, loaded as scene time needs them. Band 13 infrared (brightness temperature, lapse-corrected over land) and, by day, band 3 visible place the cumulus, set its height and lay the cirrus and the overcast of deep convection, such as a typhoon's. Hours with no scan have no clouds |
| Sun, moon and sky | Solar and lunar positions | Day, dusk and moonlit night (at the real phase) follow the scene clock |
| Stars | Yale Bright Star Catalogue (BSC5, CDS V/50) | Baked by `scripts/build-stars.ts`: the 5,080 stars down to magnitude 6, turned to local sidereal time over Taiwan |
| Moon surface | Solar System Scope 2k moon (after NASA LRO) | Baked by `scripts/build-moon.ts` into a 1024 × 512 albedo map, draped on the moon's near side |

The timeline scrubs across the full 96-hour window, and the play button runs it as a time-lapse.
Turbine output comes from a cubic power curve (cut-in 3 m/s, rated 12 m/s), scaled to each
farm's rating. High wind is met as each farm's machine is set up: the Vestas V174 farms ease
output down from 25 m/s to a stop at 31 m/s (Vestas' high-wind operation), and every other farm
shuts down at 25 m/s, Siemens Gamesa's ride-through being an option Taipower's output shows these
farms without. All restart only once the wind is back below 22 m/s. The farms' own controller
settings are not public. Farm counts and ratings follow public project data. Turbine
coordinates are an approximate array layout, and the UI says so.

## Interaction

- Click a turbine to fly to it. The nacelle is cut open with an animated clipping plane, and its
  main bearing, gearbox, generator, converter and yaw drive are labelled. Click a label for a
  card that explains the part with a live reading (shaft rpm, gearbox output speed, generator
  output, converter load, nacelle heading). The side panel shows live wind, rpm, output and the
  power curve.
- Wind farms are outlined along their array headings and labelled with turbine count and
  capacity, so they read from the overview where turbines are specks. Labels hang off each farm's
  western corner into the open strait; when they collide, larger farms win. Click a label or anywhere
  inside an outline to fly over that farm; once there, clicks pick individual turbines again.
  Outlines fade out as the camera moves in among the turbines.
- Once the camera leaves the island-wide view, a "回到台灣全景" pill at the top of the screen
  flies back to it. The island-wide view is north up, from the south with a 10° tilt, as far out
  as the domain allows for the screen's shape.
- Everything on screen is mapped data: the domain (116.6–125 E, 21.4–25.8 N) is wide enough for
  a north-up view of the whole island on a wide screen, and no pose may show ground outside it
  (`viewInsideDomain` in `scene/camera.ts`); a drag, pinch or wheel that would snaps back. Below
  3 km the view may run to the hazy horizon while the camera stays 30 km inside. Scripted flights
  orbit their target with the tilt following the zoom, so they stay inside too.
- `M` measures great-circle distance and bearing. Points snap to turbines.
- `E` toggles engineering mode, a diagnostic render plus live renderer statistics. Development
  builds only, as is its toolbar button.
- `Space` plays or pauses the time-lapse, `R` returns to the overview, and `Esc` clears the
  selection.

## Architecture

```
scripts/            offline asset pipeline (Node, run once)
  tiles.ts            Web Mercator tile mosaic -> resampled onto the scene grid
  build-elevation.ts  Terrarium tiles -> Terrarium-encoded PNG elevation grid (bathymetry)
  build-terrain.ts    z11 Terrarium -> land mesh -> meshopt simplify -> quantized GLB
  build-imagery.ts    Sentinel-2 cloudless + z11 normals -> WebP textures
  build-tidal-flats.ts Sentinel-2 scenes + tide gauges -> intertidal elevation PNG (needs CWA_API_KEY)
  harmonics.ts        tidal harmonic analysis with nodal corrections
  build-turbine.ts    procedural turbine -> meshopt LOD -> quantized, meshopt-compressed GLB
  snapshot-weather.ts Open-Meteo responses a week ahead -> bundled fallback for sandboxed hosts
  build-artifact.ts   artifact-mode build -> one inlined page + .gltf models for claude.ai
src/
  geo/              domain projection (lon/lat <-> km), solar position, geodesic
  data/             elevation loader, Open-Meteo requests and weather client, wind farm layout
  scene/            R3F scene: sky, terrain, Kuroshio GPGPU, wind farms, hero turbine
    ocean/            FFT wave simulation and ocean shading
    camera.ts         imperative camera API (fly to turbine, farm, overview)
    Layer.tsx         error + Suspense boundary per asset-loading part of the scene
    farmAreas.ts      farm outlines derived from the layout, and analytic farm picking
    turbine/          GLB access, per-farm dynamics, instanced LOD, cutaway hero
  ui/               HUD, timeline, toolbar, turbine panel, engineering overlay
  state.ts          zustand store: stage, data, scene time, tools, stats
worker/             weather service (Cloudflare Worker): Open-Meteo hourly and CWA buoys every 10 minutes, stored in KV as sent
```

Per-frame simulation state, such as rotor angle, yaw and wind per farm, lives in plain typed
arrays (`farmDynamics`) that shaders read as uniform arrays. React holds only state that changes
at UI rate. The render loop does not allocate.

## Performance notes

Measured in headless Chrome on an Apple M1 at 1440 × 800, DPR 1: 60 fps beside a turbine and
about 53 fps in the overview with clouds over the island; adaptive quality takes it from there.
Volumetric clouds, the per-pixel atmosphere and the sea are the bulk of the frame.

**513 turbines in four draw calls.** Every turbine is an instance. Each LOD level has two
`InstancedMesh`es, body and rotor. Yaw and rotor spin happen in the vertex shader from per-farm
uniform arrays and per-instance phase, so animating a turbine costs no CPU matrix work. Every
third frame the CPU re-buckets turbines by frustum (sphere test) and distance:

| Bucket | Range | Geometry |
| --- | --- | --- |
| LOD0 | < 7 km | full mesh, about 16k triangles |
| LOD1 | 7–70 km | meshoptimizer-simplified, about 6k triangles |
| LOD2 | > 70 km or culled | one point (aviation light at night) |

In the overview, all 513 turbines collapse into a single `Points` draw.

**Life size at sea, legible from orbit.** Below 1 km of altitude turbines are drawn life size, so
the arrays keep their real spacing of six to eight rotor diameters; above that they grow on a log
scale of altitude to 2.5× at 40 km, where life-size machines would vanish from the map. Each farm
scales the shared model to its own machine's rotor, from 136 m (TPC Phase 1) to 222 m (Hai Long and
Greater Changhua 2b & 4). Instancing, picking, aviation lights, the hero turbine, its shadow frustum
and camera flights all read the same per-farm scale.

**Asset pipeline.** The turbine is modelled procedurally after the medium-speed machines in the
strait (V164/V174 family): four-legged jacket, yellow transition piece with a railed platform,
boat landing and davit, a three-section tower with flanges, a long nacelle with a rooftop cooler
and a helicopter hoisting deck, and 81 m prebent blades. Every vertex carries its albedo, a
surface (roughness, metalness, how much it weathers) and an ambient occlusion term ray-traced at
build time with three-mesh-bvh. glTF-Transform then applies `reorder`, `quantize`
(KHR_mesh_quantization) and `EXT_meshopt_compression`: 243 KB for six meshes including both
LODs. At load time the dequantization transform is baked back into float geometry for
instancing.

**Painted steel without textures.** The turbine material is MeshPhysicalMaterial patched in
`onBeforeCompile` (`turbine/weathering.ts`): roughness, metalness and occlusion come from the
vertices, and a gloss clearcoat over the paint mirrors the sky and horizon down the tower, which
is what makes painted steel read as steel. Wear is added in model space so it stays put as the
nacelle yaws and the rotor turns: tone variation, rain streaks on vertical faces, rust weeping
down the yellow steel, algae and salt in the splash zone, and the seams between nacelle panels.

**FFT ocean.** The sea surface is a Tessendorf ocean. A two-peak spectrum, the live wind sea
(JONSWAP with Hasselmann spreading) plus the live swell (narrow and long-crested), is evolved in
time and transformed to the spatial domain by a radix-2 Stockham FFT in fragment shaders. Three
cascades (512 m, 97 m and 17 m tiles, hand-over at six fundamentals) share one 768 × 256 atlas;
two half-float targets carry eight packed real fields (choppy displacement, height, slopes and
the Jacobian's derivatives), so the simulation is 1 + 16 + 2 passes. One resolve writes each
cascade's displacement for the vertex shader, which moves a camera-centred radial grid (rings
spaced in proportion to their radius, about 10 m apart under the eye and out past the domain)
at the mip matching its spacing. Another writes mipmapped (slope, slope², foam): mip filtering
keeps the slope variance that distance averages away for the Beckmann glitter, and foam is
injected where the surface folds and decays over seconds, so whitecaps leave trails. Breaking
crests come from the combined Jacobian of all cascades. Up close the foam cover is drawn as
streaks of bubbles drawn out downwind with clear water between, not a translucent haze; farther
out, where that pattern is finer than a pixel, as its average. Waves are drawn life size, like the turbines around a camera near the sea, and
they lie down in the shallows so they never climb the coast.

**Kuroshio on the GPU.** Particle state (domain uv, age, lifetime) ping-pongs between RGBA32F
render targets in `GPUComputationRenderer`. The current field is a 24 × 14 RG16F texture with
hardware bilinear filtering and two hourly frames blended by a uniform. Land masking samples
the shared elevation texture. Particles render as instanced streak quads. Their length follows
current speed and camera distance, so they read as flow in the overview; they fade out as the
camera descends below 12 km and are gone below 2 km, where among the turbines they would only read
as streaks shooting across the water.

**One elevation texture, many uses.** A single R16F texture provides ocean depth colouring,
isobaths, surf, the calm shallows and the particle land mask.

**Terrain as an asset.** The land is modelled at true scale, with no vertical exaggeration. The
mesh starts as a 3584 × 2048 z11 grid (about 240 m apart) cut down to the cells that touch land
(3.2M triangles).
meshoptimizer then simplifies it to an absolute error of 25 m, below the source grid spacing, so
plains collapse to a few large triangles while ridgelines keep their detail: 1.13M triangles,
quantized and meshopt-compressed to 3.1 MB. Coastal cells slope down to sea vertices under the
water; the terrain draws nothing below the land's 4 m lift, so the ocean owns the coastline. Shading comes from the Sentinel-2 drape and a 4096²
normal map, with part of the imagery's baked 10:30 sun divided out before the scene sun is
applied. The island gets its own z12 drape at about 50 m per texel, faded in at the edge of its
box; phones and GPUs without 8192 textures keep the domain drape (about 200 m per texel east-west). Night lights are not hand-placed: they come from pixels that are bright, grey and flat
in the imagery, which is the real urban fabric.

**Physical atmosphere.** The sky is Hillaire's (2020) model in kilometres: transmittance and
multiple-scattering LUTs drawn once, and two sky-view LUTs per frame, one from the camera (the
dome, correct from orbit) and one from the sea surface (what lights and is reflected by the
ground). Every material shades in scene radiance and applies per-pixel aerial perspective by
integrating the same scattering along its view ray, so ridges fade into blue layers, the horizon
dissolves into haze and the overview looks down through 100 km of air. The three.js sun light
takes its colour from the CPU-side transmittance, and an exposure metered off the mean sky
radiance (partial adaptation, so dusk stays dusk) feeds ACES tone mapping. After nautical dusk
the moon, at its real position and phase, becomes the key light of the whole pipeline. The moon
is the photographed lunar surface, its north leaning toward the celestial pole as seen from
Taiwan, lit by the sun at the true phase with a Lommel-Seeliger law and a faint earthshine. The
stars are the real ones: every Yale Bright Star Catalogue star down to magnitude 6, rotated by
local sidereal time, sized by magnitude, coloured by B-V and dimmed toward the horizon by the same
transmittance. A high moon washes out the faint ones. Night is not fully adapted to: the moon's
illuminance is kept low enough that a moonlit sky stays darker than nautical twilight, and the
moon and stars are set in display brightness.

**Volumetric clouds.** The clouds are where Himawari-9 saw them:
`data/satellite.ts` decodes the band 13 infrared back to brightness temperature with the layer's
own colour map and calls cloud whatever is markedly colder than the clear sea (over land, the sea
reduced by the lapse rate, with a wider margin for sun-warmed slopes); colder tops grow taller and
the coldest become cirrus, except those below -50 to -65 °C: deep convection, a typhoon's eyewall
and rain bands, drawn as a dense overcast that stays visible from the overview. By day the band 3 visible adds low cloud that reflects far more than sea
or land. Consecutive hourly scans crossfade, so a time-lapse shows the real weather moving. There
are no other clouds: the forecast hours, and anywhere GIBS cannot be reached, have a clear sky. They are ray-marched through a flat layer at 0.9–2.9 km (Perlin-Worley shape eroded by
Worley detail, generated on the GPU at load) with multi-octave scattering and powder darkening,
as a post-processing pass that stops each ray at the depth buffer, so mountains pierce the layer.
One pixel of each 2x2 block is marched per frame at reduced resolution and the rest is carried
by reprojection; a joint bilateral upsample keeps silhouettes crisp, and crepuscular rays are
traced through gaps toward the sun. The terrain and sea take cloud shadows, the sea reflects a
cloudy environment refreshed every fourth frame, and from the overview the clouds thin out so
the map stays readable.

**Lighting the turbines.** That cloudy sea-level sky is filtered into a PMREM environment map
whenever the key light moves or the exposure shifts, so the gloss paint mirrors sky and sea. The
selected turbine also casts soft sun shadows from a frustum that hugs it.

**Soundscape.** Web Audio, on by default from the viewer's first gesture (`audio/engine.ts`). Recorded beds of
waves and sea wind fade and muffle as the camera climbs away from the water and swell with the
live sea state; the wind itself is band-passed pink noise whose level, colour and gusts follow the
hub-height wind; the nearest rotor is heard as noise amplitude-modulated at its blade-pass
frequency (three times its live rpm), panned to where it stands, over a recording of its
machinery up close. Gulls call now and then by day near the water, a CC BY track plays under it
all, and camera flights and selections have synthesised cues. Five channels (master, music,
ambience, white noise, effects) are mixed from the toolbar and remembered per browser; the
context suspends while the tab is hidden.

**Two languages.** Traditional Chinese and English, switched from the toolbar and remembered per
browser, defaulting to the browser's language (`i18n.ts`). The English table is typed against the
Chinese one, so a missing string fails the build; dates, weekdays and compass points follow the
language, and so do the document title and `lang`.

**Failure isolation.** Each part of the scene that loads its own assets sits in a `Layer`: an
error boundary around a Suspense boundary. A missing or broken file costs that layer, not the
canvas. The terrain degrades in steps: without the island drape it falls back to the domain
imagery.

**Depth precision across a 1000× zoom.** The camera's near plane follows its altitude, from 4 m
at a nacelle to 5 km in orbit. This avoids a logarithmic depth buffer and the shader cost that
comes with it.

**Adaptive quality.** `PerformanceMonitor` steps DPR down in 0.25 increments when frames run
long, and back up when there is headroom. MSAA in the composer is disabled above 1.5× DPR, where
it costs more than it shows. Touch devices start with fewer particles.

**Data budget.** Open-Meteo counts every coordinate of a multi-point request as one call, against
a per-IP limit (600 a minute and 10,000 a day on the free tier). One load asks for about 307
coordinates: the grid's sea points (the 44 on land, where the marine model has no data, are left out
and filled from their neighbours), the farms and the buoys that correct their wind. The weather
service makes that request 24 times a day for every visitor, about 7,400 calls. When the app has to fetch Open-Meteo itself, the response
is kept in `localStorage` for 30 minutes, matching the hourly update cadence, so reloads cost
nothing.

### Pitfalls worth knowing

- Terrarium tiles at z11 carry no bathymetry: the sea reads exactly 0 m. The land mask combines
  z11 with z9, which does have bathymetry.
- Open-Meteo returns `null` for `wave_peak_period` in the strait. The mean period is converted to
  peak period for a JONSWAP spectrum (Tp ≈ Tm / 0.83).

- Two `onBeforeCompile` materials whose source strings are identical share one compiled
  program. The rotor would silently render with the body's shader. Set `customProgramCacheKey`.
- Flat quads built in the XZ plane flip their winding when viewed from above, so they are culled
  as back faces unless rendered double-sided.
- Under React StrictMode, GPU resources created in `useMemo` and disposed in an effect cleanup
  are destroyed before first use. Create and dispose them in the same effect.

## Deploying as a claude.ai artifact

```
npm run snapshot:weather   # refresh the bundled Open-Meteo fallback (reaches 7 days ahead)
npm run build:artifact     # dist-artifact/artifact.html plus models, textures and data
```

Then publish `dist-artifact/artifact.html` with the other files in `dist-artifact/` (except
`assets/` and `index.html`) as supporting files at the same paths. The artifact host admits
stylesheets only from Google Fonts and serves only web file types, so the page inlines the app's
CSS and JS, and the artifact-mode build loads each model as a self-contained `.gltf` repackaged
losslessly from its `.glb`. Asset URLs are relative everywhere (`base: './'`). If a viewer cannot
reach Open-Meteo, the app reads the snapshot and labels it as one, with its retrieval time.

## Open Sea (`sea/index.html`)

A companion piece at sea level: one self-contained HTML file (three.js from a CDN, no build step)
that renders the open strait from a few metres above the water up through the cloud layer. Serve
the folder statically (`python3 -m http.server -d sea`) and open it.

- **Sky**: Hillaire (2020) — transmittance, multiple-scattering and sky-view LUTs, Mie haze for the
  marine boundary layer, and per-pixel aerial perspective on the sea and the clouds.
- **Clouds**: cumulus ray-marched through a spherical shell, shaped by Perlin-Worley noise and
  eroded by Worley detail (generated on the GPU at load), lit with multi-octave scattering, a
  dual-lobe phase and powder darkening. One pixel of each 2x2 block is marched per frame and the rest
  is carried by reprojection; a joint bilateral upsample keeps the horizon crisp. Wind-combed cirrus
  and deep-convection overcast on a sheet at 8.5 km, seen from below or above; cloud shadows and
  crepuscular rays below.
- **Sea**: three FFT cascades of full choppy displacement from a two-peak spectrum (wind sea and
  swell), a camera-centred radial grid that follows the Earth's curvature to the horizon, slope
  variance kept through the mip chain for filtered glitter, and whitecaps where the combined
  Jacobian folds, leaving trails that decay in tile space.
- **Time**: real solar and lunar positions over the strait. After nautical dusk the moon, at its
  real phase, lights the whole pipeline; stars fade in with atmospheric extinction.
- **Data**: "套用即時海況與時間" applies the live Open-Meteo wind, wind sea, swell and cloud cover
  for 24.0°N 119.9°E. Until then the page shows a typical October north-east monsoon sea.
- **Budget**: adaptive resolution from the measured frame interval; the reflection environment is
  refreshed every fourth frame and bloom runs at half resolution.

## Credits

Sound (found through Openverse): “Ocean Dream” by Windpearl, CC BY 3.0 (Jamendo); ocean waves by
rucisko, sea wind by Potapooo, gulls by steaq and Snapper4298, wind turbine by eguaus, all CC0
(Freesound). The recordings are trimmed into crossfaded loops and loudness-normalised.

Imagery: Sentinel-2 cloudless 2024 – https://s2maps.eu by EOX IT Services GmbH (contains modified
Copernicus Sentinel data 2024), licensed CC BY-NC-SA 4.0. Elevation: AWS Terrain Tiles. Weather:
Open-Meteo; measured waves, wind and tides: Central Weather Administration open data; measured output: Taipower open data. Tidal
flats: derived from Copernicus Sentinel-2 data 2023-2026 and Copernicus DEM GLO-30 (© DLR e.V.
2010-2014 and © Airbus Defence and Space GmbH 2014-2018, provided under COPERNICUS by the European
Union and ESA). Clouds: Himawari-9 (JMA) imagery through NASA GIBS. Stars: Yale Bright Star Catalogue,
5th revised edition (Hoffleit & Warren 1991), from CDS. Moon: Solar System Scope textures (CC BY
4.0), based on NASA imagery. Film narration: Gemini TTS.
