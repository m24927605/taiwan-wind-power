import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useState } from 'react'
import * as THREE from 'three'
import { OBSERVER, equatorialToWorld } from '../geo/sun'
import { useStore } from '../state'
import { ATMOSPHERE_GLSL, atmosphere } from './atmosphere'

// The real night sky: every star of the Yale Bright Star Catalogue down to magnitude 6
// (scripts/build-stars.ts), turned to the scene clock's sidereal time over Taiwan. Sizes follow
// magnitude, colours follow B-V, and the air dims and reddens stars toward the horizon. Like the
// moon they are set in display brightness, since exposure stops adapting at night. Drawn at the far
// plane after the sky, so terrain and sea hide them and the cloud pass covers them.

const STARS_URL = 'data/stars.json'

function createStars(records: Float32Array, pixelRatio: number): THREE.Points {
  const n = records.length / 4
  const dir = new Float32Array(n * 3)
  const mag = new Float32Array(n)
  const bv = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const [ra, dec] = [records[i * 4], records[i * 4 + 1]]
    dir.set([Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec)], i * 3)
    mag[i] = records[i * 4 + 2]
    bv[i] = records[i * 4 + 3]
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(dir, 3))
  g.setAttribute('aMag', new THREE.BufferAttribute(mag, 1))
  g.setAttribute('aBV', new THREE.BufferAttribute(bv, 1))
  const material = new THREE.ShaderMaterial({
    uniforms: { ...atmosphere, uEqToWorld: { value: new THREE.Matrix3() }, uPixelRatio: { value: pixelRatio } },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      ${ATMOSPHERE_GLSL}
      uniform mat3 uEqToWorld;
      uniform float uPixelRatio;
      attribute float aMag;
      attribute float aBV;
      varying vec3 vColor;

      // Star colour from B-V: blue-white O/B through white A, yellow G, orange K to red M.
      vec3 starColor(float bv) {
        vec3 c = mix(vec3(0.62, 0.72, 1.0), vec3(0.95, 0.96, 1.0), smoothstep(-0.3, 0.1, bv));
        c = mix(c, vec3(1.0, 0.94, 0.82), smoothstep(0.1, 0.65, bv));
        c = mix(c, vec3(1.0, 0.8, 0.58), smoothstep(0.65, 1.15, bv));
        return mix(c, vec3(1.0, 0.68, 0.45), smoothstep(1.15, 1.7, bv));
      }

      void main() {
        vec3 dir = normalize(uEqToWorld * position);
        vec4 clip = projectionMatrix * viewMatrix * vec4(cameraPosition + dir * 1000.0, 1.0);
        // On the far plane, behind everything the scene draws.
        gl_Position = vec4(clip.xy, clip.w * 0.99999, clip.w);
        float r = RG + max(uCameraPos.y, 0.001);
        float darkness = smoothstep(-0.08, -0.25, uSunTrue.y);
        // A high moon washes out the faint stars: the naked-eye limit drops from 6 to about 4.5.
        float limit = 6.0 - 1.5 * uMoonLight * smoothstep(-0.05, 0.4, uSunDir.y);
        float visible = smoothstep(limit + 0.2, limit - 0.6, aMag);
        // Flux relative to a first-magnitude star, compressed: the brightest just catch the bloom.
        float flux = pow(10.0, -0.4 * (aMag - 1.0));
        float twinkle = 1.0 + 0.25 * sin(uTime * (3.0 + fract(aMag * 17.3) * 5.0) + aBV * 40.0) * (1.0 - smoothstep(0.0, 0.5, dir.y));
        vColor = starColor(aBV) * transmittanceTo(r, dir.y) * darkness * visible * twinkle * min(0.35 + 1.4 * sqrt(flux), 3.2);
        gl_PointSize = clamp(1.8 + 0.6 * (5.0 - aMag), 1.5, 6.5) * uPixelRatio;
        if (dir.y < -0.01 || darkness <= 0.0) gl_PointSize = 0.0;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vColor;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        gl_FragColor = vec4(vColor * exp(-d * d * 11.0), 1.0);
      }
    `,
  })
  const points = new THREE.Points(g, material)
  points.frustumCulled = false
  points.renderOrder = 0
  return points
}

export function Stars() {
  const dpr = useThree((s) => s.viewport.dpr)
  const [records, setRecords] = useState<Float32Array | null>(null)
  useEffect(() => {
    fetch(STARS_URL)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${STARS_URL}: HTTP ${r.status}`))))
      .then((records: number[]) => setRecords(new Float32Array(records)))
      .catch((error) => console.error('[stars]', error))
  }, [])
  const stars = useMemo(() => (records ? createStars(records, dpr) : null), [records, dpr])
  useEffect(
    () => () => {
      stars?.geometry.dispose()
      ;(stars?.material as THREE.Material | undefined)?.dispose()
    },
    [stars],
  )

  useFrame(() => {
    if (!stars) return
    const material = stars.material as THREE.ShaderMaterial
    stars.visible = atmosphere.uSunTrue.value.y < -0.08
    if (!stars.visible) return
    const m = equatorialToWorld(useStore.getState().time, OBSERVER.lon, OBSERVER.lat)
    ;(material.uniforms.uEqToWorld.value as THREE.Matrix3).set(m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8])
  })

  return stars && <primitive object={stars} />
}
