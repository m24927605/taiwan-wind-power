import { useGLTF } from '@react-three/drei'
import { useMemo } from 'react'
import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { TURBINE, TURBINE_GLB_URL } from './spec'

export interface TurbineModel {
  /** Instancing geometries in metres; rotors are hub-centred so the shader can spin them in place. */
  body: [lod0: THREE.BufferGeometry, lod1: THREE.BufferGeometry]
  rotor: [lod0: THREE.BufferGeometry, lod1: THREE.BufferGeometry]
  /** Separate parts for the inspected hero turbine, which cuts the nacelle open. */
  hero: { tower: THREE.BufferGeometry; shell: THREE.BufferGeometry; internals: THREE.BufferGeometry; rotor: THREE.BufferGeometry }
}

const HUB = new THREE.Vector3(0, TURBINE.hubHeight, TURBINE.hubOffsetZ)

/**
 * The GLB is quantized (KHR_mesh_quantization): vertex data is stored as normalized integers
 * and the node transform carries the dequantization. Bake that transform into float geometry.
 */
function bakedGeometry(scene: THREE.Group, name: string, offset?: THREE.Vector3): THREE.BufferGeometry {
  const mesh = scene.getObjectByName(name) as THREE.Mesh | undefined
  if (!mesh) throw new Error(`turbine.glb: missing node ${name}`)
  mesh.updateWorldMatrix(true, false)
  const g = new THREE.BufferGeometry()
  for (const key of ['position', 'normal', 'color']) {
    const src = mesh.geometry.getAttribute(key)
    const out = new Float32Array(src.count * 3)
    for (let i = 0; i < src.count; i++) out.set([src.getX(i), src.getY(i), src.getZ(i)], i * 3)
    g.setAttribute(key, new THREE.BufferAttribute(out, 3))
  }
  g.setIndex(mesh.geometry.index)
  g.applyMatrix4(mesh.matrixWorld)
  if (offset) g.translate(-offset.x, -offset.y, -offset.z)
  g.computeBoundingSphere()
  return g
}

export function useTurbineModel(): TurbineModel {
  const { scene } = useGLTF(TURBINE_GLB_URL)
  return useMemo(() => {
    scene.updateMatrixWorld(true)
    const tower = bakedGeometry(scene, 'Tower')
    const shell = bakedGeometry(scene, 'NacelleShell')
    const rotor = bakedGeometry(scene, 'Rotor', HUB)
    const body = mergeGeometries([tower, shell])
    if (!body) throw new Error('turbine.glb: cannot merge body')
    return {
      body: [body, bakedGeometry(scene, 'Body_LOD1')],
      rotor: [rotor, bakedGeometry(scene, 'Rotor_LOD1', HUB)],
      hero: { tower, shell, internals: bakedGeometry(scene, 'Internals'), rotor },
    }
  }, [scene])
}

useGLTF.preload(TURBINE_GLB_URL)
