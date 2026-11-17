import * as THREE from 'three'

/**
 * 用程式替沒有表情的模型加上「嘴角上揚」的變形（morph target）
 * 模型沒有 Shape Key 也沒有臉部骨頭，只能直接推嘴角附近的頂點：
 * 以兩個嘴角為中心，往上（lift）、往外（outward）、往後（back）推，離嘴角越遠推越少（高斯衰減，半徑 radius）
 *
 * 座標是模型原始的網格座標（公尺、T-pose、面向 +Z），嘴角位置要對著貼圖上的嘴巴找，換模型就要重調
 * 只推臉的正面（z ≥ minZ），後腦勺不會被影響
 *
 * @param {THREE.Object3D} object 人物模型（載入後、clone 之前呼叫，clone 出來的人物都會帶著）
 * @param {{ corners: number[][], radius: number, lift: number, outward: number, back: number, minZ: number, influence: number }} smile
 */
export function addSmileMorph(object, { corners, radius, lift, outward = 0, back = 0, minZ = 0, influence = 1 }) {
  object.traverse(obj => {
    if (!obj.isSkinnedMesh) return
    const position = obj.geometry.attributes.position
    const deltas = new Float32Array(position.count * 3)
    let moved = 0

    for (let i = 0; i < position.count; i++) {
      const x = position.getX(i)
      const y = position.getY(i)
      if (position.getZ(i) < minZ) continue
      corners.forEach(([cx, cy]) => {
        const w = Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (radius * radius))
        if (w < 0.01) return
        deltas[i * 3] += Math.sign(cx) * outward * w
        deltas[i * 3 + 1] += lift * w
        deltas[i * 3 + 2] -= back * w
        moved++
      })
    }
    if (!moved) return

    // 相對位移（加在原本的位置上），影響力 0 ~ 1 由 morphTargetInfluences 控制
    obj.geometry.morphAttributes.position = [new THREE.Float32BufferAttribute(deltas, 3)]
    obj.geometry.morphTargetsRelative = true
    obj.updateMorphTargets()
    obj.morphTargetInfluences[0] = influence
  })
}
