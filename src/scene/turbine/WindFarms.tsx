import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { TURBINES, WIND_FARMS } from '../../data/windfarms'
import { useStore } from '../../state'
import { atmosphere } from '../atmosphere'
import { LOD_MID, LOD_NEAR, lodCounts } from './lod'
import { TURBINE } from './spec'
import { farmDynamics, turbineScale, turbineView } from './dynamics'
import { useTurbineModel } from './useTurbineModel'
import { TURBINE_PAINT, applyWeathering } from './weathering'

const REBUCKET_EVERY = 3

const COUNT = TURBINES.length
const LOD_TINTS = [new THREE.Color(0x35e0ff), new THREE.Color(0xffb020)]

/** Shared per-frame uniforms for every instanced turbine material. */
const turbineUniforms = {
  uYaw: { value: farmDynamics.yaw },
  uSpin: { value: farmDynamics.spin },
  uRunning: { value: farmDynamics.running },
  uIdleSpin: { value: 0 },
  uHighlight: { value: -1 },
  uDebug: atmosphere.uDebug,
}

function createMaterial(isRotor: boolean, lod: number): THREE.MeshPhysicalMaterial {
  const material = new THREE.MeshPhysicalMaterial(TURBINE_PAINT)
  // onBeforeCompile sources are identical for body and rotor; key them apart or three shares one program.
  material.customProgramCacheKey = () => `turbine-${isRotor ? 'rotor' : 'body'}`
  material.onBeforeCompile = (shader) => {
    applyWeathering(shader, isRotor)
    Object.assign(shader.uniforms, turbineUniforms, {
      uHub: { value: new THREE.Vector3(0, TURBINE.hubHeight, TURBINE.hubOffsetZ) },
      uLodTint: { value: LOD_TINTS[lod] },
    })
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
        attribute float aFarm;
        attribute float aPhase;
        attribute float aIndex;
        attribute float aRank;
        uniform float uYaw[${WIND_FARMS.length}];
        uniform float uSpin[${WIND_FARMS.length}];
        uniform float uRunning[${WIND_FARMS.length}];
        uniform float uIdleSpin;
        uniform float uHighlight;
        uniform vec3 uHub;
        varying float vHighlight;
        mat3 rotY(float a) { float c = cos(a), s = sin(a); return mat3(c, 0., -s, 0., 1., 0., s, 0., c); }
        mat3 rotZ(float a) { float c = cos(a), s = sin(a); return mat3(c, s, 0., -s, c, 0., 0., 0., 1.); }`,
      )
      .replace(
        '#include <beginnormal_vertex>',
        /* glsl */ `#include <beginnormal_vertex>
        int farm = int(aFarm + 0.5);
        mat3 yawM = rotY(uYaw[farm]);
        mat3 spinM = rotZ(-((aRank < uRunning[farm] ? uSpin[farm] : uIdleSpin) + aPhase));
        ${isRotor ? 'objectNormal = spinM * objectNormal;' : ''}
        objectNormal = yawM * objectNormal;
        vHighlight = 1.0 - step(0.5, abs(aIndex - uHighlight));`,
      )
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `#include <begin_vertex>
        ${isRotor ? 'transformed = spinM * transformed + uHub;' : ''}
        transformed = yawM * transformed;`,
      )
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
        uniform float uDebug;
        uniform vec3 uLodTint;
        varying float vHighlight;`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        /* glsl */ `#include <emissivemap_fragment>
        totalEmissiveRadiance += vec3(0.25, 0.85, 1.0) * vHighlight * 0.9 + uLodTint * uDebug * 0.8;`,
      )
  }
  return material
}

interface Bucket {
  mesh: THREE.InstancedMesh
  farm: THREE.InstancedBufferAttribute
  phase: THREE.InstancedBufferAttribute
  index: THREE.InstancedBufferAttribute
  rank: THREE.InstancedBufferAttribute
}

function createBucket(geometry: THREE.BufferGeometry, material: THREE.Material): Bucket {
  const g = geometry.clone()
  const farm = new THREE.InstancedBufferAttribute(new Float32Array(COUNT), 1).setUsage(THREE.DynamicDrawUsage)
  const phase = new THREE.InstancedBufferAttribute(new Float32Array(COUNT), 1).setUsage(THREE.DynamicDrawUsage)
  const index = new THREE.InstancedBufferAttribute(new Float32Array(COUNT), 1).setUsage(THREE.DynamicDrawUsage)
  const rank = new THREE.InstancedBufferAttribute(new Float32Array(COUNT), 1).setUsage(THREE.DynamicDrawUsage)
  g.setAttribute('aFarm', farm)
  g.setAttribute('aPhase', phase)
  g.setAttribute('aIndex', index)
  g.setAttribute('aRank', rank)
  const mesh = new THREE.InstancedMesh(g, material, COUNT)
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  mesh.frustumCulled = false
  mesh.count = 0
  return { mesh, farm, phase, index, rank }
}

/** Aviation lights / far-field markers: one point per turbine at the nacelle roof. */
function createLights(): THREE.Points {
  const positions = new Float32Array(COUNT * 3)
  const seeds = new Float32Array(COUNT)
  TURBINES.forEach((t, i) => {
    // Height at the current exaggeration of 1: the shader scales it with the turbines.
    positions.set([t.x, (TURBINE.hubHeight + 5.5) * turbineScale(t.farm) / turbineView.exaggeration, t.z], i * 3)
    seeds[i] = t.farm
  })
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  g.setAttribute('aFarm', new THREE.BufferAttribute(seeds, 1))
  const material = new THREE.ShaderMaterial({
    uniforms: { ...atmosphere, uPixelRatio: { value: 1 }, uMid: { value: LOD_MID }, uExaggeration: { value: 1 } },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      uniform float uTime;
      uniform float uDay;
      uniform float uPixelRatio;
      uniform float uMid;
      uniform vec3 uCameraPos;
      uniform float uExaggeration;
      attribute float aFarm;
      varying vec3 vColor;
      void main() {
        vec3 p = vec3(position.x, position.y * uExaggeration, position.z);
        vec4 mv = viewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        float dist = length(p - uCameraPos);
        // Synchronised flashing per farm (1 s on, 1 s off), as required for offshore arrays.
        float flash = step(0.5, fract(uTime * 0.5 + aFarm * 0.13));
        vec3 day = vec3(0.92, 0.95, 0.97) * 0.55 * smoothstep(uMid * 0.8, uMid * 1.1, dist);
        vec3 night = vec3(1.0, 0.12, 0.06) * (0.35 + 0.65 * flash);
        vColor = mix(night, day, smoothstep(0.15, 0.5, uDay));
        gl_PointSize = clamp(260.0 / dist, 1.6, 7.0) * uPixelRatio;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vColor;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        float a = smoothstep(0.5, 0.0, d);
        gl_FragColor = vec4(vColor * a * a, 1.0);
      }
    `,
  })
  const points = new THREE.Points(g, material)
  points.frustumCulled = false
  return points
}

export function WindFarms() {
  const model = useTurbineModel()
  const camera = useThree((s) => s.camera)
  const dpr = useThree((s) => s.viewport.dpr)
  const frame = useRef(0)

  const { group, buckets, lights } = useMemo(() => {
    const group = new THREE.Group()
    const buckets = [0, 1].map((lod) => [
      createBucket(model.body[lod], createMaterial(false, lod)),
      createBucket(model.rotor[lod], createMaterial(true, lod)),
    ])
    for (const pair of buckets) for (const b of pair) group.add(b.mesh)
    const lights = createLights()
    group.add(lights)
    return { group, buckets, lights }
  }, [model])

  useEffect(() => {
    ;(lights.material as THREE.ShaderMaterial).uniforms.uPixelRatio.value = dpr
  }, [lights, dpr])

  const scratch = useMemo(
    () => ({ m: new THREE.Matrix4(), frustum: new THREE.Frustum(), pv: new THREE.Matrix4(), sphere: new THREE.Sphere() }),
    [],
  )

  useFrame(() => {
    const { hovered, selected } = useStore.getState()
    turbineUniforms.uHighlight.value = hovered ?? -1
    turbineUniforms.uIdleSpin.value = farmDynamics.idleSpin
    ;(lights.material as THREE.ShaderMaterial).uniforms.uExaggeration.value = turbineView.exaggeration

    if (frame.current++ % REBUCKET_EVERY !== 0) return
    const { m, frustum, pv, sphere } = scratch
    pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
    frustum.setFromProjectionMatrix(pv)
    const counts = [0, 0]
    for (const t of TURBINES) {
      if (t.index === selected) continue
      const s = turbineScale(t.farm)
      sphere.radius = (TURBINE.hubHeight + TURBINE.rotorRadius) * s * 0.75
      sphere.center.set(t.x, TURBINE.hubHeight * s * 0.7, t.z)
      if (!frustum.intersectsSphere(sphere)) continue
      const d = camera.position.distanceTo(sphere.center)
      if (d > LOD_MID) continue
      const lod = d < LOD_NEAR ? 0 : 1
      const k = counts[lod]++
      m.makeScale(s, s, s).setPosition(t.x, 0, t.z)
      for (const b of buckets[lod]) {
        b.mesh.setMatrixAt(k, m)
        b.farm.setX(k, t.farm)
        b.phase.setX(k, t.phase)
        b.index.setX(k, t.index)
        b.rank.setX(k, t.rank)
      }
    }
    buckets.forEach((pair, lod) => {
      for (const b of pair) {
        b.mesh.count = counts[lod]
        b.mesh.instanceMatrix.needsUpdate = true
        b.farm.needsUpdate = b.phase.needsUpdate = b.index.needsUpdate = b.rank.needsUpdate = true
      }
    })
    lodCounts[0] = counts[0]
    lodCounts[1] = counts[1]
    lodCounts[2] = COUNT - counts[0] - counts[1]
  })

  return <primitive object={group} />
}
