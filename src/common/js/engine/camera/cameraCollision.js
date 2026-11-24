import * as THREE from 'three'
import { Terrain } from '../world/terrain.js'

/**
 * CameraCollision：鏡頭避開物體（跟玩法無關）
 * 渲染前從注視點往鏡頭發射線，被場景模型擋住就把鏡頭拉近到擋住的地方前面（留 margin，最近 minDist）
 * 擋住時慢慢拉近（pullSpeed）、沒擋住時慢慢退回原本的距離（returnSpeed）；渲染後 restore 還原，OrbitControls 的距離不變
 */
export class CameraCollision {
  constructor(options) {
    const def = {
      camera: null,
      getTarget: null, // () → 注視點（Vector3）
      getEnv: null, // () → 場景模型（null = 不用避開）
      margin: 0.25, // 離物體留多遠（公尺）
      minDist: 0.6, // 最近拉到多近（公尺）
      pullSpeed: 6, // 被擋住時拉近的快慢（越大越快；Infinity = 立刻拉近，不會穿進物體）
      returnSpeed: 4, // 沒擋住時退回原本距離的快慢
    }

    // 1. merge options
    Object.keys(def).forEach(k => {
      if (def[k]?.constructor === Object) {
        Object.assign(def[k], options?.[k])
      } else if (options?.[k] !== undefined) {
        def[k] = options[k]
      }
    })

    // 2. assign public config
    Object.assign(this, def)

    // 4. setup runtime state
    this.isEnabled = false
    this.dist = Infinity // 目前畫面用的鏡頭距離（平滑變化）
    this.isApplied = false
    this.savedPos = new THREE.Vector3()
    this.raycaster = new THREE.Raycaster()
    this.raycaster.firstHitOnly = true
  }

  // public

  /** 開關；打開時替場景模型建 BVH，射線才夠快 */
  setEnabled(isOn) {
    this.isEnabled = isOn
    this.dist = Infinity
    const env = this.getEnv?.()
    if (isOn && env) Terrain.buildBVH(env)
  }

  /**
   * 渲染前：鏡頭被擋住就拉近（delta = 真實時間）
   * @param {boolean} isSkip 這個畫面不用避開（例如第一人稱鏡頭在眼睛）
   */
  apply(delta, isSkip = false) {
    this.isApplied = false
    const env = this.getEnv?.()
    if (!this.isEnabled || !env || isSkip) return
    const target = this.getTarget()
    const dir = this.camera.position.clone().sub(target)
    const full = dir.length()
    if (full < 1e-4) return
    dir.divideScalar(full)

    Terrain.buildBVH(env) // 換場景後第一次用到時建（已建過會跳過）
    const ray = this.raycaster
    ray.far = full
    ray.set(target, dir)
    const hit = ray.intersectObject(env, true).find(item => item.object.visible)
    const goal = hit ? Math.max(this.minDist, hit.distance - this.margin) : full

    // 拉近、退回都平滑靠近目標距離（指數趨近，跟畫面更新率無關）
    this.dist = Math.min(this.dist, full)
    const speed = goal < this.dist ? this.pullSpeed : this.returnSpeed
    this.dist += (goal - this.dist) * (1 - Math.exp(-speed * delta))
    if (this.dist >= full - 1e-3) return
    this.savedPos.copy(this.camera.position)
    this.camera.position.copy(target).addScaledVector(dir, this.dist)
    this.isApplied = true
  }

  /** 渲染後：還原鏡頭位置 */
  restore() {
    if (this.isApplied) this.camera.position.copy(this.savedPos)
  }
}
