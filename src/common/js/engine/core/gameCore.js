import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { Sky } from '../world/sky.js'
import { Environment } from '../world/environment.js'
import { Atmosphere } from '../world/atmosphere.js'
import { Fisheye } from '../render/fisheye.js'
import { CameraShake } from '../camera/cameraShake.js'
import { CameraCollision } from '../camera/cameraCollision.js'
import { CameraDrag } from '../camera/cameraDrag.js'

/**
 * GameCore：遊戲核心（跟玩法無關，每一關、每一種遊戲都共用；換關卡時這一層一直存在）
 *
 * 負責：
 * - 渲染器、場景、鏡頭、OrbitControls、視窗縮放
 * - 世界：天空與霧（Sky）、3D 場景模型與物件（Environment）、時間與天氣（Atmosphere）、基本燈光（環境光 + 主光，setDim 整體變暗）
 * - 鏡頭工具：晃動（cameraShaker）、避開物體（cameraCollision）、鏡頭由程式控制時滑鼠拖曳（cameraDrag）、魚眼後製（fisheye）
 * - 遊戲迴圈（start）：每個畫面依序
 *   1. hooks.onUpdate(realDelta)：遊戲邏輯、角色、鏡頭跟隨
 *   2. 鏡頭沒被程式鎖住時 OrbitControls 更新；天空、時間天氣更新
 *   3. hooks.onBeforeRender(realDelta)：HUD、只影響畫面的調整
 *   4. 只影響這個畫面的鏡頭調整（拖曳 → 避開物體 → 晃動）→ 渲染（魚眼打開時走後製）→ 反過來還原
 *   5. hooks.onAfterRender()：例如角色還原成邏輯幀的姿勢
 *
 * 遊戲端透過 hooks 接進來（都可以不給）：
 *   onUpdate、onBeforeRender、onAfterRender
 *   getGameDelta(realDelta) → 遊戲時間（暫停 / 慢動作）：晃鏡頭、時間天氣用；沒給 = realDelta
 *   isCameraLocked() → 鏡頭由程式控制中（OrbitControls 不更新、拖曳由 cameraDrag 處理）
 *   isFisheye() → 這個畫面要不要魚眼（例如第一人稱）
 *   skipCameraCollision() → 這個畫面鏡頭不用避開物體（例如第一人稱）
 *   getShadowFocus() → Vector3：影子範圍的中心（例如鏡頭跟隨的人）；沒給 = 原點
 *   onSceneModel(model, entry)、onPropsChange(props)：場景模型 / 物件換好時
 *   onLoadStart(name)、onProgress(event, name)、onLoadEnd(name)：場景模型載入進度
 */
export class GameCore {
  constructor(options) {
    const def = {
      el: null, // 放 canvas 的容器（選擇器或元素）
      background: 0x1b1d22, // 天空載入前的底色
      maxDelta: 0.1, // 一個畫面最多算幾秒（切分頁回來時不會一次補太多）
      skies: {}, // 天空設定（見 Sky）
      skyOptions: { rotation: 0, cloudCover: 0.5, horizonFog: { enabled: true, near: 15, far: 70 } }, // Sky 的設定
      atmosphere: {}, // Atmosphere 的設定（例如 time、isRunning、speed、weather）
      scenes: {}, // 場景設定（見 Environment）
      view: { fov: 45, near: 0.1, far: 100, position: [0, 1.4, 4.5], target: [0, 1, 0] }, // 鏡頭的視角與一開始的位置、注視點
      // 基本燈光：環境光、主光（會投影；陰影範圍 shadowHalfWidth × shadowHalfHeight 公尺）
      lights: { hemi: 2, dir: 2.5, dirPosition: [3, 6, 4], shadowMapSize: 2048, shadowHalfWidth: 9.5, shadowHalfHeight: 4 },
      cameraShake: { duration: 0.3, frequency: 30 },
      hooks: {
        onUpdate: null,
        onBeforeRender: null,
        onAfterRender: null,
        getGameDelta: null,
        isCameraLocked: null,
        isFisheye: null,
        skipCameraCollision: null,
        getShadowFocus: null,
        onSceneModel: null,
        onPropsChange: null,
        onLoadStart: null,
        onProgress: null,
        onLoadEnd: null,
      },
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
    this.container = typeof this.el === 'string' ? document.querySelector(this.el) : this.el

    // 4. setup runtime state
    this.clock = new THREE.Clock()
    this.isRunning = false
    this.dim = 1 // 整體亮度倍率（例如演出變暗）
    this.lightBase = { hemi: this.lights.hemi, dir: this.lights.dir } // 燈光基本亮度（時間天氣會改），實際亮度 = 基本 × dim

    // 5. init
    this.init()
  }

  init() {
    this._setupRenderer()
    this._setupWorld()
    this._setupCameraTools()
    this.bindEvents()
  }

  bindEvents() {
    window.addEventListener('resize', () => this.resize())
  }

  // public

  /** 目前的 3D 場景模型（沒有 = null） */
  get envModel() {
    return this.environment?.model ?? null
  }

  /** 開始遊戲迴圈 */
  start() {
    if (this.isRunning) return
    this.isRunning = true
    this.clock.getDelta()
    this._loop()
  }

  /** 整體亮度（1 = 正常）：環境光、主光、天空一起調整 */
  setDim(dim) {
    this.dim = dim
    this.lights.hemiLight.intensity = this.lightBase.hemi * dim
    this.lights.dirLight.intensity = this.lightBase.dir * dim
    this.sky.setIntensity(dim)
    // 烘焙光影的場景上的影子：主光越弱越淡（晚上、陰天），主光跟中午太陽一樣亮時最深
    this.environment.setShadowStrength(Math.min(1, this.lights.dirLight.intensity / this.lights.dir))
  }

  resize() {
    const width = window.innerWidth
    const height = window.innerHeight
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(width, height)
    this.fisheye.setSize(width, height)
  }

  // internal

  _setupRenderer() {
    this.renderer = new THREE.WebGLRenderer({ antialias: true })
    this.renderer.setPixelRatio(window.devicePixelRatio)
    this.renderer.setSize(window.innerWidth, window.innerHeight)
    this.renderer.shadowMap.enabled = true
    this.container.appendChild(this.renderer.domElement)

    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color(this.background)

    const { fov, near, far, position, target } = this.view
    this.camera = new THREE.PerspectiveCamera(fov, window.innerWidth / window.innerHeight, near, far)
    this.camera.position.fromArray(position)
    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.target.fromArray(target)
    this.controls.enableDamping = true
    this.fisheye = new Fisheye({ renderer: this.renderer, scene: this.scene, camera: this.camera })
  }

  _setupWorld() {
    const h = this.hooks
    // 天空與霧
    this.sky = new Sky({ scene: this.scene, skies: this.skies, ...this.skyOptions })
    // 3D 場景模型與物件：材質的霧融進天空貼圖
    this.environment = new Environment({
      scene: this.scene,
      scenes: this.scenes,
      onMaterial: material => this.sky.patchMaterial(material),
      onModelChange: (model, entry) => h.onSceneModel?.(model, entry),
      onPropsChange: props => h.onPropsChange?.(props),
      onLoadStart: name => h.onLoadStart?.(name),
      onProgress: (e, name) => h.onProgress?.(e, name),
      onLoadEnd: name => h.onLoadEnd?.(name),
    })

    // 基本燈光
    const { hemi, dir, dirPosition, shadowMapSize, shadowHalfWidth, shadowHalfHeight } = this.lights
    const hemiLight = new THREE.HemisphereLight(0xffffff, 0x444444, hemi)
    const dirLight = new THREE.DirectionalLight(0xffffff, dir)
    dirLight.position.fromArray(dirPosition)
    dirLight.castShadow = true
    // 人物會投影在自己身上，不加 bias 會出現條紋（shadow acne）；貼圖解析度太低時鋸齒也會變成格紋
    dirLight.shadow.mapSize.set(shadowMapSize, shadowMapSize)
    // bias 是深度比例（0~1），實際偏移 = bias × (far - near)；預設 far 500 會偏 25 公分，影子離開腳跟像浮空
    // 主光離焦點 sunDistance（10 公尺），far 30 足夠涵蓋場景，偏移縮到約 1.5 公分
    dirLight.shadow.camera.near = 0.5
    dirLight.shadow.camera.far = 30
    dirLight.shadow.bias = -0.0005
    dirLight.shadow.normalBias = 0.02
    dirLight.shadow.camera.left = -shadowHalfWidth
    dirLight.shadow.camera.right = shadowHalfWidth
    dirLight.shadow.camera.top = shadowHalfHeight
    dirLight.shadow.camera.bottom = -shadowHalfHeight
    this.scene.add(hemiLight, dirLight, dirLight.target) // target 放進場景才會更新位置（影子範圍跟著焦點）
    this.lights.hemiLight = hemiLight
    this.lights.dirLight = dirLight

    // 時間與天氣：太陽位置、天空顏色、燈光、雨；燈光基本亮度交回來，再乘上 dim
    this.atmosphere = new Atmosphere({
      scene: this.scene,
      sky: this.sky,
      hemi: hemiLight,
      sun: dirLight,
      cloudCover: this.skyOptions.cloudCover,
      onSceneLight: value => this.environment.setLightLevel(value), // 晚上室外場景變暗
      ...this.atmosphere,
      getEnv: () => this.envModel, // 雨的落點、屋頂下不下雨
      onLights: base => {
        this.lightBase = base
        this.setDim(this.dim)
      },
    })
    this.setDim(this.dim)
  }

  _setupCameraTools() {
    const h = this.hooks
    const canvas = this.renderer.domElement
    this.cameraShaker = new CameraShake({ camera: this.camera, ...this.cameraShake })
    this.cameraCollision = new CameraCollision({ camera: this.camera, getTarget: () => this.controls.target, getEnv: () => this.envModel })
    this.cameraDrag = new CameraDrag({ camera: this.camera, canvas, getTarget: () => this.controls.target, isLocked: () => !!h.isCameraLocked?.() })
  }

  _loop = () => {
    requestAnimationFrame(this._loop)
    const h = this.hooks
    const realDelta = Math.min(this.clock.getDelta(), this.maxDelta)
    const gameDelta = h.getGameDelta ? h.getGameDelta(realDelta) : realDelta

    h.onUpdate?.(realDelta)
    const focus = h.getShadowFocus?.()
    if (focus) this.atmosphere.setFocus(focus)
    if (!h.isCameraLocked?.()) this.controls.update()
    this.sky.update(realDelta, this.camera)
    this.atmosphere.update(gameDelta, this.camera)
    h.onBeforeRender?.(realDelta)

    // 只影響這個畫面的鏡頭調整：拖曳角度 → 避開物體 → 晃動；渲染後反過來還原
    this.cameraDrag.apply()
    this.cameraCollision.apply(realDelta, !!h.skipCameraCollision?.())
    this.cameraShaker.apply(gameDelta)
    this.fisheye.update(realDelta, !!h.isFisheye?.())
    this.fisheye.render()
    this.cameraShaker.restore()
    this.cameraCollision.restore()
    this.cameraDrag.restore()
    h.onAfterRender?.()
  }
}
