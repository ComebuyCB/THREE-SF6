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
      // 烘焙好光影的模型（MeshBasicMaterial，不吃燈光、接不到影子）：疊一層只畫影子的網格，opacity = 影子最深多黑
      shadowCatcher: { enabled: true, opacity: 0.45 },
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
    // 陰影接收層的材質（依正反面各一個，共用）：只畫影子（其他地方透明），深淺由 setShadowStrength 調；不吃霧（影子只在人物附近）
    this.shadowMaterials = {} // side → ShadowMaterial
    this.shadowStrength = 1
    // 場景亮度（setLightLevel）：場景模型的材質共用這個 uniform，顏色乘上它（烘焙光影的場景不吃燈光，晚上要靠這個變暗）
    this.lightUniform = { value: 1 }
  }

  /** 場景模型的亮度倍率（1 = 原本的顏色）；例如晚上室外調暗，人物不受影響 */
  setLightLevel(value) {
    this.lightUniform.value = value
  }

  // public

  /** 烘焙光影場景上的影子深淺：0 = 沒有、1 = shadowCatcher.opacity（主光越弱越淡） */
  setShadowStrength(strength) {
    this.shadowStrength = strength
    Object.values(this.shadowMaterials).forEach(m => { m.opacity = this.shadowCatcher.opacity * strength })
  }

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

  /**
   * 把物件從目前場景的清單拿出來：換場景時不會被刪掉，還留在畫面上（例如傳送時先留著舊營火，新營火好了再刪）
   * 拿出來的物件之後要自己 update、dispose
   */
  detachProp(prop) {
    this.props = this.props.filter(p => p !== prop)
  }

  /** 先在背景載入場景模型（不切換）；之後 setScene 直接用快取 */
  preload(name) {
    const entry = this.scenes[name]
    if (entry?.model) this.cache[name] ??= this._load(name, entry)
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

  /** 不吃燈光的網格（MeshBasicMaterial）；半透明、鏤空的（樹葉、鐵絲網）不加影子層，不然整片都會有影子 */
  _isUnlit(mesh) {
    if (!this.shadowCatcher.enabled || mesh.isSkinnedMesh) return false
    return [mesh.material].flat().every(m => m.isMeshBasicMaterial && !m.transparent && !(m.alphaTest > 0))
  }

  /**
   * 陰影接收層：同一個形狀、只畫影子的網格，掛在原本網格底下（位置跟著）
   * 射線、碰撞都略過它（userData.isShadowCatcher；raycast 不做事）
   */
  _addShadowCatcher(mesh) {
    const catcher = new THREE.Mesh(mesh.geometry, this._getShadowMaterial([mesh.material].flat()[0].side))
    catcher.receiveShadow = true
    catcher.castShadow = false
    catcher.userData.isShadowCatcher = true
    catcher.raycast = () => {}
    catcher.renderOrder = 1 // 畫在場景之後（半透明疊上去）
    mesh.add(catcher)
  }

  /**
   * 場景亮度：材質的顏色（霧之前）乘上 lightUniform；接在原本的 onBeforeCompile（例如 Sky.patchMaterial 的霧）後面
   * 同一個材質只套一次（場景模型有快取，換回來不會再套）
   */
  _patchLight(material) {
    if (!material || material.userData.isLightPatched) return
    material.userData.isLightPatched = true
    const prevCompile = material.onBeforeCompile
    const prevKey = material.customProgramCacheKey
    material.onBeforeCompile = (shader, renderer) => {
      prevCompile?.call(material, shader, renderer)
      shader.uniforms.uEnvLight = this.lightUniform
      shader.fragmentShader = `uniform float uEnvLight;\n${shader.fragmentShader}`.replace(
        '#include <opaque_fragment>',
        '#include <opaque_fragment>\n\tgl_FragColor.rgb *= uEnvLight;',
      )
    }
    material.customProgramCacheKey = () => `${prevKey.call(material)}|envLight`
    material.needsUpdate = true
  }

  /** 陰影接收層的材質：跟原本網格同一面（場景常用雙面，只畫正面會被剔除） */
  _getShadowMaterial(side) {
    this.shadowMaterials[side] ??= new THREE.ShadowMaterial({ side, opacity: this.shadowCatcher.opacity * this.shadowStrength, depthWrite: false, fog: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 })
    return this.shadowMaterials[side]
  }

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
      .map(({ type, ...options }) => new this.propTypes[type]({ scene: this.scene, onMaterial: this.onMaterial, ...options }))
    this.onPropsChange?.(this.props)
  }

  /**
   * 載入場景模型：外層 Group 管擺放，內層把地面平面轉平、往下移到 y = 0
   * @returns {Promise<THREE.Group | null>} 載入失敗回傳 null（之後再選一次會重新載入）
   */
  async _load(name, { model, ground = [0, 0, 0], emissive = {} }) {
    this.onLoadStart?.(name)
    try {
      const gltf = await new GLTFLoader().loadAsync(model, e => this.onProgress?.(e, name))
      const unlit = []
      gltf.scene.traverse(obj => {
        if (!obj.isMesh) return
        obj.receiveShadow = true
        ;[obj.material].flat().forEach(material => {
          // emissive：名稱包含這個字的材質自己發光（例如天花板的燈片）
          const key = Object.keys(emissive).find(k => material.name.includes(k))
          if (key && material.emissive) material.emissive.set(emissive[key])
          this.onMaterial?.(material)
          this._patchLight(material)
        })
        if (this._isUnlit(obj)) unlit.push(obj)
      })
      unlit.forEach(obj => this._addShadowCatcher(obj)) // traverse 結束後才加，避免走訪到新加的
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
