import * as THREE from 'three'

/**
 * OrbitCamera：環繞鏡頭（跟玩法無關）
 * 鏡頭繞著注視點轉一整圈（慢進慢出），前 pullTime 秒拉遠到 pullScale 倍、最後 returnTime 秒拉回，轉完剛好回到原本的位置
 * 開始時從目前畫面上的鏡頭（from）過渡到環繞的路線，不會跳一下
 */
export class OrbitCamera {
  constructor(options) {
    const def = {
      camera: null,
      controls: null, // OrbitControls：環繞中停用，結束時 onEnd 決定要不要打開
      duration: 3, // 繞一整圈的秒數（不受遊戲速度影響）
      pullTime: 0.5,
      returnTime: 0.5,
      pullScale: 1.8,
      getCenter: null, // (baseTarget) → 每個畫面的注視點（例如跟著角色移動）；沒給 = 固定在 baseTarget
      onEnd: null, // 結束後呼叫（例如決定 controls.enabled）
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
    this.orbit = null // 環繞中：{ time, target, offset, fromPos, fromTarget }
  }

  // public

  get isActive() {
    return !!this.orbit
  }

  /**
   * 開始環繞
   * @param {{ target: THREE.Vector3, offset: THREE.Vector3 }} base 要繞的一般鏡頭（注視點、鏡頭相對注視點的位置）；結束後回到這裡
   * @param {{ pos: THREE.Vector3, target: THREE.Vector3 }} from 目前畫面上的鏡頭
   */
  start(base, from) {
    if (this.orbit) return
    this.orbit = { time: 0, target: base.target.clone(), offset: base.offset.clone(), fromPos: from.pos.clone(), fromTarget: from.target.clone() }
    this.controls.enabled = false
  }

  /** 每個畫面（真實時間） */
  update(delta) {
    const o = this.orbit
    if (!o) return
    const { duration, pullTime, returnTime, pullScale } = this
    o.time += delta
    const smooth = t => t * t * (3 - 2 * t)
    const easeInOut = t => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2)
    const angle = Math.PI * 2 * easeInOut(Math.min(1, o.time / duration))
    const pullOut = smooth(Math.min(1, o.time / pullTime))
    const pullBack = smooth(THREE.MathUtils.clamp((duration - o.time) / returnTime, 0, 1))
    const scale = 1 + (pullScale - 1) * Math.min(pullOut, pullBack)

    const target = this._getCenter(o.target)
    const offset = o.offset.clone().applyAxisAngle(THREE.Object3D.DEFAULT_UP, angle).multiplyScalar(scale)
    const pos = target.clone().add(offset)
    this.camera.position.lerpVectors(o.fromPos, pos, pullOut)
    this.controls.target.lerpVectors(o.fromTarget, target, pullOut)
    this.camera.lookAt(this.controls.target)

    if (o.time >= duration) this.end()
  }

  /** 結束：回到開始時的一般鏡頭（注視點照 getCenter） */
  end() {
    const o = this.orbit
    if (!o) return
    const target = this._getCenter(o.target)
    this.camera.position.copy(target).add(o.offset)
    this.controls.target.copy(target)
    this.orbit = null
    this.onEnd?.()
  }

  // internal

  _getCenter(base) {
    return this.getCenter ? this.getCenter(base.clone()) : base.clone()
  }
}
