import { useFrame } from '@react-three/fiber'
import { useRef } from 'react'
import * as THREE from 'three'
import { ATMOSPHERE_GLSL, atmosphere } from './atmosphere'

const material = new THREE.ShaderMaterial({
  uniforms: { ...atmosphere },
  side: THREE.BackSide,
  depthWrite: false,
  depthTest: false,
  vertexShader: /* glsl */ `
    varying vec3 vDir;
    void main() {
      vDir = normalize(position);
      vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      gl_Position = p.xyww;
    }
  `,
  fragmentShader: /* glsl */ `
    ${ATMOSPHERE_GLSL}
    varying vec3 vDir;

    float stars(vec3 dir) {
      // Cube-face cells give an even star distribution without polar pinching.
      vec3 a = abs(dir);
      vec2 uv = a.x > a.y && a.x > a.z ? dir.yz / a.x : a.y > a.z ? dir.xz / a.y : dir.xy / a.z;
      vec2 cell = floor(uv * 260.0);
      float h = hash12(cell + sign(dir.x) * 17.0 + sign(dir.y) * 31.0 + sign(dir.z) * 7.0);
      vec2 f = fract(uv * 260.0) - 0.5;
      float star = smoothstep(0.08, 0.0, length(f)) * step(0.985, h);
      float twinkle = 0.6 + 0.4 * sin(uTime * (1.0 + h * 3.0) + h * 40.0);
      return star * twinkle * (h - 0.985) * 66.0;
    }

    void main() {
      vec3 dir = normalize(vDir);
      vec3 col = skyColor(dir);
      float sd = max(dot(dir, uSunDir), 0.0);
      col += sunColor() * (pow(sd, 1800.0) * 12.0 + pow(sd, 12.0) * 0.18 * (0.3 + uDay));
      float night = 1.0 - smoothstep(0.0, 0.35, uDay);
      col += vec3(0.85, 0.9, 1.0) * stars(dir) * night * smoothstep(0.0, 0.15, dir.y);
      float md = max(dot(dir, MOON_DIR), 0.0);
      col += vec3(0.8, 0.86, 1.0) * (smoothstep(0.99985, 0.9999, md) * 1.6 + pow(md, 60.0) * 0.08) * night;
      gl_FragColor = vec4(col, 1.0);
      #include <colorspace_fragment>
    }
  `,
})

export function Sky() {
  const mesh = useRef<THREE.Mesh>(null)
  useFrame(({ camera }) => mesh.current?.position.copy(camera.position))
  return (
    <mesh ref={mesh} material={material} frustumCulled={false} renderOrder={-1}>
      <sphereGeometry args={[1, 48, 24]} />
    </mesh>
  )
}
