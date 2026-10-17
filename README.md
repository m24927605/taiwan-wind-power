# 風與潮 Wind & Tide

A live digital twin of the Taiwan Strait, built with Three.js and React Three Fiber.

It opens on an inkstone that you polish by hand. As the surface turns to a mirror, a gold-leaf
engraving of Taiwan rises out of it, and the camera falls through the engraving into the real
strait: the Kuroshio current streaming past the east coast, and 513 offshore turbines turning
to the wind that is blowing over the strait right now.

```bash
npm install
npm run dev            # http://localhost:5199  (append ?skip to bypass the intro)
npm run build
```

## What is live

| Layer | Source | Notes |
| --- | --- | --- |
| Terrain and bathymetry | AWS Terrain Tiles (Terrarium, z9) | Baked by `scripts/build-elevation.ts` into a 1024² Int16 grid (2 MB) |
| Ocean currents | Open-Meteo Marine API | 14 × 14 grid over the domain, hourly, yesterday through three days ahead |
| Hub-height wind | Open-Meteo Forecast API, 100 m | One point per wind farm; drives yaw, rotor rpm and output |
| Sun and sky | NOAA solar position | Day, dusk and night follow the scene clock |

The timeline scrubs across the full 96-hour window, and the play button runs it as a time-lapse.
Turbine output comes from a cubic power curve (cut-in 3 m/s, rated 12 m/s, cut-out 25 m/s),
scaled to each farm's rating. Farm counts and ratings follow public project data. Turbine
coordinates are an approximate array layout, and the UI says so.

## Interaction

- Click a turbine to fly to it. The nacelle is cut open with an animated clipping plane, and its
  main bearing, gearbox, generator, converter and yaw drive are labelled. The side panel shows
  live wind, rpm, output and the power curve.
- `M` measures great-circle distance and bearing. Points snap to turbines.
- `E` toggles engineering mode, a diagnostic render plus live renderer statistics.
- `Space` plays or pauses the time-lapse, `R` returns to the overview, and `Esc` clears the
  selection.

## Architecture

```
scripts/            offline asset pipeline (Node, run once)
  build-elevation.ts  Terrarium tiles -> Int16 elevation grid
  build-turbine.ts    procedural turbine -> meshopt LOD -> quantized, meshopt-compressed GLB
src/
  geo/              domain projection (lon/lat <-> km), solar position, geodesic
  data/             elevation loader, Open-Meteo client (browser-cached), wind farm layout
  scene/            R3F scene: sky, ocean, terrain, Kuroshio GPGPU, wind farms, hero turbine
    camera.ts         imperative camera API (fly to turbine, overview)
    turbine/          GLB access, per-farm dynamics, instanced LOD, cutaway hero
  intro/            inkstone polishing intro
  ui/               HUD, timeline, toolbar, turbine panel, engineering overlay
  state.ts          zustand store: stage, data, scene time, tools, stats
```

Per-frame simulation state, such as rotor angle, yaw and wind per farm, lives in plain typed
arrays (`farmDynamics`) that shaders read as uniform arrays. React holds only state that changes
at UI rate. The render loop does not allocate.

## Performance notes

Measured at 1440 × 650 CSS px, DPR 2 (Apple Silicon, Chrome): **60 fps**, about 252k triangles,
65k particles, 10 scene draw calls plus post-processing.

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

**Kuroshio on the GPU.** Particle state (domain uv, age, lifetime) ping-pongs between RGBA32F
render targets in `GPUComputationRenderer`. The current field is a 14 × 14 RG16F texture with
hardware bilinear filtering and two hourly frames blended by a uniform. Land masking samples
the shared elevation texture. Particles render as instanced streak quads. Their length follows
current speed and camera distance, so they read as flow in the overview and as short wakes up
close.

**One elevation texture, many uses.** A single R16F texture provides ocean depth colouring,
isobaths, surf, the particle land mask and the intro engraving. The terrain mesh keeps only cells
that touch land: about 120k triangles instead of 520k for the full grid.

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

- Two `onBeforeCompile` materials whose source strings are identical share one compiled
  program. The rotor would silently render with the body's shader. Set `customProgramCacheKey`.
- Flat quads built in the XZ plane flip their winding when viewed from above, so they are culled
  as back faces unless rendered double-sided.
- Under React StrictMode, GPU resources created in `useMemo` and disposed in an effect cleanup
  are destroyed before first use. Create and dispose them in the same effect.
