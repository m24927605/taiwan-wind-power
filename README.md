# 風與潮 Wind & Tide

A live digital twin of the Taiwan Strait, built with Three.js and React Three Fiber.

It opens on an inkstone that you polish by hand. As the surface turns to a mirror, a gold-leaf
engraving of Taiwan rises out of it, and the camera falls through the engraving into the real
strait: Sentinel-2 imagery draped over the island, an FFT ocean raised by today's wave forecast,
the Kuroshio current streaming past the east coast, and 513 offshore turbines turning to the
wind that is blowing over the strait right now.

```bash
npm install
npm run dev            # http://localhost:5199  (append ?skip to bypass the intro)
npm run build
```

## What is live

| Layer | Source | Notes |
| --- | --- | --- |
| Bathymetry | AWS Terrain Tiles (Terrarium, z9) | Baked by `scripts/build-elevation.ts` into a 1024² Int16 grid (2 MB) |
| Land surface | AWS Terrain Tiles (Terrarium, z11) | Baked by `scripts/build-terrain.ts` into a simplified 330k-triangle GLB (1 MB) |
| Land imagery | Sentinel-2 cloudless 2024, EOX | Baked by `scripts/build-imagery.ts` into a 4096² WebP (1.3 MB) plus a 2048² normal map |
| Ocean currents | Open-Meteo Marine API | 14 × 14 grid over the domain, hourly, yesterday through three days ahead |
| Sea state | Open-Meteo Marine API | Wave height, period and direction, median over the strait; drives the wave spectrum |
| Hub-height wind | Open-Meteo Forecast API, 100 m | One point per wind farm; drives yaw, rotor rpm and output |
| Sun and sky | NOAA solar position | Day, dusk and night follow the scene clock |

The timeline scrubs across the full 96-hour window, and the play button runs it as a time-lapse.
Turbine output comes from a cubic power curve (cut-in 3 m/s, rated 12 m/s, cut-out 25 m/s),
scaled to each farm's rating. Farm counts and ratings follow public project data. Turbine
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
  flies back to it.
- `M` measures great-circle distance and bearing. Points snap to turbines.
- `E` toggles engineering mode, a diagnostic render plus live renderer statistics.
- `Space` plays or pauses the time-lapse, `R` returns to the overview, and `Esc` clears the
  selection.

## Architecture

```
scripts/            offline asset pipeline (Node, run once)
  tiles.ts            Web Mercator tile mosaic -> resampled onto the scene grid
  build-elevation.ts  Terrarium tiles -> Int16 elevation grid (bathymetry)
  build-terrain.ts    z11 Terrarium -> land mesh -> meshopt simplify -> quantized GLB
  build-imagery.ts    Sentinel-2 cloudless + z11 normals -> WebP textures
  build-turbine.ts    procedural turbine -> meshopt LOD -> quantized, meshopt-compressed GLB
src/
  geo/              domain projection (lon/lat <-> km), solar position, geodesic
  data/             elevation loader, Open-Meteo client (browser-cached), wind farm layout
  scene/            R3F scene: sky, terrain, Kuroshio GPGPU, wind farms, hero turbine
    ocean/            FFT wave simulation and ocean shading
    camera.ts         imperative camera API (fly to turbine, farm, overview)
    farmAreas.ts      farm outlines derived from the layout, and analytic farm picking
    turbine/          GLB access, per-farm dynamics, instanced LOD, cutaway hero
  intro/            inkstone polishing intro
  ui/               HUD, timeline, toolbar, turbine panel, engineering overlay
  state.ts          zustand store: stage, data, scene time, tools, stats
```

Per-frame simulation state, such as rotor angle, yaw and wind per farm, lives in plain typed
arrays (`farmDynamics`) that shaders read as uniform arrays. React holds only state that changes
at UI rate. The render loop does not allocate.

## Performance notes

Measured on an Apple M1 in Chrome at 1440 × 650 CSS px: about 55 fps at DPR 2 and a steady
60 fps at DPR 1.5, where adaptive quality settles. About 460k triangles, 65k particles, 10 scene
draw calls, 18 wave-simulation passes and post-processing. At DPR 2 an empty scene with only
post-processing already runs at about 56 fps on this machine, so the fill rate of the composer
sets the ceiling, not the scene content.

**513 turbines in four draw calls.** Every turbine is an instance. Each LOD level has two
`InstancedMesh`es, body and rotor. Yaw and rotor spin happen in the vertex shader from per-farm
uniform arrays and per-instance phase, so animating a turbine costs no CPU matrix work. Every
third frame the CPU re-buckets turbines by frustum (sphere test) and distance:

| Bucket | Range | Geometry |
| --- | --- | --- |
| LOD0 | < 7 km | full mesh, about 7.4k triangles |
| LOD1 | 7–70 km | meshoptimizer-simplified, about 1.5k triangles |
| LOD2 | > 70 km or culled | one point (aviation light at night) |

In the overview, all 513 turbines collapse into a single `Points` draw.

**Asset pipeline.** The turbine is modelled procedurally and exported through glTF-Transform:
`reorder` for vertex-cache locality, `quantize` (KHR_mesh_quantization: 14-bit positions, 10-bit
normals, 8-bit colours) and `EXT_meshopt_compression`. The result is a 92 KB GLB for six meshes
including both LODs. At load time the dequantization transform is baked back into float geometry
for instancing.

**FFT ocean.** The sea surface is a Tessendorf ocean. A directional JONSWAP spectrum, with
Hasselmann spreading and its height normalised to the live significant wave height, is evolved
in time and transformed to the spatial domain by a radix-2 Stockham FFT in fragment shaders.
Three cascades (512 m, 97 m and 17 m tiles, hand-over at six fundamentals) share one 768 × 256
atlas, so the whole simulation is 1 + 16 + 1 full-screen passes. One half-float target carries
four packed real fields (two slopes and two displacement derivatives for the foam Jacobian),
which keeps the FFT at a quarter of the bandwidth of a two-target float32 version. A resolve
pass writes each cascade into a mipmapped texture of (slope, slope², Jacobian). Mip filtering
then gives the mean slope and, from the second moment, the slope variance that was averaged
away. The shader feeds that variance into a Beckmann specular term, so distant water roughens
into a realistic sun glitter instead of turning into a mirror or shimmering.

**Kuroshio on the GPU.** Particle state (domain uv, age, lifetime) ping-pongs between RGBA32F
render targets in `GPUComputationRenderer`. The current field is a 14 × 14 RG16F texture with
hardware bilinear filtering and two hourly frames blended by a uniform. Land masking samples
the shared elevation texture. Particles render as instanced streak quads. Their length follows
current speed and camera distance, so they read as flow in the overview and as short wakes up
close.

**One elevation texture, many uses.** A single R16F texture provides ocean depth colouring,
isobaths, surf, the particle land mask and the intro engraving.

**Terrain as an asset.** The land mesh starts as a 2048² z11 grid cut down to the cells that
touch land (1.76M triangles). meshoptimizer then simplifies it to an absolute error of 40 m, so
plains collapse to a few large triangles while ridgelines keep their detail: 330k triangles,
quantized and meshopt-compressed to 1 MB. Shading comes from the Sentinel-2 drape and a
2048² normal map, with part of the imagery's baked 10:30 sun divided out before the scene sun is
applied. Night lights are not hand-placed: they come from pixels that are bright, grey and flat
in the imagery, which is the real urban fabric.

**Depth precision across a 1000× zoom.** The camera's near plane follows its altitude, from 4 m
at a nacelle to 5 km in orbit. This avoids a logarithmic depth buffer and the shader cost that
comes with it.

**Adaptive quality.** `PerformanceMonitor` steps DPR down in 0.25 increments when frames run
long, and back up when there is headroom. MSAA in the composer is disabled above 1.5× DPR, where
it costs more than it shows. Touch devices start with fewer particles.

**Data budget.** Open-Meteo counts every coordinate of a multi-point request as one call.
Responses are cached in `localStorage` for 30 minutes, matching the hourly update cadence, so
reloads cost nothing.

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

## Credits

Imagery: Sentinel-2 cloudless 2024 – https://s2maps.eu by EOX IT Services GmbH (contains modified
Copernicus Sentinel data 2024), licensed CC BY-NC-SA 4.0. Elevation: AWS Terrain Tiles. Weather:
Open-Meteo.
