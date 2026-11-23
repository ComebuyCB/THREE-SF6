import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'

/**
 * SitSpot：場景裡可以坐下的物件（例如營火 animated_fire.glb）
 * - 載入 GLB、放在世界座標 position，自帶的動畫一直循環播放（格鬥 / 自由模式都會動）
 * - 自由模式中，P1 走到 radius 公尺內：物件發亮（點光源 + 材質自發光變亮），上方顯示按鍵提示（F 坐下 / 起身）
 * - 坐下 / 起身的動作由 freeMode.js 控制（sitDown / standUp），這裡只負責物件本身與提示
 * 之後不需要時：main.js 的場景設定拿掉 props、刪掉這個檔案與 index.html 的 #interactPrompt 即可
 */
export class SitSpot {
  constructor(options) {
    const def = {
      scene: null, // THREE.Scene
      url: '',
      position: [0, 0, 0], // 世界座標（公尺）；y = 0 是地面
      rotation: 0, // 水平轉動（度）
      scale: 1,
      radius: 1.8, // 互動距離（公尺，水平距離）
      promptEl: '#interactPrompt',
      promptHeight: 0.3, // 提示在物件頂端上方多高（公尺）
      labels: { sit: '坐下', stand: '起身' },
      // 發亮：點光源顏色、亮度（靠近時），材質自發光的顏色與強度，淡入淡出速度（每秒）
      glow: { color: 0xff8a3d, lightIntensity: 6, lightDistance: 4, emissive: 0xff7a2a, emissiveIntensity: 0.6, emissiveBoost: 0.8, speed: 6 },
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

    // 3. setup DOM cache
    this.promptEl = document.querySelector(def.promptEl)
    this.promptTextEl = this.promptEl?.querySelector('.js-prompt-text')

    // 4. setup runtime state
    this.group = new THREE.Group()
    this.group.position.fromArray(this.position)
    this.group.rotation.y = THREE.MathUtils.degToRad(this.rotation)
    this.group.scale.setScalar(this.scale)
    this.mixer = null
    this.materials = [] // { material, emissive（原本的顏色）, intensity（原本的強度）, hasMap }
    this.light = null
    this.top = 1 // 物件高度（公尺，載入後量）
    this.glowLevel = 0 // 0 ~ 1：目前發亮程度
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
      gltf.scene.traverse(obj => {
        if (!obj.isMesh) return
        obj.castShadow = true
        ;[obj.material].flat().forEach(material => {
          if (!material.emissive) return
          this.materials.push({ material, emissive: material.emissive.clone(), intensity: material.emissiveIntensity, hasMap: !!material.emissiveMap })
        })
      })
      this.group.add(gltf.scene)
      this.top = new THREE.Box3().setFromObject(gltf.scene).max.y - this.group.position.y

      const { color, lightDistance } = this.glow
      this.light = new THREE.PointLight(color, 0, lightDistance)
      this.light.position.set(0, this.top * 0.5 / this.scale, 0)
      this.group.add(this.light)

      if (gltf.animations.length) {
        this.mixer = new THREE.AnimationMixer(gltf.scene)
        gltf.animations.forEach(clip => this.mixer.clipAction(clip).play())
      }
      this.isLoaded = true
    } catch (err) {
      console.warn(`[SitSpot] ${this.url} 載入失敗`, err)
    }
  }

  // public

  /** 世界座標（地面上的位置） */
  get worldPosition() {
    return this.group.position
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
   * @param {{ isActive: boolean, isSitting: boolean, camera: THREE.Camera }} focus isActive = 要發亮、顯示提示；isSitting = 提示改成「起身」；camera = 算提示的螢幕位置
   */
  update(delta, { isActive = false, isSitting = false, camera = null } = {}) {
    this.mixer?.update(delta)
    if (!this.isLoaded) return

    const target = isActive ? 1 : 0
    const k = 1 - Math.exp(-this.glow.speed * delta)
    this.glowLevel += (target - this.glowLevel) * (delta > 0 ? k : 1)
    if (Math.abs(target - this.glowLevel) < 0.001) this.glowLevel = target
    this._applyGlow(this.glowLevel)
    this._updatePrompt(isActive && !!camera, isSitting, camera)
  }

  /** 從場景拿掉（換場景時） */
  dispose() {
    this.isDisposed = true
    this.scene.remove(this.group)
    this.mixer?.stopAllAction()
    this._setPromptVisible(false)
  }

  // internal

  /** 發亮：點光源亮度、材質自發光（本來就會發光的火焰加強，其餘疊上暖色） */
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
  _updatePrompt(isActive, isSitting, camera) {
    if (!this.promptEl) return
    if (!isActive) {
      this._setPromptVisible(false)
      return
    }
    const p = this._screen.copy(this.group.position)
    p.y += this.top + this.promptHeight
    p.project(camera)
    const isBehind = p.z > 1
    this._setPromptVisible(!isBehind)
    if (isBehind) return
    this.promptEl.style.setProperty('--x', `${((p.x + 1) / 2) * 100}%`)
    this.promptEl.style.setProperty('--y', `${((1 - p.y) / 2) * 100}%`)
    const label = isSitting ? this.labels.stand : this.labels.sit
    if (this.promptTextEl && this.promptTextEl.textContent !== label) this.promptTextEl.textContent = label
  }

  _setPromptVisible(isVisible) {
    if (this.promptEl && this.promptEl.hidden === isVisible) this.promptEl.hidden = !isVisible
  }
}

const _glowColor = new THREE.Color()
