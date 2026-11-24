import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'

/**
 * InteractiveProp：場景裡可以互動的物件（跟玩法無關；營火 SitSpot、櫃子 HideSpot 都繼承這個）
 * - 載入 GLB、放在世界座標 position；有給 height 時自動縮放到這個高度、底部貼地
 * - 角色走到 radius 公尺內（isNear）：物件發亮（材質自發光；lightIntensity > 0 時再加點光源），上方顯示按鍵提示（F + label）
 * - 子類別在 onLoaded(gltf) 做自己的事（例如播動畫、記下門的位置）
 * 提示框（#interactPrompt）全場共用：只有正在顯示提示的物件會把它藏起來，多個物件不會互相蓋掉
 */
export class InteractiveProp {
  constructor(options) {
    const def = {
      scene: null, // THREE.Scene
      url: '',
      position: [0, 0, 0], // 世界座標（公尺）；y = 0 是地面
      rotation: 0, // 水平轉動（度）
      scale: 1,
      height: null, // 有給：縮放到這個高度（公尺），底部貼地（scale 不用）
      radius: 1.8, // 互動距離（公尺，水平距離）
      promptEl: '#interactPrompt',
      promptHeight: 0.3, // 提示在物件頂端上方多高（公尺）
      // 發亮：點光源（lightIntensity 0 = 不加燈），材質自發光的顏色與強度，淡入淡出速度（每秒）
      glow: { color: 0xffffff, lightIntensity: 0, lightDistance: 4, emissive: 0x666666, emissiveIntensity: 0.5, emissiveBoost: 0.8, speed: 6 },
    }

    // 1. merge options（子類別的預設值從 this.defaults 來，使用的人給的 options 優先）
    const defaults = this.constructor.defaults ?? {}
    Object.keys(defaults).forEach(k => {
      if (def[k]?.constructor === Object && defaults[k]?.constructor === Object) Object.assign(def[k], defaults[k])
      else def[k] = defaults[k]
    })
    Object.keys(def).forEach(k => {
      if (def[k]?.constructor === Object) {
        def[k] = { ...def[k], ...options?.[k] }
      } else if (options?.[k] !== undefined) {
        def[k] = options[k]
      }
    })

    // 2. assign public config
    Object.assign(this, def)

    // 3. setup DOM cache
    this.promptEl = document.querySelector(def.promptEl)
    this.promptTextEl = this.promptEl?.querySelector('.js-prompt-text')

    // 4. setup runtime state
    this.group = new THREE.Group()
    this.group.position.fromArray(this.position)
    this.group.rotation.y = THREE.MathUtils.degToRad(this.rotation)
    this.group.scale.setScalar(this.scale)
    this.model = null
    this.mixer = null
    this.materials = [] // { material, emissive（原本的顏色）, intensity（原本的強度）, hasMap }
    this.light = null
    this.top = 1 // 物件高度（公尺，載入後量）
    this.glowLevel = 0 // 0 ~ 1：目前發亮程度
    this.isShowingPrompt = false
    this.isLoaded = false
    this.isDisposed = false
    this._screen = new THREE.Vector3()

    // 5. init
    this.init()
  }

  init() {
    this.scene.add(this.group)
    this.load()
  }

  async load() {
    try {
      const gltf = await new GLTFLoader().loadAsync(this.url)
      if (this.isDisposed) return
      this.model = gltf.scene
      gltf.scene.traverse(obj => {
        if (!obj.isMesh) return
        obj.castShadow = true
        obj.receiveShadow = true
        ;[obj.material].flat().forEach(material => {
          if (!material.emissive) return
          this.materials.push({ material, emissive: material.emissive.clone(), intensity: material.emissiveIntensity, hasMap: !!material.emissiveMap })
        })
      })
      if (this.height) this._fitHeight(gltf.scene)
      this.group.add(gltf.scene)
      this.group.updateMatrixWorld(true)
      this.top = new THREE.Box3().setFromObject(gltf.scene).max.y - this.group.position.y

      const { color, lightIntensity, lightDistance } = this.glow
      if (lightIntensity > 0) {
        this.light = new THREE.PointLight(color, 0, lightDistance)
        this.light.position.set(0, (this.top * 0.5) / this.group.scale.y, 0)
        this.group.add(this.light)
      }
      if (gltf.animations.length) this.mixer = new THREE.AnimationMixer(gltf.scene)
      this.onLoaded(gltf)
      this.isLoaded = true
    } catch (err) {
      console.warn(`[${this.constructor.name}] ${this.url} 載入失敗`, err)
    }
  }

  /** 子類別：載入完成（gltf.scene 已放進 group、量好高度） */
  onLoaded() {}

  // public

  /** 世界座標（地面上的位置） */
  get worldPosition() {
    return this.group.position
  }

  /** 按鍵提示放在哪裡（世界座標）：預設在物件頂端上方 promptHeight；子類別可以改 */
  getPromptPoint(target = new THREE.Vector3()) {
    target.copy(this.group.position)
    target.y += this.top + this.promptHeight
    return target
  }

  /** 人物（腳底）是否在互動距離內 */
  isNear(fighter) {
    if (!this.isLoaded || !fighter) return false
    const p = fighter.model.position
    return Math.hypot(p.x - this.group.position.x, p.z - this.group.position.z) <= this.radius
  }

  /**
   * 每個畫面更新：動畫、發亮、提示
   * @param {number} delta 遊戲時間（秒）
   * @param {{ isActive: boolean, label: string, camera: THREE.Camera }} focus isActive = 要發亮、顯示提示；label = 提示文字；camera = 算提示的螢幕位置
   */
  update(delta, { isActive = false, label = '', camera = null } = {}) {
    this.mixer?.update(delta)
    if (!this.isLoaded) return

    const target = isActive ? 1 : 0
    const k = 1 - Math.exp(-this.glow.speed * delta)
    this.glowLevel += (target - this.glowLevel) * (delta > 0 ? k : 1)
    if (Math.abs(target - this.glowLevel) < 0.001) this.glowLevel = target
    this._applyGlow(this.glowLevel)
    this._updatePrompt(isActive && !!camera, label, camera)
  }

  /** 從場景拿掉（換場景時） */
  dispose() {
    this.isDisposed = true
    this.scene.remove(this.group)
    this.mixer?.stopAllAction()
    if (this.isShowingPrompt) this._setPromptVisible(false)
  }

  // internal

  /** 縮放到 height 公尺高、底部貼地（模型原點不在底部也沒關係） */
  _fitHeight(object) {
    object.updateMatrixWorld(true)
    const box = new THREE.Box3().setFromObject(object)
    const size = box.max.y - box.min.y
    if (size <= 0) return
    const s = this.height / size
    object.scale.multiplyScalar(s)
    object.position.y -= box.min.y * s
  }

  /** 發亮：點光源亮度、材質自發光（本來就會發光的加強，其餘疊上 glow.emissive） */
  _applyGlow(level) {
    const { lightIntensity, emissive, emissiveIntensity, emissiveBoost } = this.glow
    if (this.light) this.light.intensity = lightIntensity * level
    this.materials.forEach(m => {
      if (m.hasMap) {
        m.material.emissiveIntensity = m.intensity * (1 + emissiveBoost * level)
        return
      }
      m.material.emissive.copy(m.emissive).lerp(_glowColor.set(emissive), level)
      m.material.emissiveIntensity = THREE.MathUtils.lerp(m.intensity, emissiveIntensity, level)
    })
  }

  /** 按鍵提示：物件頂端上方，換算成螢幕座標寫進 --x / --y */
  _updatePrompt(isActive, label, camera) {
    if (!this.promptEl) return
    if (!isActive) {
      if (this.isShowingPrompt) this._setPromptVisible(false)
      return
    }
    const p = this.getPromptPoint(this._screen)
    p.project(camera)
    const isBehind = p.z > 1
    this._setPromptVisible(!isBehind)
    if (isBehind) return
    this.promptEl.style.setProperty('--x', `${((p.x + 1) / 2) * 100}%`)
    this.promptEl.style.setProperty('--y', `${((1 - p.y) / 2) * 100}%`)
    if (this.promptTextEl && this.promptTextEl.textContent !== label) this.promptTextEl.textContent = label
  }

  _setPromptVisible(isVisible) {
    this.isShowingPrompt = isVisible
    if (this.promptEl && this.promptEl.hidden === isVisible) this.promptEl.hidden = !isVisible
  }
}

const _glowColor = new THREE.Color()
