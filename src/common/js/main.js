import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import GUI from 'three/addons/libs/lil-gui.module.min.js'
import { GroundedSkybox } from 'three/addons/objects/GroundedSkybox.js'
import { Fighter, FPS } from './fighter.js'
import { FrameMeter } from './frameMeter.js'
import { MixamoLoader } from './mixamoLoader.js'
import { Stage } from './stage.js'
import { Hud } from './hud.js'
import { Sound } from './sound.js'

const MODEL_DIR = 'src/model'
const SOUND_DIR = 'src/sound'
const SUPER_ARTS = ['dog_bear', 'kick_ball', 'monkey_turn', 'shake_head', 'dodge_step']

/**
 * FighterViewer：雙人對戰場景
 * 流程：建立場景 → 載入人物 FBX 與共用動作 FBX，在程式裡綁定（見 mixamoLoader.js）
 *       → 建立 P1 / P2 Fighter → 固定 60fps 推進遊戲邏輯（_step）：
 *         輸入 → 人物更新 → 吸附 → 推擠 → 面向 → 命中判定 → 連段 → 幀數表
 *       → 畫面更新（_animate）：絕招演出、鏡頭、HUD 與渲染，跟螢幕更新率走
 * 絕招演出：鏡頭拉近 + 停留期間遊戲暫停（不推進幀、不記幀數表）；鏡頭拉回時遊戲已經繼續
 * P2 用方向鍵 ← → ↑ 操作（移動 / 防禦 / 跳 / 衝刺），沒有攻擊；之後可在 _getP2Input 接 AI
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
        medium: `${MODEL_DIR}/anims/normal/Punching_M.fbx`,
        heavy: `${MODEL_DIR}/anims/normal/Punching_H.fbx`,
        fly: `${MODEL_DIR}/anims/normal/FlyingBack.fbx`, // 被絕招最後一段打中：飛走
        getUp: `${MODEL_DIR}/anims/normal/KipUp.fbx`, // 飛走後起身
        jump: `${MODEL_DIR}/anims/normal/Jumping.fbx`,
        block: `${MODEL_DIR}/anims/normal/BodyBlock.fbx`,
        ...Object.fromEntries(SUPER_ARTS.map(name => [name, `${MODEL_DIR}/anims/superArt/${name}.fbx`])),
      },
      // 有 root motion 的動作：保留臀部前後位移曲線，由程式轉成人物座標（其餘動作完全原地播放）
      rootMotionAnims: ['fly', ...SUPER_ARTS],
      // root motion 改取臀部的 X（側向）位移：動畫朝側面表演、招式用 yaw 轉 90 度的動作
      rootMotionAxisX: ['shake_head'],
      // 動畫自己會往上跳的動作：拿掉臀部往上的位移（保留下蹲），高度改由程式的拋物線控制
      flattenRiseAnims: ['jump'],
      // 裁掉動作開頭 start / 結尾 end 幾幀（遊戲幀，FPS 為單位），不改 FBX 檔；刪掉該項就恢復原本長度
      // 注意：招式的 startup / recovery / hits 是照裁切後的幀數
      trimAnims: {
        dog_bear: { start: 10 },
        // Rokoko 匯出的絕招第 0 幀是 T 字形：裁掉 2 幀（= 30F 檔的第 0 幀），絕招停頓時才不會看到
        kick_ball: { start: 2 },
        monkey_turn: { start: 2 },
        shake_head: { start: 2 },
        dodge_step: { start: 40 }, // 第一次從這裡開始；之後每次從第 50 幀開始（見 fighter.js firstPassDelay）
        light: { start: 2, end: 4 },
        medium: { start: 5 },
        heavy: { start: 4 },
        hit: { start: 6 }, // 受擊動作
      },
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
      maxDistance: 4, // 兩人最遠距離（公尺），超過時往外移動的一方被擋住
      rushInputFrames: 8, // 衝刺取消鍵按下後記住幾幀：跟出招鍵差幾幀內按都算
      bufferFrames: 8, // 任何動作結束前幾幀內按攻擊 / 絕招鍵會記住，動作最後一幀接著出招
      hitstopFrames: 3, // 命中時雙方停頓幀數（頓幀）；招式有填 hitstop 時用招式的
      // 受擊搖晃（招式有 hitShake 才搖）：被打中的人在頓幀期間沿 z 軸來回搖 cycles 次（頓幀越長搖得越慢）
      hitShake: { cycles: 2, amplitude: 0.15 },
      // 音效：一般招式命中 hit、絕招命中 superHit、防禦住 block、倒地 knockdown；其他 key 給招式的 sounds 用；{ url, volume } 可個別調音量
      sounds: {
        hit: { url: `${SOUND_DIR}/hit2.mp3`, volume: 0.8 },
        superHit: { url: `${SOUND_DIR}/hit2.mp3`, volume: 0.8 },
        block: `${SOUND_DIR}/hit1.mp3`,
        knockdown: `${SOUND_DIR}/knockdown.wav`,
        dog_bear: `${SOUND_DIR}/dog_bear.wav`,
        dog_bear_title: `${SOUND_DIR}/dog_bear_title.wav`,
        kick_ball_title: `${SOUND_DIR}/kick_ball_title.wav`,
        shake_head: `${SOUND_DIR}/shake_head.wav`,
        shake_head_title: `${SOUND_DIR}/shake_head_title.wav`,
        dodge_step_title: `${SOUND_DIR}/dodge_step_title.wav`,
      },
      knockdownSoundFrame: 35, // 被打飛後第幾幀播倒地音效（身體碰到地面的時間點）
      // 絕招演出（秒，現實時間）：鏡頭拉近 → 停留（遊戲暫停）→ 拉回（遊戲繼續）
      superCamera: {
        zoomIn: 0.3,
        hold: 0.3,
        zoomOut: 0.3,
        distance: 2.2, // 拉近後鏡頭與人物胸口的距離（公尺）
        spotFadeIn: 0.15, // 聚光燈亮起秒數；鏡頭開始拉回時同步淡出
      },
      // 用 e.code 判斷，開著中文輸入法也能操作
      p1Keys: {
        left: 'KeyA',
        right: 'KeyD',
        jump: 'KeyW', // W 垂直跳，W + A / D 斜跳
        light: 'Numpad7',
        medium: 'Numpad8',
        heavy: 'Numpad9',
        rush: 'Numpad0', // 輕 / 中 / 重攻擊打中後：發光 + 往前衝刺；預約時段內先按會在打中時觸發
        super: 'Numpad6', // 招式由 GUI「招式選取」決定
        // 固定招式的絕招鍵：按鍵 → 招式 key
        // Numpad3 保留，之後放新的絕招
        supers: { Numpad1: 'dog_bear', Numpad2: 'shake_head', Numpad4: 'dodge_step', Numpad5: 'kick_ball' },
      },
      p2Keys: {
        left: 'ArrowLeft',
        right: 'ArrowRight',
        jump: 'ArrowUp', // ↑ 垂直跳，↑ + ← / → 斜跳
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
    this.rushLife = 0 // 衝刺取消鍵按下後還記住幾幀（出招鍵稍晚按也能預約）；被用掉就清 0
    this.bufferedAttack = null // 收招結束前 bufferFrames 幀內按的招式：{ key, life }，能動的第一幀出招
    this.pendingDash = { p1: 0, p2: 0 } // 連按兩下方向鍵：衝刺方向（世界座標），下一幀遊戲邏輯取走
    this.lastTap = { p1: { code: '', time: 0 }, p2: { code: '', time: 0 } } // 上一次按下的方向鍵，判斷連按用
    this.skyboxCache = {} // 背景名稱 → texture
    this.skybox = null // GroundedSkybox mesh
    this.cameraPull = 0 // 跳躍時鏡頭額外往後拉的距離
    this.hitstopTimer = 0 // 剩餘頓幀數
    this.rushFreeze = null // 衝刺取消停頓中：{ fighter, frame }，停頓到第 animStartFrame 幀開始播衝刺動畫
    this.shake = null // 受擊搖晃中：{ fighter, time, duration }（秒）
    this.accumulator = 0 // 尚未消化的時間，累積滿 1/60 秒就推進 1 幀
    this.cinematic = null // 絕招演出中：{ fighter, time, fromOffset, zoomPos, zoomTarget }
    this.lock = null // 吸附中：{ attacker, target, offset }
    this.combo = 0 // P1 目前連段數
    this.superSpot = null // 絕招聚光燈：{ light, offset, aim, peak }
    this.frameMeter = new FrameMeter()
    this.sound = new Sound({ files: this.sounds })
    this.isLoading = false
    this.params = {
      p1: this.characters[0].name,
      p2: this.characters[1].name,
      superMove: 'monkey_turn',
      p2Guard: false, // P2 木樁一直按著後（防禦）
      volume: 0.8, // 音效音量
      skybox: '機庫外陰天',
      // 全景圖拍攝時相機離地高度（公尺）：越小地面看起來越近、景物越大
      skyboxHeight: 2,
      // 半球半徑（公尺）：場景「盒子」的大小，超出的部分是天空
      skyboxRadius: 40,
      timeScale: 1,
      paused: false,
      moveSpeed: 2,
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
        if (e.code === this.p1Keys.medium) this.pendingAttack = 'medium'
        if (e.code === this.p1Keys.heavy) this.pendingAttack = 'heavy'
        if (e.code === this.p1Keys.rush) this.rushLife = this.rushInputFrames
        if (e.code === this.p1Keys.super) this.pendingAttack = this.params.superMove
        if (this.p1Keys.supers[e.code]) this.pendingAttack = this.p1Keys.supers[e.code]
        this._detectDash('p1', e.code)
        this._detectDash('p2', e.code)
      }
      if (!e.repeat && e.code === 'KeyP') this._togglePause()
      if (!e.repeat && e.code === 'Escape') this.resetAll()
      // 方向鍵預設會捲動頁面
      if (Object.values(this.p2Keys).includes(e.code)) e.preventDefault()
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

    // 絕招打光：頭頂正上方往下照的暖色聚光燈，平常強度 0
    // offset 是燈相對人物腳底的位置，aim 是照射點（頭部附近）
    const spot = new THREE.SpotLight(0xffc040, 0, 8, Math.PI / 7, 0.5, 1.5)
    spot.castShadow = true
    spot.shadow.mapSize.set(1024, 1024)
    this.superSpot = { light: spot, offset: new THREE.Vector3(0, 4.2, 0.4), aim: new THREE.Vector3(0, 1.5, 0), peak: 250 }
    this.scene.add(spot, spot.target)

    this.stage = new Stage({ scene: this.scene, halfWidth: this.stageHalfWidth, showRuler: this.params.showCoords })
    this.hud = new Hud({ camera: this.camera, canvas: this.renderer.domElement, showCoords: this.params.showCoords })
  }

  /** 連按兩下同一個方向鍵（間隔 dashTapWindow 內）= 衝刺 */
  _detectDash(player, code) {
    const { left, right } = player === 'p1' ? this.p1Keys : this.p2Keys
    if (code !== left && code !== right) return

    const now = performance.now()
    const last = this.lastTap[player]
    if (last.code === code && now - last.time < this.dashTapWindow) {
      this.pendingDash[player] = code === right ? 1 : -1
      this.lastTap[player] = { code: '', time: 0 } // 第三下不再觸發，要重新連按兩下
      return
    }
    this.lastTap[player] = { code, time: now }
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
      let clip = this.mixamo.bindAnimation(character, anims[i], key)
      const trim = this.trimAnims[key]
      if (trim) clip = this._trimClip(clip, trim.start ?? 0, trim.end ?? 0)
      clips[key] = this._makeInPlace(clip, this.rootMotionAnims.includes(key), this.flattenRiseAnims.includes(key), this.rootMotionAxisX.includes(key))
    })
    return { scene: character.scene, clips }
  }

  /**
   * 裁掉動作開頭 startFrames 幀、結尾 endFrames 幀（遊戲幀）：每條 track 在兩個裁切點補內插出來的 key，中間的 key 往前平移
   * 要在 _makeInPlace 之前做，root motion 才會從裁切後的第一幀算起
   */
  _trimClip(source, startFrames, endFrames) {
    const start = startFrames / FPS
    const end = source.duration - endFrames / FPS
    if (end - start <= 0) return source

    const tracks = source.tracks.map(track => {
      const size = track.getValueSize()
      const interpolant = track.createInterpolant()
      const first = interpolant.evaluate(start).slice()
      const last = interpolant.evaluate(end).slice()
      const keep = []
      track.times.forEach((t, i) => t > start && t < end && keep.push(i))

      const count = keep.length + 2
      const times = new Float32Array(count)
      const values = new Float32Array(count * size)
      values.set(first, 0)
      keep.forEach((i, n) => {
        times[n + 1] = track.times[i] - start
        values.set(track.values.subarray(i * size, (i + 1) * size), (n + 1) * size)
      })
      times[count - 1] = end - start
      values.set(last, (count - 1) * size)
      return new track.constructor(track.name, times, values)
    })
    return new THREE.AnimationClip(source.name, end - start, tracks)
  }

  /**
   * 原地播放：固定臀部的水平位置，讓位移交給程式控制（格鬥遊戲常用作法）
   * isRootMotion：先把臀部的前後位移（Z）存成 clip.rootMotion，由 Fighter 轉成人物座標
   * isFlattenRise：臀部高度不超過第一格（保留下蹲、拿掉往上跳）
   */
  _makeInPlace(source, isRootMotion = false, isFlattenRise = false, isAxisX = false) {
    const clip = source.clone()
    const hipsTrack = clip.tracks.find(t => t.name.endsWith('Hips.position'))
    if (!hipsTrack) return clip

    const values = hipsTrack.values
    const startX = values[0]
    const startZ = values[2]

    if (isRootMotion) {
      clip.rootMotion = {
        axis: isAxisX ? 'x' : 'z',
        times: hipsTrack.times.slice(),
        values: hipsTrack.times.map((_, i) => (isAxisX ? values[i * 3] - startX : values[i * 3 + 2] - startZ)),
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
    gui.add(this.params, 'p2', names).name('P2 角色').listen().onChange(v => this.setCharacter('p2', v))
    gui.add(this.params, 'superMove', SUPER_ARTS).name('招式選取（6 鍵）')
    gui.add(this.params, 'p2Guard').name('P2 木樁防禦')
    const soundFolder = gui.addFolder('音效')
    soundFolder.add(this.params, 'volume', 0, 1, 0.05).name('總音量').onChange(v => this.sound.setVolume(v))
    soundFolder.add(this, 'knockdownSoundFrame', 0, 120, 1).name('倒地音效幀')
    const bgFolder = gui.addFolder('背景')
    bgFolder.add(this.params, 'skybox', Object.keys(this.skyboxes)).name('場景').listen().onChange(v => this.setSkybox(v))
    bgFolder.add(this.params, 'skyboxHeight', 0.5, 10, 0.1).name('拍攝高度').onFinishChange(() => this._buildSkybox())
    bgFolder.add(this.params, 'skyboxRadius', 10, 200, 1).name('場景大小').onFinishChange(() => this._buildSkybox())

    const playFolder = gui.addFolder('播放設定')
    playFolder.add(this.params, 'timeScale', 0, 2, 0.05).name('遊戲速度')
    this.pauseController = playFolder.add(this.params, 'paused').name('暫停（P）')
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

  /**
   * 輸入預約：動作結束前 bufferFrames 幀內按的招式先記住，能動的第一幀才送出
   * 衝刺取消中、連打等本來就能接受輸入的時機照常送出，交給 Fighter 判斷
   */
  _bufferAttack(fighter, pressed) {
    // 連打預約的絕招（保險：正常會在 _step 的最後一幀就接上）
    if (fighter.queuedAttack) {
      if (!fighter.canAct) return pressed
      const key = fighter.queuedAttack
      fighter.queuedAttack = null
      return pressed || key
    }
    if (pressed) {
      const left = fighter.framesUntilFree
      if (left > 1 && left <= this.bufferFrames) this.bufferedAttack = { key: pressed, life: left + 2 } // 多留一點，出招第 1 幀定格時不會提早失效
    }
    // 動作的最後一幀就送出：Fighter 這一幀結束動作後馬上出招，幀數表不會多一格空白
    // 先不清掉，真的開始出招才清（見 _step）
    if (!pressed && this.bufferedAttack && fighter.framesUntilFree <= 1) return this.bufferedAttack.key
    if (this.bufferedAttack && --this.bufferedAttack.life <= 0) this.bufferedAttack = null
    return pressed
  }

  _getP1Input() {
    const { left, right } = this.p1Keys
    const move = (this.keys.has(right) ? 1 : 0) - (this.keys.has(left) ? 1 : 0)
    const attack = this._bufferAttack(this.p1, this.pendingAttack)
    const dash = this.pendingDash.p1
    const rush = this.rushLife > 0
    if (this.rushLife > 0) this.rushLife--
    this.pendingAttack = null
    this.pendingDash.p1 = 0
    return { move, attack, dash, rush, jump: this.keys.has(this.p1Keys.jump) }
  }

  /** P2：方向鍵移動 / 跳 / 衝刺，按後 = 防禦；GUI「P2 木樁防禦」打開時不按也一直防禦。之後的 AI 在這裡回傳 { move, attack, dash, jump, guard } */
  _getP2Input() {
    const { left, right, jump } = this.p2Keys
    const move = (this.keys.has(right) ? 1 : 0) - (this.keys.has(left) ? 1 : 0)
    const dash = this.pendingDash.p2
    this.pendingDash.p2 = 0
    return { move, attack: null, dash, jump: this.keys.has(jump), guard: this.params.p2Guard }
  }

  /**
   * 吸附：lockTarget 招式命中後，對手固定在攻擊方面前，直到被打飛或招式結束
   * 之後有防禦時，防禦住的不吸附（在 _checkHits 判斷）
   */
  _updateLock() {
    const lock = this.lock
    if (!lock) return
    if (lock.attacker.state !== 'attack' || lock.target.state !== 'hit') {
      lock.target.release() // 被抓住的對手：招式結束沒被打飛就放開
      this.lock = null
      return
    }
    lock.target.x = lock.attacker.x + lock.attacker.facingSign * lock.offset
  }

  /**
   * 抓取：招式有 grab 時，第 from ~ to 幀對手在地面、距離 range 內就吸過來（無視防禦）
   * 之後對手跟著攻擊方移動、維持受擊硬直；攻擊判定照判定球判斷，打中擊飛，沒打中就到招式結束才放開
   */
  _checkGrabs() {
    if (this.lock) return
    ;[[this.p1, this.p2], [this.p2, this.p1]].forEach(([attacker, target]) => {
      const grab = attacker.getCurrentMove()?.grab
      if (!grab || this.lock) return
      const frame = attacker.moveFrame
      if (frame < grab.from || frame > grab.to) return
      // 跳躍中（包含起跳前還在地上的那幾幀）抓不到
      if (attacker.isAirborne || target.isJumping || target.isInvincible) return
      if (Math.abs(target.x - attacker.x) > grab.range) return

      target.grab(grab.stunFrame)
      this.lock = { attacker, target, offset: grab.distance, isGrab: true }
    })
  }

  /** dashThrough：穿越第 1 幀決定終點（對手另一側 gap 公尺、不出場地），之後每幀平均移動過去 */
  _updateDashThrough() {
    ;[[this.p1, this.p2], [this.p2, this.p1]].forEach(([f, other]) => {
      const d = f.getCurrentMove()?.dashThrough
      if (!d || !f.isDashing) return
      const frame = f.moveFrame
      if (!f.passPlan) {
        const limit = this.stageHalfWidth - f.pushHalfWidth
        // 最後一次不穿越（lastNoPass）：停在對手面前，推擠框剛好貼齊
        const gap = f.isLastPassStop ? -(f.pushHalfWidth + other.pushHalfWidth) : d.gap
        // 最後一次有 lastDistance：往前衝固定距離
        const target = f.isLastPass && d.lastDistance ? f.x + f.facingSign * d.lastDistance : other.x + f.facingSign * gap
        const endX = THREE.MathUtils.clamp(target, -limit, limit)
        f.passPlan = { startX: f.x, endX }
      }
      const { startX, endX } = f.passPlan
      f.x = startX + (endX - startX) * ((frame - d.from + 1) / (d.to - d.from + 1))
    })
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

    // 穿越中（dashThrough）不推擠，才能穿過對手
    const isPassing = p1.isPassing || p2.isPassing

    if (overlap > 0 && !isOverhead && !isPassing) {
      left.x -= overlap / 2
      right.x += overlap / 2
    }

    const leftMin = -limit + left.pushHalfWidth
    const rightMax = limit - right.pushHalfWidth
    left.x = Math.max(left.x, leftMin)
    right.x = Math.min(right.x, rightMax)

    // 被夾在邊界時，另一方全部退開
    if (right.x - left.x < minGap && !isOverhead && !isPassing) {
      if (left.x <= leftMin) right.x = left.x + minGap
      else left.x = right.x - minGap
    }

    // 最遠距離：超過 maxDistance 時，依這幀兩人各往外移動多少分攤拉回（只有一方往外就只擋那一方）
    const excess = right.x - left.x - this.maxDistance
    if (excess > 0) {
      const leftOut = Math.max(0, (this.prevX?.get(left) ?? left.x) - left.x)
      const rightOut = Math.max(0, right.x - (this.prevX?.get(right) ?? right.x))
      const total = leftOut + rightOut
      const leftShare = total > 0 ? leftOut / total : 0.5
      left.x += excess * leftShare
      right.x -= excess * (1 - leftShare)
    }
  }

  /**
   * 攻擊方的攻擊判定碰到對手受擊框就算命中；每段只算一下，launch 招式最後一段把對手打飛
   * 吸附中（lockTarget 命中後）：之後每一段進入判定幀就必定命中，不看判定框（一旦被打中就打到招式結束）
   * 抓取中（grab）：仍照判定球判斷，打中才擊飛；沒打中就抓到招式結束才放開
   */
  _checkHits() {
    ;[[this.p1, this.p2], [this.p2, this.p1]].forEach(([attacker, target]) => {
      const isLocked = this.lock?.attacker === attacker && this.lock.target === target && !this.lock.isGrab
      if (!(isLocked ? attacker.isHitActive() : attacker.checkHit(target))) return

      const move = attacker.getCurrentMove()

      // 防禦：不扣血、不吸附、不打飛、不算連段，只有防禦硬直
      if (target.canBlock) {
        attacker.registerHit()
        target.takeBlock(attacker.x, move)
        this.sound.play('block')
        this._applyCornerPush(attacker, target)
        this.hitstopTimer = move.hitstop ?? this.hitstopFrames
        return
      }

      const isCombo = target.state === 'hit' // 對手還在硬直中被打到 = 連段
      const isLaunch = attacker.registerHit()
      target.takeHit(attacker.x, move, isLaunch)
      attacker.onHitConfirm() // 衝刺取消、收招縮短、下一拳鏡像：防禦住的不算
      if (!isLaunch) this._applyCornerPush(attacker, target)
      this.sound.play(move.isSuper ? 'superHit' : 'hit') // 受擊確認：受擊硬直第一幀
      this.hitstopTimer = move.hitstop ?? this.hitstopFrames
      if (move.hitShake) this._startShake(target, this.hitstopTimer, move.hitShake === true ? this.hitShake.cycles : move.hitShake)

      if (move.lockTarget && !isLaunch && !this.lock) {
        const gap = attacker.pushHalfWidth + target.pushHalfWidth
        this.lock = { attacker, target, offset: Math.max(gap, move.lockDistance ?? gap) } // 吸附到攻擊方正前方
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
    fighter.snapToCurrentAction() // 演出停頓期間顯示絕招的第 1 幀（不從之前的動作淡入）
    this._playMoveSounds(fighter.moves[key], 1) // 第 1 幀音效：按下絕招的瞬間
    this.scene.updateMatrixWorld()
    fighter.updateBoxes()

    const fromTarget = this.controls.target.clone()
    const fromOffset = this.camera.position.clone().sub(fromTarget) // 一般鏡頭相對注視點的位置
    const zoomTarget = new THREE.Vector3(fighter.x, this.characterHeight * 0.7, 0)
    const zoomPos = zoomTarget.clone().addScaledVector(fromOffset.clone().normalize(), this.superCamera.distance)

    this.cinematic = { fighter, time: 0, fromTarget, fromOffset, zoomPos, zoomTarget }
    this.controls.enabled = false
  }

  /**
   * 邊界推擠：對手的擊退距離超過到邊界的空間時，超出的部分改成攻擊方往後退
   * 擊退速度每秒衰減 e^-8，總距離約 = 初速 / 8
   */
  _applyCornerPush(attacker, target) {
    const v = target.knockVelocity
    if (!v) return
    const dir = Math.sign(v)
    const wall = dir * (this.stageHalfWidth - target.pushHalfWidth)
    const room = Math.max(0, (wall - target.x) * dir)
    const distance = Math.abs(v) / 8
    if (distance <= room) return
    attacker.pushVelocity = -dir * (distance - room) * 8
  }

  /** 受擊搖晃：頓幀 frames 幀內沿 z 軸搖完 cycles 次 */
  _startShake(fighter, frames, cycles = this.hitShake.cycles) {
    if (this.shake) this.shake.fighter.model.position.z = 0
    this.shake = { fighter, time: 0, duration: frames / FPS, cycles }
  }

  /**
   * 跟著畫面更新（頓幀期間遊戲邏輯不推進）
   * 相位多加半幀：60Hz 下每幀剛好取到波峰 / 波谷，頓幀只有 4 幀也看得出左右各兩次
   */
  _updateShake(delta) {
    const s = this.shake
    if (!s) return
    s.time += delta
    const model = s.fighter.model
    if (s.time >= s.duration) {
      model.position.z = 0
      this.shake = null
      return
    }
    const { amplitude } = this.hitShake
    const { cycles } = s
    const phase = (s.time + 0.5 / FPS) / s.duration
    model.position.z = amplitude * Math.sin(Math.PI * 2 * cycles * phase)
  }

  /** 衝刺取消的停頓：第 animStartFrame 幀起，衝刺的人先播衝刺動畫（其他一切仍停住） */
  _updateRushFreeze() {
    const rf = this.rushFreeze
    if (!rf) return
    rf.frame++
    const { fighter } = rf
    if (rf.frame === fighter.rush.animStartFrame) fighter.startRushAnim()
    if (rf.frame >= fighter.rush.animStartFrame) fighter.mixer.update(1 / FPS)
  }

  _togglePause() {
    this.params.paused = !this.params.paused
    this.pauseController?.updateDisplay()
  }

  /** Esc：中斷所有招式、演出、頓幀、吸附、輸入預約與音效，雙方回到站立（位置保留） */
  resetAll() {
    if (!this.p1 || !this.p2) return
    if (this.cinematic) {
      // 鏡頭直接回到一般位置
      const c = this.cinematic
      const target = c.fromTarget.clone()
      target.x = (this.p1.x + this.p2.x) / 2
      this.camera.position.copy(target).add(c.fromOffset)
      this.controls.target.copy(target)
      this.controls.enabled = true
      this.cinematic = null
    }
    if (this.superSpot) this.superSpot.light.intensity = 0
    if (this.shake) this.shake.fighter.model.position.z = 0
    this.shake = null
    this.lock = null
    this.hitstopTimer = 0
    this.rushFreeze = null
    this.accumulator = 0
    this.isRushFrozen = false
    this.rushLife = 0
    this.pendingAttack = null
    this.pendingDash = { p1: 0, p2: 0 }
    this.bufferedAttack = null
    this.combo = 0
    this.hud.setCombo(0)
    this.sound.stopAll()
    this.p1.resetToIdle()
    this.p2.resetToIdle()
  }

  /** 播放招式在第 frame 幀的音效 */
  _playMoveSounds(move, frame) {
    move.sounds?.forEach(s => {
      if ((s.frame ?? 1) === frame) this.sound.play(s.name, s.delay)
    })
  }

  /** 演出中是否暫停遊戲：只有拉近 + 停留期間暫停，拉回時遊戲已經繼續 */
  _isFrozen() {
    const { zoomIn, hold } = this.superCamera
    return !!this.cinematic && this.cinematic.time < zoomIn + hold
  }

  /** 絕招演出：拉近 → 停留 → 拉回，同時打光；拉回的終點是跟著人物移動的一般鏡頭位置 */
  _updateCinematic(delta) {
    const c = this.cinematic
    const { zoomIn, hold, zoomOut, spotFadeIn } = this.superCamera
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

    // 聚光燈：spotFadeIn 秒亮起，鏡頭開始拉回時同步淡出，跟著人物移動
    const backT = t - zoomIn - hold
    const amount = backT > 0 ? Math.max(0, 1 - backT / zoomOut) : Math.min(1, t / spotFadeIn)
    const { light: spot, offset, aim, peak } = this.superSpot
    spot.intensity = peak * amount
    spot.position.set(c.fighter.x + offset.x, offset.y, offset.z)
    spot.target.position.set(c.fighter.x + aim.x, aim.y, aim.z)

    if (t >= zoomIn + hold + zoomOut) {
      spot.intensity = 0
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
      this._updateRushFreeze()
      return
    }
    this.rushFreeze = null

    const p1Input = this._getP1Input()

    // 衝刺取消：按下的瞬間（或預約後碰到對手時）發光並頓幀，頓幀結束的下一幀才開始衝刺
    if ((p1Input.rush || this.p1.rushQueued) && this.p1.canRush && !this.isRushFrozen) {
      this.p1.startGlow()
      this.hitstopTimer = this.p1.rush.freezeFrames
      this.rushFreeze = { fighter: this.p1, frame: 0 }
      if (p1Input.attack && !this.pendingAttack) this.pendingAttack = p1Input.attack // 同一幀按的招式留到停頓結束再交給 Fighter 記住
      this.rushLife = 1 // 頓幀期間不會讀輸入，結束後的下一幀交給 Fighter 開始衝刺
      this.isRushFrozen = true
      return
    }
    this.isRushFrozen = false

    // 絕招：先進入演出，遊戲暫停到鏡頭拉近 + 停留結束，之後才從招式第 0 幀開始推進
    // 絕招：能動時、衝刺取消中、或動作的最後一幀（預約的絕招從上一個動作的結尾直接接上）
    const p1 = this.p1
    const chainSuper = p1.chainKey && p1.moves[p1.chainKey]?.isSuper && p1.connected && p1.state === 'attack' && p1.framesUntilFree <= 1 ? p1.chainKey : null
    const rushSuper = p1.isRushReady && p1.moves[p1.rushAttack]?.isSuper ? p1.rushAttack : null
    const superKey = chainSuper || (p1.moves[p1Input.attack]?.isSuper ? p1Input.attack : null) || rushSuper
    // 普通拳的攻擊判定期間按絕招：直接中斷出絕招（不論有沒有打中）
    const isSuperCancel = p1.state === 'attack' && !p1.getCurrentMove()?.isSuper && p1.getFrameType() === 'active'
    if (superKey && (chainSuper || isSuperCancel || p1.canAct || p1.isRushReady || (p1.framesUntilFree <= 1 && !p1.isRush))) {
      p1.rushAttack = null
      this.bufferedAttack = null
      p1.startedMove = false
      this._startSuper(p1, superKey)
      return
    }

    this.prevX = new Map([[this.p1, this.p1.x], [this.p2, this.p2.x]]) // 最遠距離用：判斷這幀是誰往外移動
    this.p1.update(p1Input)
    this.p2.update(this._getP2Input())
    if (this.p1.usedRush) {
      this.rushLife = 0
      this.p1.usedRush = false
    }
    // 收招預約：開始出招就用掉；已經能動卻沒出招（例如在空中）就丟掉
    if (this.p1.startedMove || this.p1.canAct) this.bufferedAttack = null
    this.p1.startedMove = false
    this._updateDashThrough()
    this._checkGrabs()
    this._updateLock()
    this._resolvePush()
    this.p1.faceTo(this.p2.x)
    this.p2.faceTo(this.p1.x)

    this.scene.updateMatrixWorld()
    this.p1.updateBoxes()
    this.p2.updateBoxes()
    this._checkHits()
    this.frameMeter.record([this.p1.getFrameType(), this.p2.getFrameType()])

    // 招式音效：第 2 幀以後在這裡播（第 1 幀在出招時播，避免定格那幀重複）
    ;[this.p1, this.p2].forEach(f => {
      const move = f.getCurrentMove()
      const frame = f.moveFrame
      if (move?.sounds && frame > 1 && f.soundFrame !== frame) {
        f.soundFrame = frame
        this._playMoveSounds(move, frame)
      }
      if (!move) f.soundFrame = 0
    })

    // 倒地音效：被打飛後第 knockdownSoundFrame 幀
    ;[this.p1, this.p2].forEach(f => {
      if (f.state === 'down' && f.stateFrame === this.knockdownSoundFrame) this.sound.play('knockdown')
    })
  }

  _animate = () => {
    requestAnimationFrame(this._animate)
    // 切分頁回來時 delta 可能很大，限制上限避免一次補太多幀
    const realDelta = Math.min(this.clock.getDelta(), 0.1)

    if (this.cinematic) this._updateCinematic(realDelta)

    const fighters = this.p1 && this.p2 ? [this.p1, this.p2] : []
    if (fighters.length) {
      const step = 1 / FPS
      if (!this._isFrozen()) {
        this.accumulator += this.params.paused ? 0 : realDelta * this.params.timeScale
        // 絕招演出開始後剩下的時間不再補幀
        while (this.accumulator >= step && !this._isFrozen()) {
          this.accumulator -= step
          this._step()
          fighters.forEach(f => f.captureFrame())
        }
        if (this._isFrozen()) this.accumulator = 0
      }

      // 畫面補間：在上一幀與這一幀之間內插（凍結 / 暫停時直接顯示這一幀）
      const alpha = this._isFrozen() || this.params.paused ? 1 : this.accumulator / step
      fighters.forEach(f => f.applyInterpolation(alpha))
      this._updateShake(this.params.paused ? 0 : realDelta * this.params.timeScale)

      if (!this.cinematic) this._followCamera(realDelta)
      this.hud.updateCoords(fighters)
    }

    // 演出中由 _updateCinematic 控制鏡頭
    if (!this.cinematic) this.controls.update()
    this.hud.update(realDelta)

    this.renderer.render(this.scene, this.camera)
    // 還原成邏輯幀的姿勢，下一次 _step 從正確的狀態繼續
    fighters.forEach(f => f.restoreFrame())
  }
}

// 掛到 window 方便在 DevTools console 裡直接查看，例如 viewer.p1、viewer.p2
window.viewer = new FighterViewer()
