import * as THREE from 'three'
import { InteractiveProp } from './interactiveProp.js'

/**
 * HideSpot：可以躲進去的物件（例如櫃子 locker_rough_texture.glb）
 * - 門的動畫：模型自帶的片段前半段開門（0 ~ openTime 秒）、後半段關門（openTime ~ 結尾）
 *   openDoor / closeDoor 照當下狀態接著播，doorState：'closed' | 'opening' | 'open' | 'closing'
 * - 位置：frontPoint = 門前站的位置、insidePoint = 躲進去站的位置（世界座標，地面高度）、facing = 門朝的方向（角色出來時面向）
 * - 躲進去 / 出來的走位由 freeMode.js 控制（hideIn / leaveHide）
 * - 櫃子是實心的：main.js 把 group 加進 Terrain 的碰撞物件，人物撞得到、推得出來
 */
export class HideSpot extends InteractiveProp {
  static defaults = {
    height: 2.1, // 櫃子高度（公尺）
    radius: 1.6,
    labels: { use: '躲藏', leave: '離開' },
    glow: { emissive: 0x9fb4c8, emissiveIntensity: 0.35 },
    frontAxis: [1, 0, 0], // 模型裡門朝的方向（這個模型的門在 +x 那面）
    facing: 0, // 門朝世界的哪個方向（度，0 = +z、90 = +x；同人物的 rotation.y），會自動轉過去（rotation 不用填）
    openTime: 0.81, // 動畫裡門完全打開的時間（秒）
    frontGap: 0.55, // 門前站的位置離櫃子正面多遠（公尺）
    promptY: 0.8, // 按鍵提示在櫃子正面中間、離地多高（公尺；櫃子 2.1 公尺，中間偏下）
  }

  /** 互動種類（main.js 依這個決定按 F 做什麼） */
  get kind() {
    return 'hide'
  }

  init() {
    // 門朝 facing：模型的 frontAxis 轉到世界的 (sin f, 0, cos f)
    const [ax, , az] = this.frontAxis
    const f = THREE.MathUtils.degToRad(this.facing)
    this.group.rotation.y = f - Math.atan2(ax, az)
    this.doorState = 'closed'
    this.doorTime = 0
    this.doorAction = null
    this.insidePoint = new THREE.Vector3()
    this.frontPoint = new THREE.Vector3()
    this.frontFace = new THREE.Vector3() // 櫃子正面的中心（地面高度）
    super.init()
  }

  onLoaded(gltf) {
    const clip = gltf.animations[0]
    if (clip) {
      this.doorAction = this.mixer.clipAction(clip)
      this.doorAction.play()
      this.doorAction.paused = true // 時間由 _updateDoor 控制
      this.doorEnd = clip.duration
      this._setDoorTime(0)
    }
    // 站的位置：櫃子本體（門關著時）的中心、門前 frontGap
    this.group.updateMatrixWorld(true)
    const box = new THREE.Box3().setFromObject(this.model)
    const center = box.getCenter(new THREE.Vector3())
    this.insidePoint.set(center.x, this.group.position.y, center.z)
    const front = this.frontDir
    const depth = Math.abs(front.x) * (box.max.x - box.min.x) + Math.abs(front.z) * (box.max.z - box.min.z)
    this.frontFace.copy(this.insidePoint).addScaledVector(front, depth / 2)
    this.frontPoint.copy(this.frontFace).addScaledVector(front, this.frontGap)
  }

  // public

  /** 門朝的方向（世界、水平單位向量） */
  get frontDir() {
    const f = THREE.MathUtils.degToRad(this.facing)
    return new THREE.Vector3(Math.sin(f), 0, Math.cos(f))
  }

  /** 互動的距離從門前算（不是櫃子中心） */
  isNear(fighter) {
    if (!this.isLoaded || !fighter) return false
    const p = fighter.model.position
    return Math.hypot(p.x - this.frontPoint.x, p.z - this.frontPoint.z) <= this.radius
  }

  /** 按鍵提示：櫃子正面中間、離地 promptY（中間偏下） */
  getPromptPoint(target = new THREE.Vector3()) {
    target.copy(this.frontFace)
    target.y += this.promptY
    return target
  }

  /** 提示文字：isUsing = 躲在裡面 */
  getLabel(isUsing) {
    return isUsing ? this.labels.leave : this.labels.use
  }

  openDoor() {
    if (this.doorState === 'open' || this.doorState === 'opening') return
    // 關到一半又要開：從對應的開門位置接著開
    if (this.doorState === 'closing') this._setDoorTime(this.doorEnd - this.doorTime)
    this.doorState = 'opening'
  }

  closeDoor() {
    if (this.doorState === 'closed' || this.doorState === 'closing') return
    if (this.doorState === 'opening') this._setDoorTime(this.doorEnd - this.doorTime)
    else this._setDoorTime(this.openTime)
    this.doorState = 'closing'
  }

  get isDoorOpen() {
    return this.doorState === 'open'
  }

  get isDoorClosed() {
    return this.doorState === 'closed'
  }

  update(delta, focus) {
    this._updateDoor(delta)
    super.update(delta, focus)
  }

  // internal

  _updateDoor(delta) {
    if (!this.doorAction) {
      if (this.doorState === 'opening') this.doorState = 'open'
      if (this.doorState === 'closing') this.doorState = 'closed'
      return
    }
    if (this.doorState === 'opening') {
      this._setDoorTime(Math.min(this.openTime, this.doorTime + delta))
      if (this.doorTime >= this.openTime) this.doorState = 'open'
    } else if (this.doorState === 'closing') {
      this._setDoorTime(Math.min(this.doorEnd, this.doorTime + delta))
      if (this.doorTime >= this.doorEnd) {
        this.doorState = 'closed'
        this._setDoorTime(0)
      }
    }
  }

  _setDoorTime(time) {
    this.doorTime = time
    if (!this.doorAction) return
    this.doorAction.time = time
    this.mixer.update(0)
  }
}
