import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import GUI from 'three/addons/libs/lil-gui.module.min.js'
import { GroundedSkybox } from 'three/addons/objects/GroundedSkybox.js'
import { Fighter, FPS } from './fighter.js'
import { FrameMeter } from './frameMeter.js'
import { MixamoLoader } from './mixamoLoader.js'
import { Stage } from './stage.js'
import { Hud } from './hud.js'

const MODEL_DIR = 'src/model'
const SUPER_ARTS = ['dog_bear', 'kick_ball', 'monkey_turn', 'shake_head', 'dodge_step']

/**
 * FighterViewer：雙人對戰場景
 * 流程：建立場景 → 載入人物 FBX 與共用動作 FBX，在程式裡綁定（見 mixamoLoader.js）
 *       → 建立 P1 / P2 Fighter → 固定 30fps 推進遊戲邏輯（_step）：
 *         輸入 → 人物更新 → 吸附 → 推擠 → 面向 → 命中判定 → 連段 → 幀數表
 *       → 畫面更新（_animate）：絕招演出、鏡頭、HUD 與渲染，跟螢幕更新率走
 * 絕招演出：鏡頭拉近 + 停留期間遊戲暫停（不推進幀、不記幀數表）；鏡頭拉回時遊戲已經繼續
 * P2 目前是木樁，之後在 _getP2Input 接 AI
 */
class FighterViewer {
  constructor(options) {
    const def = {
      el: '#stage',
      characters: [
        { name: 'Bladman', url: `${MODEL_DIR}/characters/bladman.glb` },
        { name: 'Erika', url: `${MODEL_DIR}/characters/erika.glb` },
        { name: 'Remy', url: `${MODEL_DIR}/characters/remy.glb` },
      ],
      // 所有人物共用的動作（Mixamo 下載時選 Without Skin）；key 對應 Fighter 的狀態與招式（moves）
      anims: {
        idle: `${MODEL_DIR}/anims/normal/Idle.fbx`,
        walk: `${MODEL_DIR}/anims/normal/Walking.fbx`,
        hit: `${MODEL_DIR}/anims/normal/HitTo.fbx`,
        light: `${MODEL_DIR}/anims/normal/Punching_L.fbx`,
        heavy: `${MODEL_DIR}/anims/normal/Punching_H.fbx`,
        fly: `${MODEL_DIR}/anims/normal/FlyingBack.fbx`, // 被絕招最後一段打中：飛走
        getUp: `${MODEL_DIR}/anims/normal/KipUp.fbx`, // 飛走後起身
        jump: `${MODEL_DIR}/anims/normal/Jumping.fbx`,
        block: `${MODEL_DIR}/anims/normal/BodyBlock.fbx`,
        ...Object.fromEntries(SUPER_ARTS.map(name => [name, `${MODEL_DIR}/anims/superArt/${name}.fbx`])),
      },
      // 有 root motion 的動作：保留臀部前後位移曲線，由程式轉成人物座標（其餘動作完全原地播放）
      rootMotionAnims: ['fly', ...SUPER_ARTS],
      // 動畫自己會往上跳的動作：拿掉臀部往上的位移（保留下蹲），高度改由程式的拋物線控制
      flattenRiseAnims: ['jump'],
      // 背景：2:1 全景圖（equirectangular），GUI 可切換
      // 用 GroundedSkybox 投影成「有地面的半球」，相機前後移動時場景會有遠近感（直接當 background 是無限遠，不會變）
      skyboxes: {
        機庫外陰天: 'src/common/img/hanger_exterior_cloudy.webp',
        修道院迴廊: 'src/common/img/historic_cloister_passage.webp',
      },
      dashTapWindow: 250, // 連按兩下方向鍵的間隔（毫秒）內算衝刺
      // 人物身高（公尺）：每個模型的原始尺寸不同，載入後依此自動縮放成一致
      characterHeight: 1.75,
      stageHalfWidth: 4, // 場地邊界 x = ±4（暫定）
      startGap: 1.6, // 開場兩人距離
      hitstopFrames: 3, // 命中時雙方停頓幀數（頓幀）
      // 絕招演出（秒，現實時間）：鏡頭拉近 → 停留（遊戲暫停）→ 拉回（遊戲繼續）
      superCamera: {
        zoomIn: 0.3,
        hold: 0.3,
        zoomOut: 0.3,
        distance: 2.2, // 拉近後鏡頭與人物胸口的距離（公尺）
        light: 2, // 打光持續秒數
      },
      // 用 e.code 判斷，開著中文輸入法也能操作
      p1Keys: {
        left: 'KeyA',
        right: 'KeyD',
        jump: 'KeyW', // W 垂直跳，W + A / D 斜跳
        light: 'Numpad8',
        heavy: 'Numpad9',
        super: 'Numpad7', // 絕招暫時用單鍵觸發，招式由 GUI「招式選取」決定
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
    this.stageEl = document.querySelector(this.el)
    this.loadingEl = document.querySelector('#loading')
    this.progressEl = document.querySelector('#loadingProgress')

    // 4. setup runtime state
    this.clock = new THREE.Clock()
    this.mixamo = new MixamoLoader()
    this.sourceCache = {} // url → Promise<{ scene, clips }>，同一個人物只綁定一次
    this.p1 = null
    this.p2 = null
    this.keys = new Set()
    this.pendingAttack = null // 按下的那一幀才算出招，按住不連發；下一幀遊戲邏輯取走
    this.pendingDash = 0 // 連按兩下方向鍵：衝刺方向（世界座標），下一幀遊戲邏輯取走
    this.lastTap = { code: '', time: 0 } // 上一次按下的方向鍵，判斷連按用
    this.skyboxCache = {} // 背景名稱 → texture
    this.skybox = null // GroundedSkybox mesh
    this.cameraPull = 0 // 跳躍時鏡頭額外往後拉的距離
    this.hitstopTimer = 0 // 剩餘頓幀數
    this.accumulator = 0 // 尚未消化的時間，累積滿 1/30 秒就推進 1 幀
    this.cinematic = null // 絕招演出中：{ fighter, time, fromOffset, zoomPos, zoomTarget }
    this.lock = null // 吸附中：{ attacker, target, offset }
    this.combo = 0 // P1 目前連段數
    this.superLights = []
    this.frameMeter = new FrameMeter()
    this.isLoading = false
    this.params = {
      p1: this.characters[0].name,
      p2: this.characters[1].name,
      superMove: SUPER_ARTS[0],
      p2Guard: false, // P2 木樁一直按著後（防禦）
      skybox: '機庫外陰天',
      // 全景圖拍攝時相機離地高度（公尺）：越小地面看起來越近、景物越大
      skyboxHeight: 2,
      // 半球半徑（公尺）：場景「盒子」的大小，超出的部分是天空
      skyboxRadius: 40,
      timeScale: 1,
      paused: false,
      moveSpeed: 1.5,
      showCoords: true,
      showDebug: true,
      showSkeleton: false,
    }

    // 5. init
    this.init()
  }

  async init() {
    this._setupScene()
    this._setupGui()
    this.bindEvents()
    this._animate()

    try {
      await this.setCharacter('p1', this.params.p1)
      await this.setCharacter('p2', this.params.p2)
    } catch (err) {
      console.error(err)
      this._showLoading(true, '載入失敗，請看 console')
    }
  }

  bindEvents() {
    window.addEventListener('resize', () => this._resize())

    window.addEventListener('keydown', e => {
      if (!e.repeat) {
        if (e.code === this.p1Keys.light) this.pendingAttack = 'light'
        if (e.code === this.p1Keys.heavy) this.pendingAttack = 'heavy'
        if (e.code === this.p1Keys.super) this.pendingAttack = this.params.superMove
        this._detectDash(e.code)
      }
      this.keys.add(e.code)
    })

    window.addEventListener('keyup', e => this.keys.delete(e.code))

    // 切換視窗時 keyup 不會觸發，避免人物一直走
    window.addEventListener('blur', () => this.keys.clear())
  }

  // public

  /** 換人物：保留原本的位置與面向 */
  async setCharacter(slot, name) {
    const config = this.characters.find(c => c.name === name)
    if (!config || this.isLoading) return

    this.isLoading = true
    this._showLoading(true)

    const source = await this._loadSource(config)
    const prev = this[slot]
    const startX = (slot === 'p1' ? -1 : 1) * (this.startGap / 2)

    prev?.dispose()
    this.lock = null
    this[slot] = new Fighter({
      scene: this.scene,
      source,
      name,
      x: prev ? prev.x : startX,
      faceRight: prev ? prev.faceRight : slot === 'p1',
      characterHeight: config.height || this.characterHeight,
      moveSpeed: this.params.moveSpeed,
      showDebug: this.params.showDebug,
      showSkeleton: this.params.showSkeleton,
    })
    this.params[slot] = name

    this.isLoading = false
    this._showLoading(false)
  }

  /** 切換背景：載入全景圖後投影成有地面的半球，載入過的會快取 */
  setSkybox(name) {
    const url = this.skyboxes[name]
    if (!url) return
    this.params.skybox = name

    if (this.skyboxCache[name]) {
      this._buildSkybox(this.skyboxCache[name])
      return
    }
    new THREE.TextureLoader().load(url, texture => {
      texture.mapping = THREE.EquirectangularReflectionMapping
      texture.colorSpace = THREE.SRGBColorSpace
      this.skyboxCache[name] = texture
      // 載入期間又切到別張時不覆蓋
      if (this.params.skybox === name) this._buildSkybox(texture)
    })
  }

  /** 依目前的高度、半徑重建半球（GroundedSkybox 的形狀在建立時決定，改參數要重建） */
  _buildSkybox(texture = this.skyboxCache[this.params.skybox]) {
    if (!texture) return
    if (this.skybox) {
      this.scene.remove(this.skybox)
      this.skybox.geometry.dispose()
      this.skybox.material.dispose()
    }

    const { skyboxHeight, skyboxRadius } = this.params
    this.skybox = new GroundedSkybox(texture, skyboxHeight, skyboxRadius, 128)
    // 半球的地面在 y = 0（官方範例：位置 = 高度 - 0.01，避免和陰影地板重疊閃爍）
    this.skybox.position.y = skyboxHeight - 0.01
    this.scene.add(this.skybox)
    // 相機跑出半球外（例如滑鼠縮放很遠）時，背景仍是同一張圖
    this.scene.background = texture
  }

  // internal

  _setupScene() {
    this.renderer = new THREE.WebGLRenderer({ antialias: true })
    this.renderer.setPixelRatio(window.devicePixelRatio)
    this.renderer.setSize(window.innerWidth, window.innerHeight)
    this.renderer.shadowMap.enabled = true
    this.stageEl.appendChild(this.renderer.domElement)

    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color(0x1b1d22)
    this.setSkybox(this.params.skybox)

    this.camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 100)
    this.camera.position.set(0, 1.4, 4.5)

    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.target.set(0, 1, 0)
    this.controls.enableDamping = true

    const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 2)
    this.scene.add(hemi)

    const dir = new THREE.DirectionalLight(0xffffff, 2.5)
    dir.position.set(3, 6, 4)
    dir.castShadow = true
    // 人物會投影在自己身上，不加 bias 會出現條紋（shadow acne）；貼圖解析度太低時鋸齒也會變成格紋
    dir.shadow.mapSize.set(2048, 2048)
    dir.shadow.bias = -0.0005
    dir.shadow.normalBias = 0.02
    // 陰影範圍涵蓋整個場地寬度
    dir.shadow.camera.left = -this.stageHalfWidth - 2
    dir.shadow.camera.right = this.stageHalfWidth + 2
    dir.shadow.camera.top = 4
    dir.shadow.camera.bottom = -4
    this.scene.add(dir)

    // 絕招打光：正面暖色主光 + 背後輪廓光，平常強度 0
    // offset 是相對人物腳底的位置，z 正值 = 靠鏡頭那側
    this.superLights = [
      { light: new THREE.PointLight(0xffb040, 0, 6, 1.5), offset: new THREE.Vector3(0, 1.6, 1.2), peak: 60 },
      { light: new THREE.PointLight(0xff7a20, 0, 6, 1.5), offset: new THREE.Vector3(0, 2.2, -1), peak: 90 },
      { light: new THREE.PointLight(0xffe0a0, 0, 4, 1.5), offset: new THREE.Vector3(0, 0.3, 0.8), peak: 25 },
    ]
    this.superLights.forEach(({ light }) => this.scene.add(light))

    this.stage = new Stage({ scene: this.scene, halfWidth: this.stageHalfWidth, showRuler: this.params.showCoords })
    this.hud = new Hud({ camera: this.camera, canvas: this.renderer.domElement, showCoords: this.params.showCoords })
  }

  /** 連按兩下同一個方向鍵（間隔 dashTapWindow 內）= 衝刺 */
  _detectDash(code) {
    const { left, right } = this.p1Keys
    if (code !== left && code !== right) return

    const now = performance.now()
    if (this.lastTap.code === code && now - this.lastTap.time < this.dashTapWindow) {
      this.pendingDash = code === right ? 1 : -1
      this.lastTap = { code: '', time: 0 } // 第三下不再觸發，要重新連按兩下
      return
    }
    this.lastTap = { code, time: now }
  }

  /** 載入人物與所有共用動作並綁定；回傳的 scene 會由 Fighter clone，不直接放進場景 */
  _loadSource(config) {
    if (!this.sourceCache[config.url]) this.sourceCache[config.url] = this._buildSource(config)
    return this.sourceCache[config.url]
  }

  async _buildSource(config) {
    const keys = Object.keys(this.anims)
    const [character, ...anims] = await Promise.all([
      this.mixamo.loadCharacter(config.url, e => this._onProgress(e, config.name)),
      ...keys.map(key => this.mixamo.loadAnimation(this.anims[key])),
    ])

    const clips = {}
    keys.forEach((key, i) => {
      const clip = this.mixamo.bindAnimation(character, anims[i], key)
      clips[key] = this._makeInPlace(clip, this.rootMotionAnims.includes(key), this.flattenRiseAnims.includes(key))
    })
    return { scene: character.scene, clips }
  }

  /**
   * 原地播放：固定臀部的水平位置，讓位移交給程式控制（格鬥遊戲常用作法）
   * isRootMotion：先把臀部的前後位移（Z）存成 clip.rootMotion，由 Fighter 轉成人物座標
   * isFlattenRise：臀部高度不超過第一格（保留下蹲、拿掉往上跳）
   */
  _makeInPlace(source, isRootMotion = false, isFlattenRise = false) {
    const clip = source.clone()
    const hipsTrack = clip.tracks.find(t => t.name.endsWith('Hips.position'))
    if (!hipsTrack) return clip

    const values = hipsTrack.values
    const startX = values[0]
    const startZ = values[2]

    if (isRootMotion) {
      clip.rootMotion = {
        times: hipsTrack.times.slice(),
        values: hipsTrack.times.map((_, i) => values[i * 3 + 2] - startZ),
      }
    }

    const startY = values[1]
    for (let i = 0; i < values.length; i += 3) {
      values[i] = startX
      values[i + 2] = startZ
      if (isFlattenRise) values[i + 1] = Math.min(values[i + 1], startY)
    }
    return clip
  }

  _setupGui() {
    const gui = new GUI({ title: 'Fighter 控制台' })
    const names = this.characters.map(c => c.name)
    const fighters = () => [this.p1, this.p2].filter(Boolean)

    gui.add(this.params, 'p1', names).name('P1 角色').listen().onChange(v => this.setCharacter('p1', v))
    gui.add(this.params, 'p2', names).name('P2 角色（木樁）').listen().onChange(v => this.setCharacter('p2', v))
    gui.add(this.params, 'superMove', SUPER_ARTS).name('招式選取（7 鍵）')
    gui.add(this.params, 'p2Guard').name('P2 木樁防禦')
    const bgFolder = gui.addFolder('背景')
    bgFolder.add(this.params, 'skybox', Object.keys(this.skyboxes)).name('場景').listen().onChange(v => this.setSkybox(v))
    bgFolder.add(this.params, 'skyboxHeight', 0.5, 10, 0.1).name('拍攝高度').onFinishChange(() => this._buildSkybox())
    bgFolder.add(this.params, 'skyboxRadius', 10, 200, 1).name('場景大小').onFinishChange(() => this._buildSkybox())

    const playFolder = gui.addFolder('播放設定')
    playFolder.add(this.params, 'timeScale', 0, 2, 0.05).name('遊戲速度')
    playFolder.add(this.params, 'paused').name('暫停')
    playFolder.add(this.params, 'moveSpeed', 0.5, 5, 0.1).name('移動速度').onChange(v => {
      fighters().forEach(f => { f.moveSpeed = v })
    })

    const debugFolder = gui.addFolder('除錯')
    debugFolder.add(this.params, 'showCoords').name('顯示 X 軸與座標').onChange(v => {
      this.stage.setRulerVisible(v)
      this.hud.setCoordsVisible(v)
    })
    debugFolder.add(this.params, 'showDebug').name('顯示判定框').onChange(v => {
      fighters().forEach(f => f.setDebugVisible(v))
    })
    debugFolder.add(this.params, 'showSkeleton').name('顯示骨架').onChange(v => {
      fighters().forEach(f => f.setSkeletonVisible(v))
    })
  }

  _getP1Input() {
    const { left, right } = this.p1Keys
    const move = (this.keys.has(right) ? 1 : 0) - (this.keys.has(left) ? 1 : 0)
    const attack = this.pendingAttack
    const dash = this.pendingDash
    this.pendingAttack = null
    this.pendingDash = 0
    return { move, attack, dash, jump: this.keys.has(this.p1Keys.jump) }
  }

  /** P2 目前是木樁；之後的 AI 在這裡回傳 { move, attack, jump, guard } */
  _getP2Input() {
    return { move: 0, attack: null, dash: 0, jump: false, guard: this.params.p2Guard }
  }

  /**
   * 吸附：lockTarget 招式命中後，對手固定在攻擊方面前，直到被打飛或招式結束
   * 之後有防禦時，防禦住的不吸附（在 _checkHits 判斷）
   */
  _updateLock() {
    const lock = this.lock
    if (!lock) return
    if (lock.attacker.state !== 'attack' || lock.target.state !== 'hit') {
      this.lock = null
      return
    }
    lock.target.x = lock.attacker.x + lock.attacker.facingSign * lock.offset
  }

  /** 推擠：兩人推擠框重疊時各退一半；有一方卡在邊界時由另一方全退 */
  _resolvePush() {
    const { p1, p2 } = this
    const limit = this.stageHalfWidth

    // 兩人座標完全相同時，以 P1 在左為準
    const left = p1.x <= p2.x ? p1 : p2
    const right = left === p1 ? p2 : p1
    const minGap = left.pushHalfWidth + right.pushHalfWidth
    const overlap = minGap - (right.x - left.x)
    // 高度差超過大半個身高（跳過對手頭頂）時不推擠，可以越過去換邊
    const isOverhead = Math.abs(p1.y - p2.y) > this.characterHeight * 0.8

    if (overlap > 0 && !isOverhead) {
      left.x -= overlap / 2
      right.x += overlap / 2
    }

    const leftMin = -limit + left.pushHalfWidth
    const rightMax = limit - right.pushHalfWidth
    left.x = Math.max(left.x, leftMin)
    right.x = Math.min(right.x, rightMax)

    // 被夾在邊界時，另一方全部退開
    if (right.x - left.x < minGap && !isOverhead) {
      if (left.x <= leftMin) right.x = left.x + minGap
      else left.x = right.x - minGap
    }
  }

  /** 攻擊方的攻擊判定碰到對手受擊框就算命中；每段只算一下，launch 招式最後一段把對手打飛 */
  _checkHits() {
    ;[[this.p1, this.p2], [this.p2, this.p1]].forEach(([attacker, target]) => {
      if (!attacker.checkHit(target)) return

      const move = attacker.getCurrentMove()

      // 防禦：不扣血、不吸附、不打飛、不算連段，只有防禦硬直
      if (target.canBlock) {
        attacker.registerHit()
        target.takeBlock(attacker.x)
        this.hitstopTimer = this.hitstopFrames
        return
      }

      const isCombo = target.state === 'hit' // 對手還在硬直中被打到 = 連段
      const isLaunch = attacker.registerHit()
      target.takeHit(attacker.x, move, isLaunch)
      this.hitstopTimer = this.hitstopFrames

      if (move.lockTarget && !isLaunch && !this.lock) {
        const gap = attacker.pushHalfWidth + target.pushHalfWidth
        this.lock = { attacker, target, offset: Math.max(gap, Math.abs(target.x - attacker.x)) }
      }

      if (attacker === this.p1) {
        this.combo = isCombo ? this.combo + 1 : 1
        this.hud.setCombo(this.combo)
      }
    })

    // 對手恢復自由 = 連段結束
    if (this.combo && this.p2.canAct) {
      this.combo = 0
      this.hud.setCombo(0)
    }
  }

  /**
   * 鏡頭中心跟著兩人中點左右平移，保留滑鼠旋轉 / 縮放
   * 有人跳起來時：注視點往上一點、鏡頭往後拉一點，地面和跳到最高點的人都留在畫面內
   */
  _followCamera(delta) {
    const rate = Math.min(1, delta * 5)
    const airY = Math.max(this.p1.y, this.p2.y)
    const mid = (this.p1.x + this.p2.x) / 2
    const dx = (mid - this.controls.target.x) * rate
    const dy = (1 + airY * 0.45 - this.controls.target.y) * rate
    this.controls.target.x += dx
    this.controls.target.y += dy
    this.camera.position.x += dx
    this.camera.position.y += dy

    // 沿著視線方向往後拉
    const pull = (airY * 0.5 - this.cameraPull) * rate
    const back = this.camera.position.clone().sub(this.controls.target).normalize()
    this.camera.position.addScaledVector(back, pull)
    this.cameraPull += pull
  }

  /** 絕招演出開始：人物停在招式第 0 幀，鏡頭從目前位置拉近到人物胸口 */
  _startSuper(fighter, key) {
    fighter.startMove(key)
    this.scene.updateMatrixWorld()
    fighter.updateBoxes()

    const fromTarget = this.controls.target.clone()
    const fromOffset = this.camera.position.clone().sub(fromTarget) // 一般鏡頭相對注視點的位置
    const zoomTarget = new THREE.Vector3(fighter.x, this.characterHeight * 0.7, 0)
    const zoomPos = zoomTarget.clone().addScaledVector(fromOffset.clone().normalize(), this.superCamera.distance)

    this.cinematic = { fighter, time: 0, fromTarget, fromOffset, zoomPos, zoomTarget }
    this.controls.enabled = false
  }

  /** 演出中是否暫停遊戲：只有拉近 + 停留期間暫停，拉回時遊戲已經繼續 */
  _isFrozen() {
    const { zoomIn, hold } = this.superCamera
    return !!this.cinematic && this.cinematic.time < zoomIn + hold
  }

  /** 絕招演出：拉近 → 停留 → 拉回，同時打光；拉回的終點是跟著人物移動的一般鏡頭位置 */
  _updateCinematic(delta) {
    const c = this.cinematic
    const { zoomIn, hold, zoomOut, light } = this.superCamera
    const easeOut = t => 1 - (1 - t) ** 3
    const easeInOut = t => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2)
    c.time += delta
    const t = c.time

    // 一般鏡頭：注視點 x 跟著兩人中點
    const baseTarget = c.fromTarget.clone()
    if (t > zoomIn + hold) baseTarget.x = (this.p1.x + this.p2.x) / 2
    const basePos = baseTarget.clone().add(c.fromOffset)

    // k：0 = 一般鏡頭，1 = 拉近
    let k = 1
    if (t < zoomIn) k = easeOut(t / zoomIn)
    else if (t > zoomIn + hold) k = 1 - easeInOut(Math.min(1, (t - zoomIn - hold) / zoomOut))

    this.camera.position.lerpVectors(basePos, c.zoomPos, k)
    this.controls.target.lerpVectors(baseTarget, c.zoomTarget, k)
    this.camera.lookAt(this.controls.target)

    // 打光：0.15 秒亮起、最後 0.4 秒淡出，跟著人物移動
    const amount = t < light ? Math.max(0, Math.min(1, t / 0.15, (light - t) / 0.4)) : 0
    this.superLights.forEach(({ light: pointLight, offset, peak }) => {
      pointLight.intensity = peak * amount
      pointLight.position.set(c.fighter.x + offset.x, offset.y, offset.z)
    })

    if (t >= Math.max(zoomIn + hold + zoomOut, light)) {
      this.camera.position.copy(basePos)
      this.controls.target.copy(baseTarget)
      this.controls.enabled = true
      this.cinematic = null
    }
  }

  _showLoading(isShow, text = '') {
    this.loadingEl.classList.toggle('is_hide', !isShow)
    if (text) this.progressEl.textContent = text
  }

  _onProgress(e, label) {
    if (!e.total) return
    this.progressEl.textContent = `${label} ${Math.round((e.loaded / e.total) * 100)}%`
  }

  _resize() {
    this.camera.aspect = window.innerWidth / window.innerHeight
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(window.innerWidth, window.innerHeight)
  }

  /** 推進 1 幀遊戲邏輯 */
  _step() {
    // 頓幀：雙方動畫、移動與幀數表都暫停
    if (this.hitstopTimer > 0) {
      this.hitstopTimer--
      return
    }

    const p1Input = this._getP1Input()

    // 絕招：先進入演出，遊戲暫停到鏡頭拉近 + 停留結束，之後才從招式第 0 幀開始推進
    if (p1Input.attack && this.p1.moves[p1Input.attack]?.isSuper && this.p1.canAct) {
      this._startSuper(this.p1, p1Input.attack)
      return
    }

    this.p1.update(p1Input)
    this.p2.update(this._getP2Input())
    this._updateLock()
    this._resolvePush()
    this.p1.faceTo(this.p2.x)
    this.p2.faceTo(this.p1.x)

    this.scene.updateMatrixWorld()
    this.p1.updateBoxes()
    this.p2.updateBoxes()
    this._checkHits()
    this.frameMeter.record([this.p1.getFrameType(), this.p2.getFrameType()])
  }

  _animate = () => {
    requestAnimationFrame(this._animate)
    // 切分頁回來時 delta 可能很大，限制上限避免一次補太多幀
    const realDelta = Math.min(this.clock.getDelta(), 0.1)

    if (this.cinematic) this._updateCinematic(realDelta)

    if (this.p1 && this.p2) {
      if (!this._isFrozen()) {
        const step = 1 / FPS
        this.accumulator += this.params.paused ? 0 : realDelta * this.params.timeScale
        // 絕招演出開始後剩下的時間不再補幀
        while (this.accumulator >= step && !this._isFrozen()) {
          this.accumulator -= step
          this._step()
        }
        if (this._isFrozen()) this.accumulator = 0
      }

      if (!this.cinematic) this._followCamera(realDelta)
      this.hud.updateCoords([this.p1, this.p2])
    }

    // 演出中由 _updateCinematic 控制鏡頭
    if (!this.cinematic) this.controls.update()
    this.hud.update(realDelta)

    this.renderer.render(this.scene, this.camera)
  }
}

// 掛到 window 方便在 DevTools console 裡直接查看，例如 viewer.p1、viewer.p2
window.viewer = new FighterViewer()
