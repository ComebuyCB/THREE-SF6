import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { SitSpot } from './sitSpot.js'
import { HideSpot } from './hideSpot.js'

/**
 * Environment：3D 場景模型與場景裡的物件（跟玩法無關）
 *
 * scenes：場景名稱 → 設定
 *   model = GLB；null = 沒有場景模型
 *   ground = 地面平面 y = a·x + b·z + c（模型原始座標，公尺），載入後轉平、對齊 y = 0，角色才會剛好站在地上
 *   transform = 預設擺放 { x, y, z, rotation（度）, scale }（setScene 時套用，之後可用 setTransform 調）
 *   props = 放在場景裡的物件（世界座標，不跟 transform 移動）：{ type, ...options }，type 對到 propTypes（sit = SitSpot、hide = HideSpot）
 *   其他欄位（例如打鬥場地寬度）原樣留給使用的人讀（entry）
 *
 * 模型外層 Group 管轉動、位移、大小（setTransform），內層把地面平面轉平；同一個場景模型只載入一次（快取）
 * onModelChange(model, entry)：場景模型換好時呼叫（沒有模型 = null）；載入期間又切到別的場景就不呼叫
 */
export class Environment {
  constructor(options) {
    const def = {
      scene: null,
      scenes: {},
      propTypes: { sit: SitSpot, hide: HideSpot }, // 物件種類 → class（建構參數：{ scene, ...options }）
      onPropsChange: null, // (props) → 換場景、物件換好時（例如把實心的物件交給 Terrain 當碰撞物件）
      onMaterial: null, // (material) → 載入的模型每個材質（例如 Sky.patchMaterial 讓霧融進天空）
      onModelChange: null, // (model, entry)
      onLoadStart: null, // (name)
      onProgress: null, // (event, name)
      onLoadEnd: null, // (name)
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
    this.name = null // 目前的場景
    this.model = null // 目前的場景模型（Group）
    this.props = [] // 目前場景裡的物件
    this.transform = { x: 0, y: 0, z: 0, rotation: 0, scale: 1 }
    this.cache = {} // 場景名稱 → Promise<Group | null>
    this.raycaster = new THREE.Raycaster()
  }

  // public

  /** 目前場景的設定 */
  get entry() {
    return this.scenes[this.name] ?? null
  }

  /**
   * 切換場景：套用預設擺放、換物件、載入（或從快取拿）場景模型
   * @returns {Promise<THREE.Group | null>} 場景模型換好（沒有模型 / 載入失敗 / 中途又換場景 = null）
   */
  async setScene(name) {
    const entry = this.scenes[name]
    if (!entry) return null
    this.name = name
    this.transform = { x: 0, y: 0, z: 0, rotation: 0, scale: 1, ...entry.transform }
    this._setProps(entry.props)

    if (!entry.model) {
      this._swapModel(null)
      this.onModelChange?.(null, entry)
      return null
    }
    this.cache[name] ??= this._load(name, entry)
    const group = await this.cache[name]
    if (!group || this.name !== name) return null // 載入失敗，或載入期間又切到別的場景
    this._swapModel(group)
    this.onModelChange?.(group, entry)
    return group
  }

  /** 場景模型的擺放：水平轉動（度，繞場地中心）、位移、大小（只給要改的欄位） */
  setTransform(transform) {
    Object.assign(this.transform, transform)
    this._applyTransform()
  }

  /**
   * 從 origin 往 dirs 各方向、在 heights 各高度發射線，回傳最近碰到場景模型的距離（沒碰到 / 沒有模型 = Infinity）
   * 例如格鬥場地：從中心往左右找最近的牆
   */
  getWallDistance({ origin = new THREE.Vector3(), dirs = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(-1, 0, 0)], heights = [1], maxDistance = Infinity } = {}) {
    if (!this.model) return Infinity
    this.model.updateMatrixWorld(true)
    const ray = this.raycaster
    ray.far = maxDistance
    const from = new THREE.Vector3()
    let distance = Infinity
    heights.forEach(h => {
      dirs.forEach(dir => {
        ray.set(from.set(origin.x, origin.y + h, origin.z), dir)
        const hit = ray.intersectObject(this.model, true).find(item => item.object.visible)
        if (hit) distance = Math.min(distance, hit.distance)
      })
    })
    return distance
  }

  // internal

  _swapModel(group) {
    const scene = this.scene
    if (this.model && this.model !== group) scene.remove(this.model)
    this.model = group
    if (group) {
      scene.add(group)
      this._applyTransform()
    }
  }

  _applyTransform() {
    if (!this.model) return
    const { x, y, z, rotation, scale } = this.transform
    this.model.rotation.y = THREE.MathUtils.degToRad(rotation)
    this.model.position.set(x, y, z)
    this.model.scale.setScalar(scale)
  }

  /** 換場景時換物件：拿掉舊的，照場景設定放新的 */
  _setProps(props = []) {
    this.props.forEach(prop => prop.dispose())
    this.props = props
      .filter(p => this.propTypes[p.type])
      .map(({ type, ...options }) => new this.propTypes[type]({ scene: this.scene, ...options }))
    this.onPropsChange?.(this.props)
  }

  /**
   * 載入場景模型：外層 Group 管擺放，內層把地面平面轉平、往下移到 y = 0
   * @returns {Promise<THREE.Group | null>} 載入失敗回傳 null（之後再選一次會重新載入）
   */
  async _load(name, { model, ground = [0, 0, 0] }) {
    this.onLoadStart?.(name)
    try {
      const gltf = await new GLTFLoader().loadAsync(model, e => this.onProgress?.(e, name))
      gltf.scene.traverse(obj => {
        if (!obj.isMesh) return
        obj.receiveShadow = true
        ;[obj.material].flat().forEach(material => this.onMaterial?.(material))
      })
      const [a, b, c] = ground
      const level = new THREE.Group()
      // 平面 y = a·x + b·z + c 的法線 (-a, 1, -b) 轉到正上方，平面上 (0, c, 0) 那點移到原點
      level.quaternion.setFromUnitVectors(new THREE.Vector3(-a, 1, -b).normalize(), new THREE.Vector3(0, 1, 0))
      level.position.set(0, c, 0).applyQuaternion(level.quaternion).negate()
      level.add(gltf.scene)
      const group = new THREE.Group()
      group.add(level)
      return group
    } catch (err) {
      console.warn(`[Environment] 場景模型 ${model} 載入失敗`, err)
      delete this.cache[name]
      return null
    } finally {
      this.onLoadEnd?.(name)
    }
  }
}
