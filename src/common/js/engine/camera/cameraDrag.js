import * as THREE from 'three'

/** pos 繞 target 轉 yaw（水平）、pitch（垂直，限制在頭頂 ~ 腳底之間），直接改 pos 並回傳 */
export function rotateAround(pos, target, yaw, pitch) {
  if (!yaw && !pitch) return pos
  const sph = new THREE.Spherical().setFromVector3(pos.sub(target))
  sph.theta += yaw
  sph.phi = THREE.MathUtils.clamp(sph.phi + pitch, 0.05, Math.PI - 0.05)
  return pos.setFromSpherical(sph).add(target)
}

/**
 * CameraDrag：鏡頭由程式控制中（例如演出鏡頭，OrbitControls 停用）時，滑鼠左鍵拖曳照樣能轉（跟玩法無關）
 * - 拖曳的角度只疊在畫面上：渲染前 apply、渲染後 restore，程式算的鏡頭不受影響
 * - 程式不再控制鏡頭且放開滑鼠：角度直接併進一般鏡頭（不還原），之後交給 OrbitControls
 * 轉動速度同 OrbitControls：拖曳畫面高度 = 轉一圈
 */
export class CameraDrag {
  constructor(options) {
    const def = {
      camera: null,
      canvas: null,
      getTarget: null, // () → 注視點（Vector3）
      isLocked: null, // () → 鏡頭是不是由程式控制中（只有這時候拖曳才由這裡處理）
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
    this.isDragging = false
    this.x = 0
    this.y = 0
    this.yaw = 0 // 疊在畫面上的角度（弧度）
    this.pitch = 0
    this.isApplied = false
    this.savedPos = new THREE.Vector3()
    this.savedQuat = new THREE.Quaternion()

    // 5. init
    this.init()
  }

  init() {
    this.bindEvents()
  }

  bindEvents() {
    const canvas = this.canvas
    canvas.addEventListener('pointerdown', e => {
      if (e.button !== 0 || !this.isLocked()) return
      Object.assign(this, { isDragging: true, x: e.clientX, y: e.clientY })
      canvas.setPointerCapture(e.pointerId)
    })
    canvas.addEventListener('pointermove', e => {
      if (!this.isDragging) return
      const rate = (Math.PI * 2) / canvas.clientHeight
      this.yaw -= (e.clientX - this.x) * rate
      this.pitch -= (e.clientY - this.y) * rate
      this.x = e.clientX
      this.y = e.clientY
    })
    const endDrag = () => { this.isDragging = false }
    canvas.addEventListener('pointerup', endDrag)
    canvas.addEventListener('pointercancel', endDrag)
  }

  // public

  /**
   * 把拖曳的角度拿走（例如開始另一種鏡頭時，從畫面上看到的位置接著開始）
   * @returns {THREE.Vector3} 套用拖曳角度後的鏡頭位置
   */
  takeRotatedPosition() {
    const pos = rotateAround(this.camera.position.clone(), this.getTarget().clone(), this.yaw, this.pitch)
    this.yaw = 0
    this.pitch = 0
    return pos
  }

  /** 渲染前：把拖曳的角度疊在目前鏡頭上 */
  apply() {
    this.isApplied = false
    if (!this.yaw && !this.pitch) return
    const isBake = !this.isLocked() && !this.isDragging
    if (!isBake) {
      this.savedPos.copy(this.camera.position)
      this.savedQuat.copy(this.camera.quaternion)
      this.isApplied = true
    }
    const target = this.getTarget()
    rotateAround(this.camera.position, target, this.yaw, this.pitch)
    this.camera.lookAt(target)
    if (isBake) {
      this.yaw = 0
      this.pitch = 0
    }
  }

  /** 渲染後：還原成程式算的鏡頭 */
  restore() {
    if (!this.isApplied) return
    this.camera.position.copy(this.savedPos)
    this.camera.quaternion.copy(this.savedQuat)
  }
}
