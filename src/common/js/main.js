import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import GUI from 'three/addons/libs/lil-gui.module.min.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { Fighter, FPS } from './fighter.js'
import { FrameMeter } from './frameMeter.js'
import { MixamoLoader } from './mixamoLoader.js'
import { Stage } from './stage.js'
import { Hud } from './hud.js'
import { Sound } from './sound.js'
import { HitEffect } from './hitEffect.js'
import { FootMarker } from './footMarker.js'
import { addSmileMorph } from './faceMorph.js'
import { FighterAI } from './ai.js'

const MODEL_DIR = 'src/model'
const SOUND_DIR = 'src/sound'
const SUPER_ARTS = ['dog_bear', 'kick_ball', 'monkey_turn', 'shake_head', 'dodge_step', 'wind_step']

/**
 * FighterViewer：雙人對戰場景
 * 流程：建立場景 → 載入人物 FBX 與共用動作 FBX，在程式裡綁定（見 mixamoLoader.js）
 *       → 建立 P1 / P2 Fighter → 固定 60fps 推進遊戲邏輯（_step）：
 *         輸入 → 人物更新 → 吸附 → 推擠 → 面向 → 命中判定 → 連段 → 幀數表
 *       → 畫面更新（_animate）：絕招演出、鏡頭、HUD 與渲染，跟螢幕更新率走
 * 絕招演出：鏡頭拉近 + 停留期間只有放招的人推進招式（幀數表記成凍結中的前搖），其他一切暫停；鏡頭拉回時遊戲已經繼續
 * P2 用方向鍵操作（← → 移動 / 防禦、↑ 跳、↓ + 後原地防禦），按著 Shift 再按 P1 的數字鍵 = P2 出招；GUI 勾選「AI 操作」時改由 ai.js 操作
 */
class FighterViewer {
  constructor(options) {
    const def = {
      el: '#stage',
      characters: [
        { name: 'Meshy', url: `${MODEL_DIR}/characters/meshy.glb`, brightness: 1.35, smile: { corners: [[-0.034, 1.556], [0.034, 1.556]], radius: 0.014, lift: 0.007, outward: 0.003, back: 0.002, minZ: 0.05 } },
        { name: 'Meshy_old', url: `${MODEL_DIR}/characters/meshy_old.glb`, brightness: 1.35, smile: { corners: [[-0.034, 1.556], [0.034, 1.556]], radius: 0.014, lift: 0.007, outward: 0.003, back: 0.002, minZ: 0.05 } },
        { name: 'Bladman', url: `${MODEL_DIR}/characters/bladman.glb` },
        { name: 'Erika', url: `${MODEL_DIR}/characters/erika.glb` },
        { name: 'Remy', url: `${MODEL_DIR}/characters/remy.glb` },
        // Meshy：AccuRIG 重新綁骨架（骨頭改成 mixamorig 名稱，手只有拇指、食指）；Meshy_old：Meshy 匯出（Mixamo 骨架範本）
        // brightness：材質顏色倍率（貼圖偏暗）
        // smile：程式推嘴角做出微笑（模型沒有表情，見 faceMorph.js），座標是模型原始網格座標（公尺）
        // Yvonne：AccuRIG 綁骨架、骨頭改成 mixamorig 名稱；角與頭髮比頭頂高約 19 公分，height 算進去，身體才跟其他人物差不多高
        { name: 'Yvonne', url: `${MODEL_DIR}/characters/yvonne.glb`, height: 1.93 },
      ],
      // 所有人物共用的動作（Mixamo 下載時選 Without Skin）；key 對應 Fighter 的狀態與招式（moves）
      anims: {
        idle: `${MODEL_DIR}/anims/normal/Idle.fbx`,
        walk: `${MODEL_DIR}/anims/normal/Walking.fbx`,
        dash: `${MODEL_DIR}/anims/normal/Walking_dash.fbx`, // 衝刺（地面 / 空中 / 衝刺取消共用），後衝倒著播
        hit: `${MODEL_DIR}/anims/normal/HitTo.fbx`,
        light: `${MODEL_DIR}/anims/normal/Punching_L.fbx`,
        medium: `${MODEL_DIR}/anims/normal/Punching_M.fbx`,
        heavy: `${MODEL_DIR}/anims/normal/Punching_H.fbx`,
        airHeavy: `${MODEL_DIR}/anims/normal/MmaKick.fbx`, // 空中重攻擊
        fly: `${MODEL_DIR}/anims/normal/FlyingBack.fbx`, // 被打飛（招式的 launch）、浮空挨打（lock.juggle）
        getUp: `${MODEL_DIR}/anims/normal/KipUp.fbx`, // 飛走後起身
        jump: `${MODEL_DIR}/anims/normal/Jumping.fbx`,
        block: `${MODEL_DIR}/anims/normal/BodyBlock.fbx`,
        ...Object.fromEntries(SUPER_ARTS.map(name => [name, `${MODEL_DIR}/anims/superArt/${name}.fbx`])),
      },
      // 有 root motion 的動作：保留臀部前後位移曲線，由程式轉成人物座標（其餘動作完全原地播放）
      rootMotionAnims: ['fly', ...SUPER_ARTS],
      // root motion 改取臀部的 X（側向）位移：動畫朝側面表演的招式（例如 faceCamera）
      rootMotionAxisX: ['shake_head'],
      // 動畫自己會往上跳的動作：拿掉臀部往上的位移（保留下蹲），高度改由程式的拋物線控制
      flattenRiseAnims: ['jump'],
      // 第一幀臀部就偏離中心（整個人偏出判定框）的動作：臀部水平位置固定在原點，而不是第一幀的位置
      centerHipsAnims: [],
      // 裁掉動作開頭 start / 結尾 end 幾幀（遊戲幀），不改 FBX 檔；招式的 startup / recovery / hits 照裁切後的幀數
      trimAnims: {
        // Rokoko 匯出的絕招第 0 幀是 T 字形：裁掉 2 幀（= 30F 檔的第 0 幀），絕招停頓時才不會看到
        dog_bear: { start: 7, end: 10 }, // 開頭多裁 5 幀（招式幀數已跟著往前挪）
        kick_ball: { start: 2 },
        monkey_turn: { start: 2 },
        shake_head: { start: 2 },
        dodge_step: { start: 2 }, // 第 2 次起從第 50 幀開始（2 + fighter.js firstPassDelay 48）
        wind_step: { start: 2, end: 20 },
        light: { start: 2, end: 4 },
        medium: { start: 5 },
        heavy: { start: 4 },
        block: { start: 3 }, // 防禦動作
        hit: { start: 6 }, // 受擊動作
      },
      // 動作開頭加快：前 to 幀（遊戲幀，裁切後）用 rate 倍速播完，之後照原速；招式幀數照加快後的時間
      speedAnims: {
        wind_step: { to: 60, rate: 2 }, // 跳躍段（前 60 幀）2 倍速 → 30 幀落地
      },
      // 3D 場景（GUI 可切換）：
      //   model = GLB；ground = 地面平面 y = a·x + b·z + c（模型原始座標，公尺），載入後轉平、對齊 y = 0，人物才會剛好站在地上
      //   transform = 預設擺放（切換到這個場景時套用，之後可在 GUI 調）：x / y / z 位移（公尺）、rotation 水平轉動（度）、scale 大小
      //     z 正數 = 場景往鏡頭方向移（人物站到模型裡比較後面的位置）
      scenes: {
        庭院: { model: `${MODEL_DIR}/background/courtyard.glb`, ground: [0.0252, -0.0414, 0.6321], transform: { x: -0.3, y: -0.03, z: 4, rotation: 0, scale: 0.9 } },
        // 模型中央是房子與門口台階：往後移，人物站在房子前的空地，房子當背景
        閥門房: { model: `${MODEL_DIR}/background/bayard_station_valve_house.glb`, ground: [0.0013, -0.0167, 9.416], transform: { x: 1.5, y: -0.05, z: -8.1, rotation: 0, scale: 0.9 } },
        // 人物站在橋下的地面
        橋下: { model: `${MODEL_DIR}/background/rick_roll_bridge.glb`, ground: [0.0049, 0.0115, -4.9441], transform: { x: 0, y: -0.03, z: 0, rotation: 0, scale: 1 } },
      },
      // 天空（GUI 可切換）：2:1 全景圖，當作無限遠的背景，3D 場景沒擋住的地方看得到
      skies: {
        晴天: 'src/common/img/DaySkyHDRI026A_4K_TONEMAPPED.jpg',
        機庫外陰天: 'src/common/img/hanger_exterior_cloudy.webp',
      },
      dashTapWindow: 250, // 連按兩下方向鍵的間隔（毫秒）內算衝刺
      timeScaleStep: 0.1, // 遊戲速度快捷鍵（- / =）每按一下調多少
      characterHeight: 1.75, // 人物身高（公尺）：模型原始尺寸不同，載入後縮放成一致；characters 可個別填 height
      stageHalfWidth: 7.5, // 場地邊界 x = ±7.5
      startGap: 1.6, // 開場兩人距離
      maxDistance: 5, // 兩人最遠距離（公尺），超過時往外移動的一方被擋住
      rushInputFrames: 8, // 衝刺取消鍵按下後記住幾幀：跟出招鍵差幾幀內按都算
      bufferFrames: 8, // 任何動作結束前幾幀內按攻擊 / 絕招鍵會記住，動作最後一幀接著出招
      dashBufferFrames: 5, // 前前 / 後後的最後幾幀內按攻擊 / 絕招 / 再次衝刺會記住，衝刺結束接著出
      hitstopFrames: 3, // 命中時雙方停頓幀數（頓幀）；招式有填 hitstop 時用招式的
      // 受擊搖晃（招式有 hitShake 才搖）：被打中的人在頓幀期間沿 z 軸來回搖 cycles 次（頓幀越長搖得越慢）
      hitShake: { cycles: 2, amplitude: 0.15 },
      // 鏡頭晃動：命中時鏡頭上下左右抖 frames 幀、每秒 frequency 次，幅度線性減弱到 0
      // 招式有 cameraShake 照招式的；沒填的絕招用 superAmplitude（絕招命中不頓幀，改用晃鏡頭表現打擊感），一般招式不晃
      cameraShake: { frames: 12, frequency: 25, superAmplitude: 0.03 },
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
        wind_step_title: { url: `${SOUND_DIR}/wind_step_title.wav`, volume: 0.8 },
      },
      knockdownSoundFrame: 35, // 被打飛後第幾幀播倒地音效（身體碰到地面的時間點）
      // 絕招演出（遊戲幀）：鏡頭拉近 → 停留 → 拉回（遊戲繼續）
      // 拉近 + 停留期間其他一切凍結，放招的人從招式的 animStart 開始播（招式幀數推進、但不做命中判定）
      // 用遊戲幀計時：跟著 GUI 的遊戲速度、暫停，演出跟招式幀數永遠對得上
      superCamera: {
        zoomIn: 20,
        hold: 20,
        zoomOut: 20,
        distance: 3, // 拉近後鏡頭與人物胸口的距離（公尺）
        spotFadeIn: 10, // 聚光燈亮起幀數；鏡頭開始拉回時同步淡出
        dimLevel: 0.5, // 演出時場地燈光、背景變暗到原本的幾成（跟聚光燈同步淡入淡出）；1 = 不變暗
        // 演出時場地的霧（人物不受影響）：離鏡頭 fogNear ~ fogFar 公尺漸濃，鏡頭拉回時淡掉
        fogColor: 0x15161c,
        fogNear: 2,
        fogFar: 40,
      },
      // 命中鏡頭（招式的 hitCamera）的預設值；招式填物件可個別覆蓋。距離同 superCamera.distance
      hitCamera: {
        angle: 60, // 從正後方往畫面前方（鏡頭那側）偏幾度
        height: 0, // 鏡頭比注視點（胸口）高多少公尺
        lookAhead: { x: 0.3, y: -0.3 }, // 注視點從攻擊方胸口偏多少公尺：x = 往對手方向、y = 往上
        blendIn: 20, // 拉近幀數
        blendOut: 20, // 拉回幀數
      },
      // 用 e.code 判斷，開著中文輸入法也能操作
      p1Keys: {
        left: 'KeyA',
        right: 'KeyD',
        jump: ['KeyW', 'Space'], // W 或空白鍵垂直跳，加 A / D 斜跳；可填一個或多個 e.code
        down: 'KeyS', // 下 + 後 = 站在原地防禦（不後退）
        light: 'Numpad7',
        medium: 'Numpad8',
        heavy: 'Numpad9',
        rush: 'Numpad0', // 輕 / 中 / 重攻擊打中後：發光 + 往前衝刺；預約時段內先按會在打中時觸發
        super: 'Numpad3', // 招式由 GUI「招式選取」決定
        // 固定招式的絕招鍵：按鍵 → 招式 key
        supers: { Numpad1: 'dog_bear', Numpad2: 'shake_head', Numpad4: 'dodge_step', Numpad5: 'kick_ball', Numpad6: 'wind_step' },
      },
      p2Keys: {
        left: 'ArrowLeft',
        right: 'ArrowRight',
        jump: 'ArrowUp', // ↑ 垂直跳，↑ + ← / → 斜跳
        down: 'ArrowDown', // ↓ + 後 = 站在原地防禦（不後退）
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
    this.keycapEls = document.querySelectorAll('[data-key]')

    // 4. setup runtime state
    this.clock = new THREE.Clock()
    this.mixamo = new MixamoLoader()
    this.sourceCache = {} // url → Promise<{ scene, clips }>，同一個人物只綁定一次
    this.p1 = null
    this.p2 = null
    this.keys = new Set()
    // 每個玩家的輸入狀態（鍵盤或 AI 都經過這裡）：
    //   pendingAttack：按下的那一幀才算出招，按住不連發；下一幀遊戲邏輯取走
    //   rushLife：衝刺取消鍵按下後還記住幾幀（出招鍵稍晚按也能預約）；被用掉就清 0
    //   bufferedAttack：收招結束前 bufferFrames 幀內按的招式：{ key, life }，能動的第一幀出招
    this.input = { p1: this._newInputState(), p2: this._newInputState() }
    this.ai = { p1: new FighterAI(), p2: new FighterAI() } // GUI 勾選「AI 操作」時由 AI 按鍵
    this.pendingDash = { p1: 0, p2: 0 } // 連按兩下方向鍵：衝刺方向（世界座標），下一幀遊戲邏輯取走
    this.lastTap = { p1: { code: '', time: 0 }, p2: { code: '', time: 0 } } // 上一次按下的方向鍵，判斷連按用
    this.skyCache = {} // 天空名稱 → texture
    this.envModel = null // 目前的 3D 場景模型（Group）
    this.envCache = {} // 場景名稱 → Promise<Group>，同一個場景模型只載入一次
    this.cameraPull = 0 // 跳躍時鏡頭額外往後拉的距離
    this.hitCam = null // 命中鏡頭中：{ attacker, move, phase: 'in' / 'out', time, fromPos, fromTarget, base: { target, offset } }
    this.hitstopTimer = 0 // 剩餘頓幀數
    this.rushFreeze = null // 衝刺取消停頓中：{ fighter, frame }，停頓到第 animStartFrame 幀開始播衝刺動畫
    this.shake = null // 受擊搖晃中：{ fighter, time, duration }（秒）
    this.camShake = null // 鏡頭晃動中：{ amp, time, duration, phase }（秒）
    this.camShakeOffset = new THREE.Vector3() // 這個畫面加在鏡頭上的晃動位移（渲染後扣回去）
    this.accumulator = 0 // 尚未消化的時間，累積滿 1/60 秒就推進 1 幀
    this.superDim = 0 // 絕招演出的變暗程度（0 = 正常、1 = 暗到 dimLevel）
    this.superFog = null // 絕招演出的場地霧（THREE.Fog），平常推到很遠等於沒有霧
    this.cinematic = null // 絕招演出中：{ fighter, time, frozenSteps, animStart, fromTarget, fromOffset, zoomPos, zoomTarget }
    this.lock = null // 吸附中：{ attacker, target, offset, isGrab, lift（lock.juggle 開始後）, juggleHits, seg }
    this.combos = { p1: 0, p2: 0 } // 各玩家目前連段數
    this.superSpot = null // 絕招聚光燈：{ light, aim, peak }
    this.frameMeter = new FrameMeter()
    this.sound = new Sound({ files: this.sounds })
    this.isLoading = false
    this.params = {
      p1: this.characters[0].name,
      p2: this.characters[1].name,
      superMove: 'monkey_turn', // 3 鍵的絕招（其他絕招都有固定按鍵）
      p2Guard: false, // P2 木樁一直按著後（防禦）
      p1AI: false, // P1 由 AI 操作
      p2AI: false, // P2 由 AI 操作
      scene: '閥門房',
      sky: '晴天',
      skyRotation: 16, // 天空水平轉動角度（度）
      // 目前 3D 場景的擺放（切換場景時換成該場景的 transform）：水平轉動（度）、位移（公尺；y 負數 = 往下）、大小倍率
      envRotation: 0,
      envOffsetX: 0,
      envOffsetY: 0,
      envOffsetZ: 0,
      envScale: 1,
      showGround: true, // 影子地板
      timeScale: 1,
      paused: false,
      moveSpeed: 2,
      showDebug: true, // 除錯顯示（O）：X 軸刻度尺與座標 + 判定框
      showUi: true, // 介面顯示（I）：幀數表、左下按鍵與操作說明
      showCombo: true, // 連段數顯示（不受 I 影響）
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
      // 出招鍵（數字鍵）：按著 Shift = P2 出招，否則 P1；該玩家由 AI 操作時不理會
      const isAttackKey = this._isAttackKey(e.code)
      const slot = isAttackKey && this._isShiftAttack(e) ? 'p2' : 'p1'
      if (!e.repeat && isAttackKey && !this.params[`${slot}AI`]) {
        const st = this.input[slot]
        if (e.code === this.p1Keys.light) st.pendingAttack = 'light'
        if (e.code === this.p1Keys.medium) st.pendingAttack = 'medium'
        if (e.code === this.p1Keys.heavy) st.pendingAttack = 'heavy'
        if (e.code === this.p1Keys.rush) st.rushLife = this.rushInputFrames
        if (e.code === this.p1Keys.super) st.pendingAttack = this.params.superMove
        if (this.p1Keys.supers[e.code]) st.pendingAttack = this.p1Keys.supers[e.code]
      }
      if (!e.repeat) {
        this._detectDash('p1', e.code)
        this._detectDash('p2', e.code)
      }
      if (!e.repeat && e.code === 'KeyP') this._togglePause()
      if (!e.repeat && e.code === 'Escape') this.resetAll()
      // 介面 / 除錯 / AI / 遊戲速度快捷鍵；在 GUI 輸入框打字時不觸發
      if (!e.target.closest?.('input, textarea, select')) {
        if (!e.repeat && e.code === 'KeyO') this._setDebugVisible(!this.params.showDebug)
        if (!e.repeat && e.code === 'KeyI') this._setUiVisible(!this.params.showUi)
        if (!e.repeat && e.code === 'KeyU') this._toggleAllAI()
        // 遊戲速度：主鍵盤 Backspace 左邊的 - / =（數字鍵盤的 - + 不算，e.code 不同）；按住會連續調
        if (e.code === 'Minus') this._changeTimeScale(-this.timeScaleStep)
        if (e.code === 'Equal') this._changeTimeScale(this.timeScaleStep)
      }
      // 方向鍵、空白鍵預設會捲動頁面（空白鍵也會按到 GUI 上有焦點的按鈕）
      if (Object.values(this.p2Keys).includes(e.code) || [this.p1Keys.jump].flat().includes(e.code)) e.preventDefault() // ↓ 也會捲動頁面
      this.keys.add(e.code)
      this._updateKeycaps()
    })

    window.addEventListener('keyup', e => {
      this.keys.delete(e.code)
      this._updateKeycaps()
    })

    // 切換視窗時 keyup 不會觸發，避免人物一直走
    window.addEventListener('blur', () => {
      this.keys.clear()
      this._updateKeycaps()
    })
  }

  /** 出招鍵（輕 / 中 / 重 / 衝刺取消 / 絕招）：P1 直接按、P2 按著 Shift 按同一組鍵 */
  _isAttackKey(code) {
    const k = this.p1Keys
    return [k.light, k.medium, k.heavy, k.rush, k.super].includes(code) || !!k.supers[code]
  }

  /**
   * 出招鍵是否按著 Shift（= P2 出招）
   * Windows 在 NumLock 開著時，Shift + 數字鍵盤會被系統暫時放開 Shift、改送 Home / ↑ / Insert 等鍵：
   * e.shiftKey 是 false，但 e.key 不是數字，用這點判斷（e.code 仍是 Numpad7 等，所以出招鍵照常對得上）
   */
  _isShiftAttack(e) {
    if (e.shiftKey) return true
    return e.code.startsWith('Numpad') && e.getModifierState('NumLock') && !/^\d$/.test(e.key)
  }

  /** 介面顯示 / 隱藏（I、GUI「顯示介面」）：幀數表、左下按鍵與操作說明一起（連段數另外開關，見 _setComboVisible） */
  _setUiVisible(isVisible) {
    this.params.showUi = isVisible
    document.querySelectorAll('#frameMeter, .index_keys').forEach(el => el.classList.toggle('is_uiHide', !isVisible))
    this.guiControllers?.showUi.updateDisplay()
  }

  /** 連段數顯示 / 隱藏（GUI「顯示連段數」） */
  _setComboVisible(isVisible) {
    this.params.showCombo = isVisible
    document.querySelectorAll('.index_combo').forEach(el => el.classList.toggle('is_uiHide', !isVisible))
  }

  /** 除錯顯示（O、GUI「顯示除錯」）：X 軸刻度尺與座標、判定框一起 */
  _setDebugVisible(isVisible) {
    this.params.showDebug = isVisible
    this.stage.setRulerVisible(isVisible)
    this.hud.setCoordsVisible(isVisible)
    ;[this.p1, this.p2].filter(Boolean).forEach(f => f.setDebugVisible(isVisible))
    this.guiControllers?.showDebug.updateDisplay()
  }

  /** P1、P2 的 AI 操作一起開關（U）：兩個都開著就全部關掉，否則全部打開 */
  _toggleAllAI() {
    const isOn = !(this.params.p1AI && this.params.p2AI)
    ;['p1', 'p2'].forEach(slot => {
      if (this.params[`${slot}AI`] === isOn) return
      this.params[`${slot}AI`] = isOn
      this._resetAI(slot)
    })
    this.guiControllers?.p1AI.updateDisplay()
    this.guiControllers?.p2AI.updateDisplay()
  }

  /** 遊戲速度加減（- / =），0 ~ 2 */
  _changeTimeScale(delta) {
    this.params.timeScale = Math.round(Math.min(2, Math.max(0, this.params.timeScale + delta)) * 100) / 100
    this.guiControllers?.timeScale.updateDisplay()
  }

  /** 3 鍵的按鍵示意：顯示 GUI「招式選取」目前選的招式名稱 */
  _updateSuperKeyLabel() {
    const el = document.querySelector('#superKeyName')
    if (el) el.textContent = this.params.superMove
  }

  /** 畫面左下的按鍵示意：按著的鍵亮起 */
  _updateKeycaps() {
    this.keycapEls.forEach(el => el.classList.toggle('is_down', this.keys.has(el.dataset.key)))
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

    this._endHitCamera() // 換人物：命中鏡頭直接回到一般鏡頭
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
    if (slot === 'p1') this.footMarker.setTarget(this.p1)
    if (this.p1 && this.p2) {
      this.p1.opponent = this.p2
      this.p2.opponent = this.p1
    }

    this.isLoading = false
    this._showLoading(false)
  }

  /** 切換 AI 操作：清掉 AI 的狀態與殘留的按鍵 */
  _resetAI(slot) {
    this.ai[slot].reset()
    this.input[slot] = this._newInputState()
  }

  /** 切換天空：全景圖當作無限遠的背景，載入過的會快取 */
  setSky(name) {
    const url = this.skies[name]
    if (!url) return
    this.params.sky = name
    if (this.skyCache[name]) {
      this._applySky(this.skyCache[name])
      return
    }
    new THREE.TextureLoader().load(url, texture => {
      texture.mapping = THREE.EquirectangularReflectionMapping
      texture.colorSpace = THREE.SRGBColorSpace
      this.skyCache[name] = texture
      // 載入期間又切到別張時不覆蓋
      if (this.params.sky === name) this._applySky(texture)
    })
  }

  _applySky(texture) {
    this.scene.background = texture
    this._applySkyRotation()
    this._applyStageLight()
  }

  /** 切換 3D 場景：載入完放進場景；地面自己會接影子，影子地板先藏起來（疊在一起會有兩層影子） */
  setScene(name) {
    const entry = this.scenes[name]
    if (!entry) return
    this.params.scene = name
    const { x = 0, y = 0, z = 0, rotation = 0, scale = 1 } = entry.transform || {}
    Object.assign(this.params, { envOffsetX: x, envOffsetY: y, envOffsetZ: z, envRotation: rotation, envScale: scale })
    if (!this.envCache[name]) this.envCache[name] = this._loadEnvModel(name, entry)
    this.envCache[name].then(group => {
      if (!group || this.params.scene !== name) return // 載入期間又切到別的場景
      if (this.envModel && this.envModel !== group) this.scene.remove(this.envModel)
      this.envModel = group
      this.scene.add(group)
      this._applyEnvTransform()
      this.stage?.setGroundVisible(false)
    })
  }

  /**
   * 載入 3D 場景模型：外層 Group 管 GUI 的轉動與高度（見 _applyEnvTransform），內層把地面平面轉平、往下移到 y = 0
   * @returns {Promise<THREE.Group | null>} 載入失敗回傳 null（之後再選一次會重新載入）
   */
  async _loadEnvModel(name, { model, ground = [0, 0, 0] }) {
    if (!this.isLoading) this._showLoading(true, name)
    try {
      const gltf = await new GLTFLoader().loadAsync(model, e => this._onProgress(e, name))
      gltf.scene.traverse(obj => {
        if (obj.isMesh) obj.receiveShadow = true
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
      console.warn(`[FighterViewer] 場景模型 ${model} 載入失敗`, err)
      delete this.envCache[name]
      return null
    } finally {
      if (!this.isLoading) this._showLoading(false)
    }
  }

  /** 天空水平轉動 */
  _applySkyRotation() {
    this.scene.backgroundRotation.y = THREE.MathUtils.degToRad(this.params.skyRotation)
  }

  /** 3D 場景模型的水平轉動（繞場地中心）、位移與大小 */
  _applyEnvTransform() {
    if (!this.envModel) return
    const { envRotation, envOffsetX, envOffsetY, envOffsetZ, envScale } = this.params
    this.envModel.rotation.y = THREE.MathUtils.degToRad(envRotation)
    this.envModel.position.set(envOffsetX, envOffsetY, envOffsetZ)
    this.envModel.scale.setScalar(envScale)
  }

  /** 打鬥場地寬度（邊界 x = ±stageHalfWidth）：邊界牆、刻度尺、影子範圍一起更新；人物超出的話下一幀被推回邊界內 */
  _applyStageWidth() {
    this.stage.setHalfWidth(this.stageHalfWidth)
    const cam = this.stageLights.dir.shadow.camera
    cam.left = -this.stageHalfWidth - 2
    cam.right = this.stageHalfWidth + 2
    cam.updateProjectionMatrix()
  }

  /** 絕招演出的場地霧：amount 0 = 沒有霧（推到很遠）、1 = fogNear ~ fogFar */
  _applySuperFog(amount) {
    if (!this.superFog) return
    const { fogNear, fogFar } = this.superCamera
    const away = (1 - amount) * 1000
    this.superFog.near = fogNear + away
    this.superFog.far = fogFar + away
  }

  /**
   * 場地亮度 = 絕招演出的變暗；環境光、主光、天空一起調整
   * 絕招聚光燈不受影響，演出時只有放絕招的人被照亮
   */
  _applyStageLight() {
    if (!this.stageLights) return
    const dim = 1 + (this.superCamera.dimLevel - 1) * this.superDim
    const { hemi, dir, base } = this.stageLights
    hemi.intensity = base.hemi * dim
    dir.intensity = base.dir * dim
    this.scene.backgroundIntensity = dim
  }

  // internal

  _setupScene() {
    this.renderer = new THREE.WebGLRenderer({ antialias: true })
    this.renderer.setPixelRatio(window.devicePixelRatio)
    this.renderer.setSize(window.innerWidth, window.innerHeight)
    this.renderer.shadowMap.enabled = true
    this.stageEl.appendChild(this.renderer.domElement)

    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color(0x1b1d22) // 天空載入前的底色
    this.setSky(this.params.sky)
    this.setScene(this.params.scene)

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
    // 場地燈光：記住原本強度，亮度變化都以這個為準（見 _applyStageLight）
    this.stageLights = { hemi, dir, base: { hemi: hemi.intensity, dir: dir.intensity } }
    this._applyStageLight()

    // 霧一直掛在場景上、只改距離：中途才加上或拿掉 scene.fog 會讓所有材質重新編譯，發動絕招時會頓一下
    // 人物材質關掉 fog（見 Fighter），所以只有場地會被霧蓋住
    this.superFog = new THREE.Fog(this.superCamera.fogColor, 0, 1)
    this.scene.fog = this.superFog
    this._applySuperFog(0)

    // 絕招打光：從鏡頭位置往人物照的暖色聚光燈（正面打光，臉上不會有頭頂光的濃陰影），平常強度 0
    // aim 是照射點（相對人物腳底，胸口附近）；distance 0 = 照射距離不限，鏡頭拉回時人物仍照得到
    // 不投影：燈在鏡頭位置時影子都在人物背後看不到，開著反而會在人物身上出現網格狀的 shadow acne
    const spot = new THREE.SpotLight(0xffc040, 0, 0, Math.PI / 7, 0.5, 1.5)
    this.superSpot = { light: spot, aim: new THREE.Vector3(0, 1.3, 0), peak: 60 }
    this.scene.add(spot, spot.target)

    this.stage = new Stage({ scene: this.scene, halfWidth: this.stageHalfWidth, showRuler: this.params.showDebug, showGround: this.params.showGround })
    this.hitEffect = new HitEffect({ scene: this.scene })
    // P1 腳底的淡藍色橢圓（範圍同推擠框）
    this.footMarker = new FootMarker({ scene: this.scene })
    this.hud = new Hud({ camera: this.camera, canvas: this.renderer.domElement, showCoords: this.params.showDebug })
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

    if (config.brightness) this._brightenSource(character.scene, config.brightness)
    if (config.smile) addSmileMorph(character.scene, config.smile)

    const clips = {}
    keys.forEach((key, i) => {
      let clip = this.mixamo.bindAnimation(character, anims[i], key)
      const trim = this.trimAnims[key]
      if (trim) clip = this._trimClip(clip, trim.start ?? 0, trim.end ?? 0)
      const speed = this.speedAnims[key]
      if (speed) clip = this._speedUpClip(clip, speed.to, speed.rate)
      clips[key] = this._makeInPlace(clip, {
        isRootMotion: this.rootMotionAnims.includes(key),
        isFlattenRise: this.flattenRiseAnims.includes(key),
        isAxisX: this.rootMotionAxisX.includes(key),
        isCenterHips: this.centerHipsAnims.includes(key),
      })
    })
    return { scene: character.scene, clips }
  }

  /**
   * 人物變亮：材質顏色（會乘上貼圖）乘上倍率，超過 1 = 比貼圖原色亮
   * 在人物 clone 之前改，Fighter 會把這個顏色當成原色（受擊閃色後回到這個顏色）
   */
  _brightenSource(scene, rate) {
    scene.traverse(obj => {
      if (!obj.isMesh) return
      ;[obj.material].flat().forEach(material => material.color?.multiplyScalar(rate))
    })
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
   * 動作開頭 toFrames 幀（遊戲幀）改成 rate 倍速：key 的時間在這段內除以 rate，之後的整段往前平移
   * 要在 _makeInPlace 之前做，root motion 才會跟著新的時間
   */
  _speedUpClip(source, toFrames, rate) {
    const end = Math.min(toFrames / FPS, source.duration)
    const remap = t => (t <= end ? t / rate : t - end + end / rate)
    const tracks = source.tracks.map(track => new track.constructor(track.name, track.times.map(remap), track.values))
    return new THREE.AnimationClip(source.name, remap(source.duration), tracks)
  }

  /**
   * 原地播放：固定臀部的水平位置，讓位移交給程式控制（格鬥遊戲常用作法）
   * isRootMotion：先把臀部的前後位移（Z）存成 clip.rootMotion，由 Fighter 轉成人物座標
   * isFlattenRise：臀部高度不超過第一格（保留下蹲、拿掉往上跳）
   * isAxisX：root motion 改取側向（X）位移
   * isCenterHips：臀部水平位置固定在原點，而不是第一格的位置
   */
  _makeInPlace(source, { isRootMotion = false, isFlattenRise = false, isAxisX = false, isCenterHips = false } = {}) {
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
    const pinX = isCenterHips ? 0 : startX
    const pinZ = isCenterHips ? 0 : startZ
    for (let i = 0; i < values.length; i += 3) {
      values[i] = pinX
      values[i + 2] = pinZ
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
    gui.add(this.params, 'superMove', SUPER_ARTS).name('招式選取（3 鍵）').onChange(() => this._updateSuperKeyLabel())
    this._updateSuperKeyLabel()
    gui.add(this.params, 'p2Guard').name('P2 木樁防禦')
    this.guiControllers = {} // 快捷鍵改了數值時要更新顯示的控制項
    this.guiControllers.p1AI = gui.add(this.params, 'p1AI').name('P1 由 AI 操作').onChange(() => this._resetAI('p1'))
    this.guiControllers.p2AI = gui.add(this.params, 'p2AI').name('P2 由 AI 操作（U 全開 / 全關）').onChange(() => this._resetAI('p2'))
    gui.add(this.params, 'moveSpeed', 0.5, 5, 0.1).name('移動速度').onChange(v => {
      fighters().forEach(f => { f.moveSpeed = v })
    })

    const bgFolder = gui.addFolder('背景')
    const skyFolder = bgFolder.addFolder('天空盒')
    skyFolder.add(this.params, 'sky', Object.keys(this.skies)).name('天空').listen().onChange(v => this.setSky(v))
    skyFolder.add(this.params, 'skyRotation', 0, 360, 1).name('轉動（度）').onChange(() => this._applySkyRotation())

    const sceneFolder = bgFolder.addFolder('場景')
    sceneFolder.add(this.params, 'scene', Object.keys(this.scenes)).name('3D 場景').listen().onChange(v => this.setScene(v))
    sceneFolder.add(this.params, 'envRotation', 0, 360, 1).name('轉動（度）').listen().onChange(() => this._applyEnvTransform())
    sceneFolder.add(this.params, 'envOffsetX', -20, 20, 0.1).name('左右 X（m）').listen().onChange(() => this._applyEnvTransform())
    sceneFolder.add(this.params, 'envOffsetY', -0.5, 0.5, 0.01).name('高度 Y（m）').listen().onChange(() => this._applyEnvTransform())
    sceneFolder.add(this.params, 'envOffsetZ', -20, 20, 0.1).name('前後 Z（m）').listen().onChange(() => this._applyEnvTransform())
    sceneFolder.add(this.params, 'envScale', 0.2, 3, 0.05).name('大小').listen().onChange(() => this._applyEnvTransform())
    sceneFolder.add(this, 'stageHalfWidth', 2, 15, 0.5).name('打鬥場地半寬（m）').onChange(() => this._applyStageWidth())
    sceneFolder.add(this.params, 'showGround').name('顯示影子地板').onChange(v => this.stage.setGroundVisible(v && !this.envModel))

    bgFolder.add(this.superCamera, 'dimLevel', 0, 1, 0.05).name('絕招時變暗到')

    const playFolder = gui.addFolder('播放設定')
    this.guiControllers.timeScale = playFolder.add(this.params, 'timeScale', 0, 2, 0.05).name('遊戲速度（- / =）')
    this.pauseController = playFolder.add(this.params, 'paused').name('暫停（P）')

    const viewFolder = gui.addFolder('顯示')
    this.guiControllers.showUi = viewFolder.add(this.params, 'showUi').name('顯示介面（I）').onChange(v => this._setUiVisible(v))
    viewFolder.add(this.params, 'showCombo').name('顯示連段數').onChange(v => this._setComboVisible(v))
    this.guiControllers.showDebug = viewFolder.add(this.params, 'showDebug').name('顯示除錯：座標與判定框（O）').onChange(v => this._setDebugVisible(v))
    const debugFolder = viewFolder
    debugFolder.add(this.params, 'showSkeleton').name('顯示骨架').onChange(v => {
      fighters().forEach(f => f.setSkeletonVisible(v))
    })
  }

  /**
   * 輸入預約：動作結束前 bufferFrames 幀內按的招式先記住，能動的第一幀才送出
   * 衝刺取消中、連打等本來就能接受輸入的時機照常送出，交給 Fighter 判斷
   */
  _bufferAttack(fighter, pressed, st) {
    // 連打預約的絕招（保險：正常會在 _step 的最後一幀就接上）
    if (fighter.queuedAttack) {
      if (!fighter.canAct) return pressed
      const key = fighter.queuedAttack
      fighter.queuedAttack = null
      return pressed || key
    }
    if (pressed) {
      const left = fighter.framesUntilFree
      if (left > 1 && left <= this._getBufferFrames(fighter)) st.bufferedAttack = { key: pressed, life: left + 2 } // 多留一點，出招第 1 幀定格時不會提早失效
    }
    // 動作的最後一幀就送出：Fighter 這一幀結束動作後馬上出招，幀數表不會多一格空白
    // 先不清掉，真的開始出招才清（見 _step）
    if (!pressed && st.bufferedAttack && fighter.framesUntilFree <= 1) return st.bufferedAttack.key
    if (st.bufferedAttack && --st.bufferedAttack.life <= 0) st.bufferedAttack = null
    return pressed
  }

  /** 預約時段長度：前前 / 後後用 dashBufferFrames，其他動作用 bufferFrames */
  _getBufferFrames(fighter) {
    return fighter.state === 'dash' && !fighter.isRush ? this.dashBufferFrames : this.bufferFrames
  }

  /**
   * 衝刺（連按兩下）的預約：前前 / 後後的最後 dashBufferFrames 幀內連按，記住方向，衝刺最後一幀送出（接著再衝一次）
   * @returns {number} 這一幀要送給 Fighter 的衝刺方向
   */
  _bufferDash(fighter, dash, st) {
    const left = fighter.framesUntilFree
    if (dash && fighter.state === 'dash' && !fighter.isRush && left > 1 && left <= this.dashBufferFrames) {
      st.bufferedDash = { dir: dash, life: left + 2 }
      return 0
    }
    if (!dash && st.bufferedDash && left <= 1) {
      const dir = st.bufferedDash.dir
      st.bufferedDash = null
      return dir
    }
    if (st.bufferedDash && --st.bufferedDash.life <= 0) st.bufferedDash = null
    return dash
  }

  _newInputState() {
    return { pendingAttack: null, rushLife: 0, bufferedAttack: null, bufferedDash: null }
  }

  /**
   * 一個玩家這一幀的輸入（格式見 Fighter.update）：AI 操作時由 AI 決定，否則讀鍵盤；「P2 木樁防禦」打開時 P2 一直防禦
   * 出招鍵、衝刺取消鍵之後都經過同一套預約 / 記憶流程
   */
  _getInput(slot) {
    const fighter = this[slot]
    const st = this.input[slot]
    const dash = this.pendingDash[slot]
    this.pendingDash[slot] = 0
    let raw

    if (this.params[`${slot}AI`]) {
      raw = this.ai[slot].think(fighter, this._getOpponent(fighter), this.stageHalfWidth)
      if (raw.attack) st.pendingAttack = raw.attack
      if (raw.rush) st.rushLife = this.rushInputFrames
    } else {
      const keys = slot === 'p1' ? this.p1Keys : this.p2Keys
      let move = (this.keys.has(keys.right) ? 1 : 0) - (this.keys.has(keys.left) ? 1 : 0)
      const jumpKeys = [keys.jump].flat()
      // 下 + 後：站在原地防禦（不後退）；只按後是一邊後退一邊防禦
      const isStandGuard = this.keys.has(keys.down) && move !== 0 && move === -fighter.facingSign
      if (isStandGuard) move = 0
      raw = { move, dash, jump: jumpKeys.some(code => this.keys.has(code)), guard: isStandGuard || (slot === 'p2' && this.params.p2Guard), standGuard: isStandGuard }
    }

    const attack = this._bufferAttack(fighter, st.pendingAttack, st)
    const rush = st.rushLife > 0
    if (st.rushLife > 0) st.rushLife--
    st.pendingAttack = null
    // 這一幀要出招就不送預約的衝刺（出招優先）
    const bufferedDash = this._bufferDash(fighter, raw.dash || 0, st)
    return { move: raw.move, attack, dash: attack ? raw.dash : bufferedDash, rush, jump: raw.jump, guard: raw.guard, standGuard: !!raw.standGuard }
  }

  _getOpponent(fighter) {
    return fighter === this.p1 ? this.p2 : this.p1
  }

  /** 提早結束這一幀（衝刺取消停頓、絕招開始）時，已經讀走的出招鍵放回去，下一次讀輸入時還在 */
  _keepInputs(inputs) {
    Object.entries(inputs).forEach(([slot, input]) => {
      const st = this.input[slot]
      if (input.attack && !st.pendingAttack) st.pendingAttack = input.attack
    })
  }

  /**
   * 這一幀要開始的絕招：能動時、衝刺取消中、或動作的最後一幀（預約的絕招從上一個動作的結尾直接接上）
   * 普通拳的攻擊判定期間按絕招：直接中斷出絕招（不論有沒有打中）
   * @returns {{ key: string, isFromNeutral: boolean } | null}
   */
  _getSuperStart(f, input) {
    const chainSuper = f.chainKey && f.moves[f.chainKey]?.isSuper && f.connected && f.state === 'attack' && f.framesUntilFree <= 1 ? f.chainKey : null
    const rushSuper = f.isRushReady && f.moves[f.rushAttack]?.isSuper ? f.rushAttack : null
    const key = chainSuper || (f.moves[input.attack]?.isSuper ? input.attack : null) || rushSuper
    const isSuperCancel = f.state === 'attack' && !f.getCurrentMove()?.isSuper && f.getFrameType() === 'active'
    if (!key || !(chainSuper || isSuperCancel || f.canAct || f.isRushReady || (f.framesUntilFree <= 1 && !f.isRush))) return null
    // 從自由狀態或動作結尾出的絕招先轉向對手；連打接上、普通拳中斷、衝刺取消不轉身
    const isFromNeutral = !chainSuper && !isSuperCancel && !f.isRushReady && (f.canAct || f.framesUntilFree <= 1)
    return { key, isFromNeutral }
  }

  /**
   * 吸附：lock 招式命中後，對手固定在攻擊方面前，直到被打飛或招式結束
   * 之後有防禦時，防禦住的不吸附（在 _checkHits 判斷）
   */
  _updateLock() {
    const lock = this.lock
    if (!lock) return
    if (lock.attacker.state !== 'attack' || lock.target.state !== 'hit') {
      lock.target.release() // 被抓住的對手：招式結束沒被打飛就放開
      // lock.juggle：飛走動畫恢復正常播放；沒打飛就結束時從空中直接落下
      if (lock.lift) lock.target.setJuggle(null)
      if (lock.lift && lock.target.y > 0 && !lock.target.isAirborne) {
        lock.target.isAirborne = true
        lock.target.vy = 0
      }
      this.lock = null
      return
    }
    lock.target.x = lock.attacker.x + lock.attacker.facingSign * lock.offset
    if (lock.lift) lock.target.y = this._getJuggleHeight(lock)
  }

  /**
   * lock.juggle 的高度：跟著對手飛走動畫的幀數走
   * 每一下（第 1 下從動畫第 0 幀、之後從 animRestart 幀）從當下高度出發：到 maxFrame 升到 maxHeight → 到 minFrame 落到 minHeight → 停住
   * 起點已經過了 maxFrame 時只往下落
   */
  _getJuggleHeight(lock) {
    const t = lock.target
    const { maxFrame, maxHeight, minFrame, minHeight } = lock.lift
    // 新的一下：記住這一下的起點（動畫幀、高度）
    if (lock.juggleHits !== t.juggleHits) {
      lock.juggleHits = t.juggleHits
      lock.seg = { from: t.juggleStartFrame, fromY: t.y }
    }
    const { from, fromY } = lock.seg
    const a = t.juggleAnimFrame
    const easeOut = r => 1 - (1 - r) ** 2 // 上升：越接近頂點越慢
    const easeIn = r => r ** 2 // 下降：越落越快
    const clamp01 = r => Math.min(1, Math.max(0, r))

    const isRising = from < maxFrame
    if (isRising && a <= maxFrame) return fromY + (maxHeight - fromY) * easeOut(clamp01((a - from) / (maxFrame - from)))
    const peakY = isRising ? maxHeight : fromY
    const fallFrom = Math.max(maxFrame, from)
    if (a >= minFrame || fallFrom >= minFrame) return minHeight
    return peakY + (minHeight - peakY) * easeIn(clamp01((a - fallFrom) / (minFrame - fallFrom)))
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
      if (attacker.isAirborne || target.isJumping || target.isLaunched || target.isInvincible) return
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

  /** 衝刺取消後出的招式：受擊 / 防禦硬直加 rush.stunBonus 幀（回傳加過的招式數據副本，不改招式表） */
  _getStunMove(attacker, target) {
    const move = attacker.getCurrentMove()
    const bonus = attacker.isRushAttack ? attacker.rush.stunBonus || 0 : 0
    if (!move || !bonus) return move
    return { ...move, hitStun: move.hitStun + bonus, blockStun: (move.blockStun ?? target.blockStun) + bonus }
  }

  /**
   * 打飛撞牆反彈：飛走中碰到邊界牆、或離對手達到最遠距離（maxDistance）就反彈
   * 反彈後剩下的飛行距離 × 招式的 launch.wallBounce 往回飛（6 公尺一開始就貼牆 → 往回 4.5 公尺）
   */
  _checkWallBounce() {
    ;[[this.p1, this.p2], [this.p2, this.p1]].forEach(([f, other]) => {
      if (!f.flyBounce || f.isFlyBounced || !f.isLaunched) return
      const eps = 1e-4
      const atWall = f.x * f.flyDir >= this.stageHalfWidth - f.pushHalfWidth - eps
      const atMaxDistance = (f.x - other.x) * f.flyDir >= this.maxDistance - eps
      if (atWall || atMaxDistance) f.bounceFly()
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
   * 吸附中（lock 招式命中後）：之後每一段進入判定幀就必定命中，不看判定框（一旦被打中就打到招式結束）
   * 抓取中（grab）：仍照判定球判斷，打中才擊飛；沒打中就抓到招式結束才放開
   */
  _checkHits() {
    ;[[this.p1, this.p2], [this.p2, this.p1]].forEach(([attacker, target]) => {
      const isLocked = this.lock?.attacker === attacker && this.lock.target === target && !this.lock.isGrab
      if (!(isLocked ? attacker.isHitActive() : attacker.checkHit(target))) return

      const move = this._getStunMove(attacker, target)
      // 打擊特效：命中點、往被打的方向噴
      const hitPoint = attacker.getHitPoint(target)
      const hitDir = Math.sign(target.x - attacker.x) || attacker.facingSign

      // 防禦：不扣血、不吸附、不打飛、不算連段，只有防禦硬直
      if (target.canBlock) {
        this.hitEffect.spawn(hitPoint, { type: 'block', dir: hitDir })
        attacker.registerHit()
        target.takeBlock(attacker.x, move)
        this.sound.play('block')
        this._applyCornerPush(attacker, target)
        this.hitstopTimer = move.hitstop ?? this.hitstopFrames
        return
      }

      const isCombo = target.state === 'hit' || target.isLaunched // 對手還在硬直中（含被打飛的飛走中）被打到 = 連段
      const isLaunch = attacker.registerHit()
      this.hitEffect.spawn(hitPoint, { type: move.isSuper || move.heavyHitEffect ? 'heavy' : 'hit', dir: hitDir })
      target.takeHit(attacker.x, move, isLaunch)
      attacker.onHitConfirm() // 衝刺取消、收招縮短、下一拳鏡像：防禦住的不算
      if (!isLaunch) this._applyCornerPush(attacker, target)
      this.sound.play(move.isSuper ? 'superHit' : 'hit') // 受擊確認：受擊硬直第一幀
      this._startCameraShake(this._getCameraShake(attacker))
      // 絕招命中不頓幀，改成晃鏡頭（見 _getCameraShake）
      this.hitstopTimer = move.isSuper ? 0 : move.hitstop ?? this.hitstopFrames
      if (move.hitShake) this._startShake(target, this.hitstopTimer, move.hitShake === true ? this.hitShake.cycles : move.hitShake)

      // 命中鏡頭：第 1 段打中時拉近，打飛那一下拉回
      if (attacker.getCurrentMove()?.hitCamera) {
        if (isLaunch) this._releaseHitCamera(attacker)
        else if (attacker.hitWindow === 0 && !this.hitCam) this._startHitCamera(attacker)
      }

      if (move.lock && !isLaunch && !this.lock) {
        const gap = attacker.pushHalfWidth + target.pushHalfWidth
        this.lock = { attacker, target, offset: Math.max(gap, move.lock.distance ?? gap), lift: null, juggleHits: -1 } // 吸附到攻擊方正前方
      }

      // lock.juggle：吸附中打到第 fromHit 段（1 起算）時開始浮空挨打
      const juggle = attacker.getCurrentMove()?.lock?.juggle
      const lock = this.lock
      if (juggle && !isLaunch && lock?.attacker === attacker && lock.target === target && !lock.lift && attacker.hitWindow + 1 >= (juggle.fromHit ?? 1)) {
        lock.lift = juggle
        target.setJuggle({ hold: juggle.animHold ?? 14, restart: juggle.animRestart ?? 8 })
      }

      const slot = attacker === this.p1 ? 'p1' : 'p2'
      this.combos[slot] = isCombo ? this.combos[slot] + 1 : 1
      this.hud.setCombo(slot, this.combos[slot])
    })

    // 對手恢復自由 = 連段結束
    ;['p1', 'p2'].forEach(slot => {
      if (this.combos[slot] && this._getOpponent(this[slot]).canAct) {
        this.combos[slot] = 0
        this.hud.setCombo(slot, 0)
      }
    })
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

  /**
   * 命中鏡頭開始：從目前鏡頭位置拉近到攻擊方後方斜角
   * 記住一般鏡頭（注視點與相對位置），拉回時回到這裡；絕招演出還沒結束時用演出開始前的一般鏡頭
   */
  _startHitCamera(attacker) {
    const c = this.cinematic
    const base = c
      ? { target: c.fromTarget.clone(), offset: c.fromOffset.clone() }
      : { target: this.controls.target.clone(), offset: this.camera.position.clone().sub(this.controls.target) }
    this.hitCam = {
      attacker,
      move: attacker.currentMove,
      cfg: this._getHitCameraConfig(attacker.getCurrentMove()),
      phase: 'in',
      time: 0,
      fromPos: this.camera.position.clone(),
      fromTarget: this.controls.target.clone(),
      base,
    }
    this.controls.enabled = false
  }

  /** 命中鏡頭開始拉回一般鏡頭（打飛、或招式被中斷 / 結束）；attacker 有給時只拉回這個人的命中鏡頭 */
  _releaseHitCamera(attacker) {
    const h = this.hitCam
    if (!h || h.phase === 'out' || (attacker && h.attacker !== attacker)) return
    h.phase = 'out'
    h.time = 0
    h.fromPos = this.camera.position.clone()
    h.fromTarget = this.controls.target.clone()
  }

  /** 命中鏡頭直接回到一般鏡頭（Esc 重置、換人物） */
  _endHitCamera() {
    const h = this.hitCam
    if (!h) return
    const target = h.base.target.clone()
    if (this.p1 && this.p2) target.x = (this.p1.x + this.p2.x) / 2
    this.camera.position.copy(target).add(h.base.offset)
    this.controls.target.copy(target)
    this.controls.enabled = !this.cinematic
    this.cameraPull = 0
    this.hitCam = null
  }

  /** 招式的命中鏡頭設定：預設值（main.js hitCamera）+ 招式的 hitCamera 物件（true = 全用預設） */
  _getHitCameraConfig(move) {
    const own = typeof move?.hitCamera === 'object' ? move.hitCamera : {}
    return { ...this.hitCamera, ...own, lookAhead: { ...this.hitCamera.lookAhead, ...own.lookAhead } }
  }

  /** 命中鏡頭的位置：攻擊方背後、往鏡頭那側偏 angle 度，距離 superCamera.distance，看著攻擊方胸口（再偏 lookAhead：x 往對手、y 往上） */
  _getHitCameraPose(fighter, cfg) {
    const { angle, height, lookAhead } = cfg
    const a = THREE.MathUtils.degToRad(angle)
    const target = new THREE.Vector3(fighter.x + fighter.facingSign * lookAhead.x, this.characterHeight * 0.7 + lookAhead.y, 0)
    const back = new THREE.Vector3(-fighter.facingSign * Math.cos(a), 0, Math.sin(a))
    const pos = target.clone().addScaledVector(back, this.superCamera.distance)
    pos.y += height
    return { pos, target }
  }

  /** 命中鏡頭每個畫面更新：拉近後跟著攻擊方；拉回時終點是跟著兩人中點的一般鏡頭 */
  _updateHitCamera(realDelta) {
    const h = this.hitCam
    const { blendIn, blendOut } = h.cfg
    h.time += this.params.paused ? 0 : realDelta * this.params.timeScale * FPS
    const f = h.attacker
    // 招式被中斷（受擊、換招）或沒打飛就結束：一樣拉回
    if (h.phase === 'in' && (f.state !== 'attack' || f.currentMove !== h.move)) this._releaseHitCamera()

    const easeOut = t => 1 - (1 - t) ** 3
    const easeInOut = t => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2)
    let toPos
    let toTarget
    let k
    if (h.phase === 'in') {
      ;({ pos: toPos, target: toTarget } = this._getHitCameraPose(f, h.cfg))
      k = easeOut(Math.min(1, h.time / blendIn))
    } else {
      toTarget = h.base.target.clone()
      toTarget.x = (this.p1.x + this.p2.x) / 2
      toPos = toTarget.clone().add(h.base.offset)
      k = easeInOut(Math.min(1, h.time / blendOut))
    }
    this.camera.position.lerpVectors(h.fromPos, toPos, k)
    this.controls.target.lerpVectors(h.fromTarget, toTarget, k)
    this.camera.lookAt(this.controls.target)

    if (h.phase === 'out' && k >= 1) {
      this.controls.enabled = !this.cinematic
      this.cameraPull = 0
      this.hitCam = null
    }
  }

  /** 絕招演出開始：人物停在招式第 0 幀，鏡頭從目前位置拉近到人物胸口 */
  _startSuper(fighter, key) {
    fighter.startMove(key)
    fighter.snapToCurrentAction() // 演出停頓期間顯示絕招的第 1 幀（不從之前的動作淡入）
    // 畫面補間的「上一幀」也記成絕招第 1 幀：之後 _animate 會再記一次，前後兩幀都是絕招第 1 幀
    // 不然 animStart 是 zoomOut / after 的絕招（凍結期間不推進），凍結結束的第一個畫面會內插回出招前的姿勢（看起來像閃回閒置）
    fighter.captureFrame()
    this._playMoveSounds(fighter.moves[key], 1, fighter) // 第 1 幀音效：按下絕招的瞬間
    // cutSounds：記住這招，被中斷時停掉它的音效（見 _checkSoundCut）
    fighter.soundMove = fighter.moves[key].cutSounds ? { key, frame: 0, left: Infinity } : null
    this.scene.updateMatrixWorld()
    fighter.updateBoxes()

    const fromTarget = this.controls.target.clone()
    const fromOffset = this.camera.position.clone().sub(fromTarget) // 一般鏡頭相對注視點的位置
    const zoomTarget = new THREE.Vector3(fighter.x, this.characterHeight * 0.7, 0)
    const zoomPos = zoomTarget.clone().addScaledVector(fromOffset.clone().normalize(), this.superCamera.distance)

    this.cinematic = { fighter, time: 0, frozenSteps: 0, animStart: this._getSuperAnimStart(fighter.moves[key]), fromTarget, fromOffset, zoomPos, zoomTarget }
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

  /**
   * 招式這一段命中要不要晃鏡頭：cameraShake 是數字 = 每段都晃這個幅度；陣列 = 依段數（hits 的順序）個別設定，0 / 沒填 = 不晃
   * 沒填 cameraShake 的絕招：每段都晃 superAmplitude
   */
  _getCameraShake(attacker) {
    const move = attacker.getCurrentMove()
    const shake = move?.cameraShake ?? (move?.isSuper ? this.cameraShake.superAmplitude : 0)
    if (Array.isArray(shake)) return shake[attacker.hitWindow] || 0
    return shake || 0
  }

  /** 開始鏡頭晃動（amp 公尺）；前一次還在晃時取比較大的幅度、從頭開始 */
  _startCameraShake(amp) {
    if (!amp) return
    const remain = this.camShake ? this.camShake.amp * (1 - this.camShake.time / this.camShake.duration) : 0
    this.camShake = { amp: Math.max(amp, remain), time: 0, duration: this.cameraShake.frames / FPS, phase: Math.random() * Math.PI * 2 }
  }

  /**
   * 渲染前把晃動位移加到鏡頭上（渲染後由 _animate 扣回），不影響跟隨鏡頭、滑鼠操作與演出鏡頭的計算
   * 上下、左右用不同頻率，看起來比較像震動而不是規律擺動
   */
  _applyCameraShake(delta) {
    this.camShakeOffset.set(0, 0, 0)
    const c = this.camShake
    if (!c) return
    c.time += delta
    if (c.time >= c.duration) {
      this.camShake = null
      return
    }
    const k = c.amp * (1 - c.time / c.duration)
    const w = Math.PI * 2 * this.cameraShake.frequency * c.time
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0)
    const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1)
    this.camShakeOffset.addScaledVector(right, k * Math.sin(w + c.phase)).addScaledVector(up, k * 0.8 * Math.sin(w * 1.37 + c.phase * 2))
    this.camera.position.add(this.camShakeOffset)
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
    this._endHitCamera()
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
    this.superDim = 0
    this._applyStageLight()
    this._applySuperFog(0)
    this.hitEffect.clear()
    if (this.shake) this.shake.fighter.model.position.z = 0
    this.shake = null
    this.camShake = null
    this.lock = null
    this.hitstopTimer = 0
    this.rushFreeze = null
    this.accumulator = 0
    this.isRushFrozen = false
    this.input = { p1: this._newInputState(), p2: this._newInputState() }
    this.pendingDash = { p1: 0, p2: 0 }
    this.ai.p1.reset()
    this.ai.p2.reset()
    this.combos = { p1: 0, p2: 0 }
    this.hud.setCombo('p1', 0)
    this.hud.setCombo('p2', 0)
    this.sound.stopAll()
    this.p1.resetToIdle()
    this.p2.resetToIdle()
  }

  /** 播放招式在第 frame 幀的音效；音效歸到出招的人那一組，招式被中斷時可以只停他的 */
  _playMoveSounds(move, frame, fighter) {
    move.sounds?.forEach(s => {
      if ((s.frame ?? 1) === frame) this.sound.play(s.name, s.delay, fighter)
    })
  }

  /**
   * cutSounds 招式的音效中斷：招式還沒播完（上一幀還剩不只 1 幀）就變成別的狀態 / 別的招式 / 從頭開始 → 停掉這個人的招式音效
   * 正常播完（最後一幀接回站立）不停，讓音效自然收尾
   */
  _checkSoundCut(f) {
    const s = f.soundMove
    if (!s) return
    const isStill = f.state === 'attack' && f.currentMove === s.key && f.stateFrame >= s.frame
    if (isStill) {
      s.frame = f.stateFrame
      s.left = f.framesUntilFree
      return
    }
    if (s.left > 1) this.sound.stopGroup(f)
    f.soundMove = null
  }

  /**
   * 絕招演出凍結期間（拉近 + 停留）推進放招的人 1 幀：只跑招式本身（動畫、前進、音效），對手不動、不做命中 / 抓取判定
   * 幀數表記成 frozen（凍結中的前搖：招式幀數有在算，但只是凍結狀態下播出的動畫）
   */
  _stepSuperFrozen(fighter) {
    const prevX = fighter.x
    fighter.isFrozenStep = true // advance.afterFreeze 的招式凍結期間不移動
    fighter.update({ move: 0, attack: null, jump: false, guard: false, dash: 0 })
    fighter.isFrozenStep = false
    this._stopAtOpponent(fighter, prevX)
    this.scene.updateMatrixWorld()
    fighter.updateBoxes()
    this.frameMeter.record([this.p1, this.p2].map(f => (f === fighter ? 'frozen' : f.getFrameType())))
    this._playStepSounds([fighter])
    fighter.captureFrame()
  }

  /**
   * 凍結期間對手不能被推：放招的人往前移動（advance 等）碰到對手就停在對手面前，不推對手、也不穿過去
   * 越過頭頂（高度差大）或穿越中（dashThrough）照常通過；也不超出場地邊界
   */
  _stopAtOpponent(fighter, prevX) {
    const opp = this._getOpponent(fighter)
    const isOverhead = Math.abs(fighter.y - opp.y) > this.characterHeight * 0.8
    if (!isOverhead && !fighter.isPassing) {
      const minGap = fighter.pushHalfWidth + opp.pushHalfWidth
      fighter.x = prevX <= opp.x ? Math.min(fighter.x, opp.x - minGap) : Math.max(fighter.x, opp.x + minGap)
    }
    const limit = this.stageHalfWidth - fighter.pushHalfWidth
    fighter.x = Math.max(-limit, Math.min(limit, fighter.x))
  }

  /** 招式音效：第 2 幀以後在這裡播（第 1 幀在出招時播，避免定格那幀重複） */
  _playStepSounds(fighters) {
    fighters.forEach(f => {
      this._checkSoundCut(f)
      const move = f.getCurrentMove()
      const frame = f.moveFrame
      if (move?.sounds && frame > 1 && f.soundFrame !== frame) {
        f.soundFrame = frame
        this._playMoveSounds(move, frame, f)
      }
      if (!move) f.soundFrame = 0
    })
  }

  /** 絕招從演出第幾幀開始播：animStart（拉近時 / 停留時 / 拉遠時 / 拉遠後）換算成演出的幀數 */
  _getSuperAnimStart(move) {
    const { zoomIn, hold, zoomOut } = this.superCamera
    const starts = { zoomIn: 0, hold: zoomIn, zoomOut: zoomIn + hold, after: zoomIn + hold + zoomOut }
    return starts[move.animStart] ?? 0
  }

  /** 放招的人還在等 animStart（遊戲已恢復、但招式還沒開始播）：這幀不推進 */
  _isWaitingSuperStart(fighter) {
    const c = this.cinematic
    return !!c && c.fighter === fighter && c.time < c.animStart
  }

  /** 演出中是否暫停遊戲：只有拉近 + 停留期間暫停，拉回時遊戲已經繼續 */
  _isFrozen() {
    const { zoomIn, hold } = this.superCamera
    return !!this.cinematic && this.cinematic.time < zoomIn + hold
  }

  /**
   * 絕招演出：拉近 → 停留 → 拉回，同時打光；拉回的終點是跟著人物移動的一般鏡頭位置
   * 時間以遊戲幀計算（c.time 單位是幀），乘上遊戲速度、暫停時不前進
   */
  _updateCinematic(realDelta) {
    const c = this.cinematic
    const { zoomIn, hold, zoomOut, spotFadeIn } = this.superCamera
    const easeOut = t => 1 - (1 - t) ** 3
    const easeInOut = t => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2)
    c.time += this.params.paused ? 0 : realDelta * this.params.timeScale * FPS
    const t = c.time

    // 拉近 + 停留期間：從 animStart 起，放招的人每過 1 幀推進 1 幀（animStart 在凍結結束之後的招式不推進）
    const frozenSteps = Math.min(zoomIn + hold - c.animStart, Math.max(0, Math.floor(t) - c.animStart))
    while (c.frozenSteps < frozenSteps) {
      c.frozenSteps++
      this._stepSuperFrozen(c.fighter)
    }

    // 一般鏡頭：注視點 x 跟著兩人中點
    const baseTarget = c.fromTarget.clone()
    if (t > zoomIn + hold) baseTarget.x = (this.p1.x + this.p2.x) / 2
    const basePos = baseTarget.clone().add(c.fromOffset)

    // k：0 = 一般鏡頭，1 = 拉近
    let k = 1
    if (t < zoomIn) k = easeOut(t / zoomIn)
    else if (t > zoomIn + hold) k = 1 - easeInOut(Math.min(1, (t - zoomIn - hold) / zoomOut))

    // 命中鏡頭接手時（演出拉回中就打中）：鏡頭交給 _updateHitCamera，演出只管燈光
    if (!this.hitCam) {
      this.camera.position.lerpVectors(basePos, c.zoomPos, k)
      this.controls.target.lerpVectors(baseTarget, c.zoomTarget, k)
      this.camera.lookAt(this.controls.target)
    }

    // 聚光燈：spotFadeIn 幀亮起，鏡頭開始拉回時同步淡出；燈在鏡頭位置，照向人物
    const backT = t - zoomIn - hold
    const amount = backT > 0 ? Math.max(0, 1 - backT / zoomOut) : Math.min(1, t / spotFadeIn)
    const { light: spot, aim, peak } = this.superSpot
    spot.intensity = peak * amount
    spot.position.copy(this.camera.position)
    spot.target.position.set(c.fighter.x + aim.x, aim.y, aim.z)
    // 場地跟聚光燈同步變暗 / 恢復
    this.superDim = amount
    this._applyStageLight()
    // 場地霧：發動瞬間就最濃，鏡頭拉回時跟著淡掉
    this._applySuperFog(backT > 0 ? Math.max(0, 1 - backT / zoomOut) : 1)

    if (t >= zoomIn + hold + zoomOut) {
      spot.intensity = 0
      this.superDim = 0
      this._applyStageLight()
      this._applySuperFog(0)
      if (!this.hitCam) {
        this.camera.position.copy(basePos)
        this.controls.target.copy(baseTarget)
        this.controls.enabled = true
      }
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

    const slots = ['p1', 'p2']
    const inputs = { p1: this._getInput('p1'), p2: this._getInput('p2') }

    // 衝刺取消：按下的瞬間（或預約後碰到對手時）發光並頓幀，頓幀結束的下一幀才開始衝刺
    if (!this.isRushFrozen) {
      const slot = slots.find(k => (inputs[k].rush || this[k].rushQueued) && this[k].canRush)
      if (slot) {
        const f = this[slot]
        f.startGlow()
        this.hitstopTimer = f.rush.freezeFrames
        this.rushFreeze = { fighter: f, frame: 0 }
        this._keepInputs(inputs) // 同一幀按的招式留到停頓結束再交給 Fighter 記住
        this.input[slot].rushLife = 1 // 頓幀期間不會讀輸入，結束後的下一幀交給 Fighter 開始衝刺
        this.isRushFrozen = true
        return
      }
    }
    this.isRushFrozen = false

    // 絕招：先進入演出，鏡頭拉近 + 停留期間只有放招的人推進（見 _stepSuperFrozen），拉回時遊戲繼續
    for (const slot of slots) {
      const f = this[slot]
      const start = this._getSuperStart(f, inputs[slot])
      if (!start) continue
      const otherSlot = slot === 'p1' ? 'p2' : 'p1'
      f.rushAttack = null
      this.input[slot].bufferedAttack = null
      f.startedMove = false
      if (start.isFromNeutral) f.faceTo(this[otherSlot], true)
      this._keepInputs({ [otherSlot]: inputs[otherSlot] })
      this._startSuper(f, start.key)
      return
    }

    this.prevX = new Map([[this.p1, this.p1.x], [this.p2, this.p2.x]]) // 最遠距離用：判斷這幀是誰往外移動
    // animStart 是 'after' 的絕招：鏡頭拉遠期間停在第 1 幀
    slots.forEach(slot => {
      if (!this._isWaitingSuperStart(this[slot])) this[slot].update(inputs[slot])
    })
    slots.forEach(slot => {
      const f = this[slot]
      const st = this.input[slot]
      if (f.usedRush) {
        st.rushLife = 0
        f.usedRush = false
      }
      // 收招預約：開始出招就用掉；已經能動卻沒出招（例如在空中）就丟掉
      if (f.startedMove || f.canAct) st.bufferedAttack = null
      f.startedMove = false
    })
    this._updateDashThrough()
    this._checkGrabs()
    this._updateLock()
    this._resolvePush()
    this._checkWallBounce()

    // 轉身以雙方身體受擊框為準：先算判定框，有人轉身再重算一次
    this.scene.updateMatrixWorld()
    this.p1.updateBoxes()
    this.p2.updateBoxes()
    const turned1 = this.p1.faceTo(this.p2)
    const turned2 = this.p2.faceTo(this.p1)
    if (turned1 || turned2) {
      this.scene.updateMatrixWorld()
      this.p1.updateBoxes()
      this.p2.updateBoxes()
    }
    this._checkHits()
    this.frameMeter.record([this.p1.getFrameType(), this.p2.getFrameType()])

    this._playStepSounds([this.p1, this.p2])

    // 倒地音效：被打飛後第 knockdownSoundFrame 幀（launch.slow 放慢時跟著往後）
    ;[this.p1, this.p2].forEach(f => {
      if (f.state === 'down' && f.stateFrame === Math.round(this.knockdownSoundFrame * f.flySlow)) this.sound.play('knockdown')
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
      this.hitEffect.update(this.params.paused ? 0 : realDelta * this.params.timeScale)

      if (this.hitCam) this._updateHitCamera(realDelta)
      else if (!this.cinematic) this._followCamera(realDelta)
      this.hud.updateCoords(fighters)
      // 人物位置更新完才對齊腳底橢圓
      this.footMarker.update()
    }

    // 演出中由 _updateCinematic 控制鏡頭、命中鏡頭中由 _updateHitCamera 控制
    if (!this.cinematic && !this.hitCam) this.controls.update()
    this.hud.update(realDelta)

    this._applyCameraShake(this.params.paused ? 0 : realDelta * this.params.timeScale)
    this.renderer.render(this.scene, this.camera)
    this.camera.position.sub(this.camShakeOffset) // 晃動只影響這個畫面
    // 還原成邏輯幀的姿勢，下一次 _step 從正確的狀態繼續
    fighters.forEach(f => f.restoreFrame())
  }
}

// 掛到 window 方便在 DevTools console 裡直接查看，例如 viewer.p1、viewer.p2
window.viewer = new FighterViewer()
