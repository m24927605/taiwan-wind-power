/**
 * URL of a baked model. Hosts that serve only web types (a claude.ai artifact, built with
 * `--mode artifact`) get the same model repackaged as a self-contained .gltf, which they serve as
 * JSON; everywhere else gets the compact binary .glb.
 */
export const modelUrl = (name: string) => `models/${name}.${import.meta.env.MODE === 'artifact' ? 'gltf' : 'glb'}`
