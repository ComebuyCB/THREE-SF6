import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import GUI from 'three/addons/libs/lil-gui.module.min.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { Fighter, FPS } from './fighter.js'
import { FrameMeter } from './frameMeter.js'
import { MixamoLoader } from './mixamoLoader.js'
import { Stage } from './stage.js'
import { Hud } from './hud.js'
import { Popup } from './popup.js'
import { Sound } from './sound.js'
import { HitEffect } from './hitEffect.js'
import { FootMarker } from './footMarker.js'
import { FreeMode } from './freeMode.js'
import { SkyDome } from './skyDome.js'
import { Combat, LineSpace } from './combat.js'
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
// 場景模型的霧（取代 three.js 的 fog_fragment）：霧色 = 看出去方向的天空貼圖顏色，和一般霧色依 uSkyMix 混合
// textureLod 0：equirect 的左右接縫在 mipmap 計算會出現細線，固定用最清楚的那層
const SKY_FOG_PARS = `
uniform sampler2D uSkyMap;
uniform float uSkyMix;
uniform mat3 uSkyMat;
uniform float uSkyIntensity;
varying vec3 vSkyFogPos;
`
const SKY_FOG_FRAGMENT = `
#ifdef USE_FOG
	float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
	vec3 skyDir = uSkyMat * normalize( vSkyFogPos - cameraPosition );
	vec3 skyFog = linearToOutputTexel( vec4( textureLod( uSkyMap, equirectUv( skyDir ), 0.0 ).rgb * uSkyIntensity, 1.0 ) ).rgb;
	gl_FragColor.rgb = mix( gl_FragColor.rgb, mix( skyFog, fogColor, uSkyMix ), fogFactor );
#endif
`

class FighterViewer {
  constructor(options) {
    const def = {
      el: '#stage',
      characters: [
        { name: 'Meshy', url: `${MODEL_DIR}/characters/meshy.glb`, brightness: 1.35, smile: { corners: [[-0.034, 1.556], [0.034, 1.556]], radius: 0.014, lift: 0.007, outward: 0.003, back: 0.002, minZ: 0.05 } },
        { name: 'Erika', url: `${MODEL_DIR}/characters/erika.glb` },
        { name: 'Remy', url: `${MODEL_DIR}/characters/remy.glb` },
        { name: 'Bladman', url: `${MODEL_DIR}/characters/bladman.glb` },
        { name: 'Meshy_old', url: `${MODEL_DIR}/characters/meshy_old.glb`, brightness: 1.35, smile: { corners: [[-0.034, 1.556], [0.034, 1.556]], radius: 0.014, lift: 0.007, outward: 0.003, back: 0.002, minZ: 0.05 } },
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
        run: `${MODEL_DIR}/anims/normal/Running.fbx`, // 自由模式（M）跑步
        fastRun: `${MODEL_DIR}/anims/normal/FastRun.fbx`, // 自由模式的衝刺
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
      //   halfWidth = 切換到這個場景時的打鬥場地半寬（公尺）；沒填 = 預設的 stageHalfWidth
      //   model 是 null = 沒有場景：只有影子地板與天空（自由模式限制在 ±halfWidth 的方框內）
      scenes: {
        無: { model: null, halfWidth: 5 },
        庭院: { model: `${MODEL_DIR}/background/courtyard.glb`, ground: [0.0252, -0.0414, 0.6321], transform: { x: -0.3, y: -0.03, z: 4, rotation: 0, scale: 0.9 } },
        // 模型中央是房子與門口台階：往後移，人物站在房子前的空地，房子當背景
        閥門房: { model: `${MODEL_DIR}/background/bayard_station_valve_house.glb`, ground: [0.0013, -0.0167, 9.416], transform: { x: 1.5, y: -0.05, z: -8.1, rotation: 0, scale: 0.9 } },
        // 人物站在拱橋正下方、橫跨道路：左右 ±5 公尺都是平地，最近的牆在 7.5 公尺外，頭頂整段都有橋
        橋下: { model: `${MODEL_DIR}/background/rick_roll_bridge.glb`, ground: [0.0049, 0.0115, -4.9441], transform: { x: 1.5, y: -0.03, z: -8.5, rotation: 0, scale: 1 }, halfWidth: 5 },
      },
      // 天空（GUI 可切換）：procedural = 程式畫的動態天空（skyDome.js）；其餘是 2:1 全景圖，當作無限遠的背景，3D 場景沒擋住的地方看得到
      skies: {
        動態天空: 'procedural',
        基隆: 'src/common/img/Keelung.jpg',
        晴天: 'src/common/img/DaySky.jpg',
        機庫外: 'src/common/img/hanger_exterior.webp',
      },
      dashTapWindow: 250, // 連按兩下方向鍵的間隔（毫秒）內算衝刺
      timeScaleStep: 0.1, // 遊戲速度快捷鍵（- / =）每按一下調多少
      characterHeight: 1.75, // 人物身高（公尺）：模型原始尺寸不同，載入後縮放成一致；characters 可個別填 height
      stageHalfWidth: 7.5, // 場地邊界 x = ±7.5（最大值；開啟「場景牆壁當邊界」時，場景的牆更近就縮到牆的位置）
      // 場景牆壁當邊界：從場地中心沿 ±x 方向、在這幾個高度（公尺）各發一條射線，最近碰到的場景物體就是邊界
      sceneWallHeights: [0.3, 1, 1.6],
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
      // 環繞鏡頭（H）：一直看著兩人中點，前 pullTime 秒拉遠（距離 × pullScale），繞一整圈共 duration 秒，最後 returnTime 秒拉回原本的鏡頭（秒，不受遊戲速度影響）
      orbitCamera: { duration: 3, pullTime: 0.5, returnTime: 0.5, pullScale: 1.8 },
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
        // 拉近：沿著目前鏡頭的方向，拉到目前距離 × zoomRate，但不比 distance（公尺）更近；命中鏡頭也用同樣的距離
        distance: 3,
        zoomRate: 0.5,
        spotFadeIn: 10, // 聚光燈亮起幀數；鏡頭開始拉回時同步淡出
        dimLevel: 0.5, // 演出時場地燈光、背景變暗到原本的幾成（跟聚光燈同步淡入淡出）；1 = 不變暗
        // 演出時場地的霧（人物不受影響）：離鏡頭 fogNear ~ fogFar 公尺漸濃，鏡頭拉回時淡掉
        fogColor: 0x15161c,
        fogNear: 2,
        fogFar: 40,
      },
      // 命中鏡頭（招式的 hitCamera）的預設值；招式填物件可個別覆蓋。距離同絕招拉近（superCamera 的 distance、zoomRate）
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
      p2AttackKey: 'NumpadAdd', // 按著數字鍵盤 + 再按出招鍵 = P2 出招
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
    this.helpDockEl = document.querySelector('#helpDock')

    // 4. setup runtime state
    this.clock = new THREE.Clock()
    this.mixamo = new MixamoLoader()
    this.sourceCache = {} // url → Promise<{ scene, clips }>，同一個人物只綁定一次
    this.p1 = null
    this.p2 = null
    this.keys = new Set()
    // GUI 勾選「AI 操作」時由 AI 按鍵；SG 不滿 1 格時不放絕招
    this.ai = {
      p1: new FighterAI({ canSuper: () => this.combat.gauges.p1.canSuper }),
      p2: new FighterAI({ canSuper: () => this.combat.gauges.p2.canSuper }),
    }
    this.pendingDash = { p1: 0, p2: 0 } // 格鬥模式連按兩下方向鍵：衝刺方向（世界座標），下一幀遊戲邏輯取走
    this.lastTap = { p1: { code: '', time: 0 }, p2: { code: '', time: 0 } } // 上一次按下的方向鍵，判斷連按用
    this.skyCache = {} // 天空名稱 → texture
    this.envModel = null // 目前的 3D 場景模型（Group）
    this.stageMaxHalfWidth = this.stageHalfWidth // GUI 設定的場地半寬；實際邊界 stageHalfWidth 可能被場景的牆縮小
    this.defaultHalfWidth = this.stageHalfWidth // 場景沒填 halfWidth 時用的半寬
    this.wallRaycaster = new THREE.Raycaster()
    this.envCache = {} // 場景名稱 → Promise<Group>，同一個場景模型只載入一次
    this.cameraPull = 0 // 跳躍時鏡頭額外往後拉的距離
    // 鎖定鏡頭（絕招演出、命中鏡頭、環繞鏡頭）時滑鼠左鍵拖曳：yaw / pitch 疊在演出鏡頭上（弧度）
    //   只影響畫面（渲染後還原），演出結束、放開滑鼠後才把角度併進一般鏡頭
    // 鏡頭避開物體（B）：dist = 目前畫面用的鏡頭距離（平滑變化）；只影響畫面（渲染後還原），OrbitControls 的距離不變
    this.camCollide = { dist: Infinity, isApplied: false, pos: new THREE.Vector3(), raycaster: new THREE.Raycaster() }
    this.camCollide.raycaster.firstHitOnly = true
    this.camDrag = { isDragging: false, x: 0, y: 0, yaw: 0, pitch: 0, isApplied: false, pos: new THREE.Vector3(), quat: new THREE.Quaternion() }
    this.orbitCam = null // 環繞鏡頭中：{ time, target, offset }（target、offset = 開始時的一般鏡頭）
    this.hitCam = null // 命中鏡頭中：{ attacker, move, phase: 'in' / 'out', time, fromPos, fromTarget, base: { target, offset } }
    this.shake = null // 受擊搖晃中：{ fighter, time, duration }（秒）
    this.camShake = null // 鏡頭晃動中：{ amp, time, duration, phase }（秒）
    this.camShakeOffset = new THREE.Vector3() // 這個畫面加在鏡頭上的晃動位移（渲染後扣回去）
    this.accumulator = 0 // 尚未消化的時間，累積滿 1/60 秒就推進 1 幀
    this.superDim = 0 // 絕招演出的變暗程度（0 = 正常、1 = 暗到 dimLevel）
    this.fog = null // 場地霧（THREE.Fog）：平常是地平線霧，絕招演出時漸變成演出的霧（人物不受影響）
    this.superFogAmount = 0 // 絕招演出的霧濃度 0 ~ 1
    this.skyDome = null // 動態天空
    this.horizonColor = new THREE.Color(0xc8d5e2) // 地平線霧的顏色（跟著天空）
    // 全景圖天空的霧：場景模型的霧色改成「它正後方那一點的天空貼圖顏色」，遠處的模型直接融進天空（見 _patchSkyFog）
    //   uSkyMix：0 = 用天空貼圖、1 = 用一般霧色（動態天空、絕招演出的霧）
    this.skyFogUniforms = {
      uSkyMap: { value: null },
      uSkyMix: { value: 1 },
      uSkyMat: { value: new THREE.Matrix3() },
      uSkyIntensity: { value: 1 },
    }
    this.cinematic = null // 絕招演出中：{ fighter, time, frozenSteps, animStart, fromTarget, fromOffset, zoomPos, zoomTarget }
    this.combat = null // 共用的戰鬥流程（combat.js）：輸入預約、頓幀、吸附、連段等狀態都在裡面
    this.lineSpace = null // 格鬥模式的空間規則
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
      sky: '動態天空',
      skyRotation: 16, // 天空水平轉動角度（度）
      cloudCover: 0.5, // 動態天空的雲量 0 ~ 1
      // 地平線霧：場景模型越遠越融進天空的地平線色（離鏡頭 fogNear ~ fogFar 公尺漸濃），模型邊緣和天空不會有明顯分界
      //   霧色 = 動態天空的地平線色；全景圖則取圖片地平線那一圈的平均色
      horizonFog: true,
      fogNear: 15,
      fogFar: 70,
      // 目前 3D 場景的擺放（切換場景時換成該場景的 transform）：水平轉動（度）、位移（公尺；y 負數 = 往下）、大小倍率
      envRotation: 0,
      envOffsetX: 0,
      envOffsetY: 0,
      envOffsetZ: 0,
      envScale: 1,
      sceneWalls: true, // 場景牆壁當邊界
      showGround: true, // 影子地板
      timeScale: 1,
      paused: false,
      moveSpeed: 2,
      showDebug: false, // 除錯顯示（P）：X 軸刻度尺與座標 + 判定框 + 左右邊界牆
      cameraCollision: false, // 鏡頭避開物體（B）：注視點和鏡頭之間被場景擋住時，鏡頭拉近到物體前面
      showXray: true, // 透視剪影（X）：鏡頭跟隨的人（自由模式跟隨的人、格鬥模式 P1）被場景擋住時，畫出剪影
      showFrameMeter: true, // 幀數表顯示（O）
      showCombo: true, // 連段數顯示
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
    // 操作說明 (?)、除錯 (bug)：一次只開一個
    const closeOthers = (popup, isOpen) => {
      if (isOpen) this.popups.forEach(other => other !== popup && other.isOpen && other.toggle(false))
    }
    this.popups = ['#help', '#debugHelp'].filter(el => document.querySelector(el)).map(el => new Popup({ el, onToggle: closeOthers }))

    // 鎖定鏡頭時滑鼠左鍵拖曳轉鏡頭（一般時由 OrbitControls 處理）
    const canvas = this.renderer.domElement
    canvas.addEventListener('pointerdown', e => {
      if (e.button !== 0 || !this._isCameraLocked()) return
      Object.assign(this.camDrag, { isDragging: true, x: e.clientX, y: e.clientY })
      canvas.setPointerCapture(e.pointerId)
    })
    canvas.addEventListener('pointermove', e => {
      // 自由模式鎖定對手（V）時，滑鼠左鍵拖曳轉鏡頭 = 解除鎖定，交給 OrbitControls
      if ((e.buttons & 1) && (e.movementX || e.movementY)) this.freeMode.setLockOn(false)
      const d = this.camDrag
      if (!d.isDragging) return
      // 轉動速度同 OrbitControls：拖曳畫面高度 = 轉一圈
      const rate = (Math.PI * 2) / canvas.clientHeight
      d.yaw -= (e.clientX - d.x) * rate
      d.pitch -= (e.clientY - d.y) * rate
      d.x = e.clientX
      d.y = e.clientY
    })
    const endDrag = () => { this.camDrag.isDragging = false }
    canvas.addEventListener('pointerup', endDrag)
    canvas.addEventListener('pointercancel', endDrag)

    window.addEventListener('keydown', e => {
      // 出招鍵（數字鍵）：按著數字鍵盤 + = P2 出招，否則 P1；該玩家由 AI 操作時不理會
      const isAttackKey = this._isAttackKey(e.code)
      const slot = isAttackKey && this.keys.has(this.p2AttackKey) ? 'p2' : 'p1'
      if (!e.repeat && isAttackKey && !this.params[`${slot}AI`]) {
        const st = this.combat.input[slot]
        if (e.code === this.p1Keys.light) st.pendingAttack = 'light'
        if (e.code === this.p1Keys.medium) st.pendingAttack = 'medium'
        if (e.code === this.p1Keys.heavy) st.pendingAttack = 'heavy'
        if (e.code === this.p1Keys.rush) st.rushLife = this.rushInputFrames
        if (e.code === this.p1Keys.super) st.pendingAttack = this.params.superMove
        if (this.p1Keys.supers[e.code]) st.pendingAttack = this.p1Keys.supers[e.code]
      }
      // 連按兩下方向鍵 = 衝刺：只有格鬥模式（自由模式用 Shift 快跑）
      if (!e.repeat && !this.freeMode.isActive) {
        this._detectDash('p1', e.code)
        this._detectDash('p2', e.code)
      }
      if (!e.repeat && e.code === 'Digit0') this._togglePause() // 主鍵盤 0（數字鍵盤 0 是衝刺取消）
      // Esc：立刻取消出拳 / 招式（格鬥模式全部重置；自由模式位置、面向保留）
      if (!e.repeat && e.code === 'Escape') this.freeMode.isActive ? this._cancelFreeMoves() : this.resetAll()
      // 介面 / 除錯 / AI / 遊戲速度快捷鍵；在 GUI 輸入框打字時不觸發
      if (!e.target.closest?.('input, textarea, select')) {
        if (!e.repeat && e.code === 'KeyP') this._setDebugVisible(!this.params.showDebug)
        if (!e.repeat && e.code === 'KeyO') this._setFrameMeterVisible(!this.params.showFrameMeter)
        if (!e.repeat && e.code === 'KeyX') this._setXrayVisible(!this.params.showXray)
        // AI：主鍵盤 1 = P1、2 = P2、3 = 全開 / 全關（數字鍵盤的數字是出招鍵，e.code 不同）
        if (!e.repeat && e.code === 'Digit1') this._toggleAI('p1')
        if (!e.repeat && e.code === 'Digit2') this._toggleAI('p2')
        if (!e.repeat && e.code === 'Digit3') this._toggleAllAI()
        if (!e.repeat && e.code === 'KeyC') this.freeMode.switchFollow()
        if (!e.repeat && e.code === 'KeyV') this.freeMode.toggleLockOn()
        if (!e.repeat && e.code === 'KeyB') this._setCameraCollision(!this.params.cameraCollision)
        if (!e.repeat && e.code === 'KeyH') this.startOrbitCamera()
        if (!e.repeat && e.code === 'KeyM') this.toggleFreeMode()
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

  /** 出招鍵（輕 / 中 / 重 / 衝刺取消 / 絕招）：P1 直接按、P2 按著數字鍵盤 + 按同一組鍵 */
  _isAttackKey(code) {
    const k = this.p1Keys
    return [k.light, k.medium, k.heavy, k.rush, k.super].includes(code) || !!k.supers[code]
  }

  /** 幀數表顯示 / 隱藏（O、GUI「顯示幀數表」）；下方的操作說明 (?) 不受影響 */
  _setFrameMeterVisible(isVisible) {
    this.params.showFrameMeter = isVisible
    document.querySelector('#frameMeter')?.classList.toggle('is_uiHide', !isVisible)
    this.guiControllers?.showFrameMeter.updateDisplay()
  }

  /** 透視剪影開關（X、GUI「被擋住時透視角色」），見 _updateXray */
  _setXrayVisible(isVisible) {
    this.params.showXray = isVisible
    this.guiControllers?.showXray.updateDisplay()
  }

  /** 連段數顯示 / 隱藏（GUI「顯示連段數」） */
  _setComboVisible(isVisible) {
    this.params.showCombo = isVisible
    document.querySelectorAll('.index_combo').forEach(el => el.classList.toggle('is_uiHide', !isVisible))
  }

  /** 除錯顯示（P、GUI「顯示除錯」）：X 軸刻度尺與座標、判定框、左右邊界牆一起 */
  _setDebugVisible(isVisible) {
    this.params.showDebug = isVisible
    this.stage.setRulerVisible(isVisible)
    this.stage.setWallsVisible(isVisible)
    this.hud.setCoordsVisible(isVisible)
    ;[this.p1, this.p2].filter(Boolean).forEach(f => f.setDebugVisible(isVisible))
    this.guiControllers?.showDebug.updateDisplay()
  }

  /** 單一玩家的 AI 操作開關（主鍵盤 1 / 2） */
  _toggleAI(slot) {
    this.params[`${slot}AI`] = !this.params[`${slot}AI`]
    this._resetAI(slot)
  }

  /** P1、P2 的 AI 操作一起開關（主鍵盤 3）：兩個都開著就全部關掉，否則全部打開 */
  _toggleAllAI() {
    const isOn = !(this.params.p1AI && this.params.p2AI)
    ;['p1', 'p2'].forEach(slot => {
      if (this.params[`${slot}AI`] === isOn) return
      this.params[`${slot}AI`] = isOn
      this._resetAI(slot)
    })
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

  /** 操作說明裡的按鍵示意：按著的鍵亮起 */
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

    if (this.freeMode.isActive) this.toggleFreeMode() // 換人物：先離開自由模式
    this._endHitCamera() // 換人物：命中鏡頭直接回到一般鏡頭
    this._endOrbitCamera()
    prev?.dispose()
    this.combat.reset()
    this.combat.resetGauges() // 換人物：血量與量條回到初始值
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
      this.combat.setFighters({ p1: this.p1, p2: this.p2 })
    }

    this.isLoading = false
    this._showLoading(false)
  }

  /** 切換 AI 操作：清掉 AI 的狀態與殘留的按鍵 */
  _resetAI(slot) {
    this.ai[slot].reset()
    this.combat.input[slot] = this.combat.newInputState()
  }

  /** 切換天空：全景圖當作無限遠的背景，載入過的會快取 */
  setSky(name) {
    const url = this.skies[name]
    if (!url) return
    this.params.sky = name
    if (url === 'procedural') {
      this._applySky(null)
      return
    }
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

  /** 套用天空：texture = null 時用動態天空；霧色換成這片天空的地平線色 */
  _applySky(texture) {
    this.skyDome.setVisible(!texture)
    this.scene.background = texture || this.skyDome.getHorizonColor()
    this.horizonColor.copy(texture ? this._sampleHorizonColor(texture) : this.skyDome.getHorizonColor())
    this._applySkyRotation()
    this._applyStageLight()
    this._applySuperFog(this.superFogAmount)
  }

  /**
   * 場景模型的材質：霧色改成看出去那個方向的天空貼圖顏色（同背景的轉動），遠處的模型和背景天空接得起來
   * three.js 的霧在轉成輸出色彩之後才套用，取樣的天空顏色也先轉成輸出色彩
   */
  _patchSkyFog(material) {
    material.customProgramCacheKey = () => 'skyFog'
    material.onBeforeCompile = shader => {
      Object.assign(shader.uniforms, this.skyFogUniforms)
      shader.vertexShader = `varying vec3 vSkyFogPos;\n${shader.vertexShader}`.replace(
        '#include <project_vertex>',
        '#include <project_vertex>\n\tvSkyFogPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;',
      )
      shader.fragmentShader = `${SKY_FOG_PARS}\n${shader.fragmentShader}`.replace('#include <fog_fragment>', SKY_FOG_FRAGMENT)
    }
    material.needsUpdate = true
  }

  /** 天空貼圖霧的設定：貼圖、轉動、亮度、和一般霧色的混合 */
  _updateSkyFog() {
    const u = this.skyFogUniforms
    const texture = this.scene.background?.isTexture ? this.scene.background : null
    u.uSkyMap.value = texture
    u.uSkyMix.value = texture ? this.superFogAmount : 1
    u.uSkyIntensity.value = this.scene.backgroundIntensity
    // 同背景的轉動（three.js 的背景：equirect 轉成 cube 後，旋轉角度取負）
    u.uSkyMat.value.setFromMatrix4(new THREE.Matrix4().makeRotationY(-THREE.MathUtils.degToRad(this.params.skyRotation)))
  }

  /** 全景圖地平線那一圈（圖片垂直中間）的平均色 */
  _sampleHorizonColor(texture) {
    const canvas = document.createElement('canvas')
    canvas.width = 64
    canvas.height = 32
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    ctx.drawImage(texture.image, 0, 0, canvas.width, canvas.height)
    const { data } = ctx.getImageData(0, canvas.height / 2 - 1, canvas.width, 2)
    const sum = [0, 0, 0]
    for (let i = 0; i < data.length; i += 4) {
      sum[0] += data[i]
      sum[1] += data[i + 1]
      sum[2] += data[i + 2]
    }
    const count = data.length / 4
    return new THREE.Color().setRGB(sum[0] / count / 255, sum[1] / count / 255, sum[2] / count / 255, THREE.SRGBColorSpace)
  }

  /** 切換 3D 場景：載入完放進場景；地面自己會接影子，影子地板先藏起來（疊在一起會有兩層影子） */
  setScene(name) {
    const entry = this.scenes[name]
    if (!entry) return
    this.params.scene = name
    const { x = 0, y = 0, z = 0, rotation = 0, scale = 1 } = entry.transform || {}
    Object.assign(this.params, { envOffsetX: x, envOffsetY: y, envOffsetZ: z, envRotation: rotation, envScale: scale })
    this.stageMaxHalfWidth = entry.halfWidth ?? this.defaultHalfWidth

    // 沒有場景：拿掉場景模型，影子地板照 GUI 設定
    if (!entry.model) {
      if (this.envModel) this.scene.remove(this.envModel)
      this.envModel = null
      if (this.stage) {
        this._applyStageWidth()
        this.stage.setGroundVisible(this.params.showGround)
      }
      if (this.freeMode?.isActive) this.freeMode.setEnv(null)
      return
    }
    if (!this.envCache[name]) this.envCache[name] = this._loadEnvModel(name, entry)
    this.envCache[name].then(group => {
      if (!group || this.params.scene !== name) return // 載入期間又切到別的場景
      if (this.envModel && this.envModel !== group) this.scene.remove(this.envModel)
      this.envModel = group
      this.scene.add(group)
      this._applyEnvTransform()
      this._applyStageWidth()
      if (this.freeMode.isActive) this.freeMode.setEnv(group)
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
        if (!obj.isMesh) return
        obj.receiveShadow = true
        ;[obj.material].flat().forEach(material => this._patchSkyFog(material))
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
    this.skyDome?.setRotation(this.params.skyRotation)
    this._updateSkyFog()
  }

  /** 3D 場景模型的水平轉動（繞場地中心）、位移與大小 */
  _applyEnvTransform() {
    if (!this.envModel) return
    const { envRotation, envOffsetX, envOffsetY, envOffsetZ, envScale } = this.params
    this.envModel.rotation.y = THREE.MathUtils.degToRad(envRotation)
    this.envModel.position.set(envOffsetX, envOffsetY, envOffsetZ)
    this.envModel.scale.setScalar(envScale)
  }

  /**
   * 打鬥場地寬度（邊界 x = ±stageHalfWidth）：邊界牆、刻度尺、影子範圍一起更新；人物超出的話下一幀被推回邊界內
   * 寬度 = GUI 設定的半寬，開啟「場景牆壁當邊界」時取它和場景牆壁距離較小的那個
   */
  _applyStageWidth() {
    this.stageHalfWidth = Math.min(this.stageMaxHalfWidth, this._getSceneWallDistance())
    this.stage.setHalfWidth(this.stageHalfWidth)
    if (this.freeMode) this.freeMode.bounds = this.stageHalfWidth // 沒有場景時，自由模式限制在這個方框內
    const cam = this.stageLights.dir.shadow.camera
    cam.left = -this.stageHalfWidth - 2
    cam.right = this.stageHalfWidth + 2
    cam.updateProjectionMatrix()
  }

  /**
   * 場景牆壁距離：從場地中心 (0, h, 0) 往左右發射線，最近碰到的場景物體距離
   * 左右取較近的一邊（邊界是左右對稱的）；沒有場景、沒開、或都沒碰到時回傳 Infinity
   * 射線只在換場景 / 調整場景擺放時算一次，不影響每幀效能
   */
  _getSceneWallDistance() {
    if (!this.params.sceneWalls || !this.envModel) return Infinity
    this.envModel.updateMatrixWorld(true)
    const ray = this.wallRaycaster
    ray.far = this.stageMaxHalfWidth
    const origin = new THREE.Vector3()
    const dir = new THREE.Vector3()
    let distance = Infinity
    this.sceneWallHeights.forEach(h => {
      ;[1, -1].forEach(side => {
        ray.set(origin.set(0, h, 0), dir.set(side, 0, 0))
        const hit = ray.intersectObject(this.envModel, true).find(item => item.object.visible)
        if (hit) distance = Math.min(distance, hit.distance)
      })
    })
    return distance
  }

  /**
   * 場地霧：amount 0 = 平常的地平線霧（關掉時推到很遠）、1 = 絕招演出的霧（superCamera 的 fogColor、fogNear ~ fogFar）
   * 中間的顏色與距離線性漸變
   */
  _applySuperFog(amount) {
    this.superFogAmount = amount
    if (!this.fog) return
    const { horizonFog, fogNear, fogFar } = this.params
    const sc = this.superCamera
    const base = horizonFog ? { near: fogNear, far: fogFar } : { near: 1000, far: 1100 }
    this.fog.color.copy(this.horizonColor).lerp(new THREE.Color(sc.fogColor), amount)
    this.fog.near = THREE.MathUtils.lerp(base.near, sc.fogNear, amount)
    this.fog.far = THREE.MathUtils.lerp(base.far, sc.fogFar, amount)
    this._updateSkyFog()
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
    this.skyDome?.setIntensity(dim)
    this._updateSkyFog()
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
    // 霧一直掛在場景上、只改顏色與距離：中途才加上或拿掉 scene.fog 會讓所有材質重新編譯，發動絕招時會頓一下
    // 人物材質關掉 fog（見 Fighter），所以只有場地會被霧蓋住
    this.fog = new THREE.Fog(this.horizonColor, 1000, 1100)
    this.scene.fog = this.fog
    this.skyDome = new SkyDome({ scene: this.scene, cloudCover: this.params.cloudCover })
    this.setSky(this.params.sky)
    this.setScene(this.params.scene)

    this.camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 100)
    this.camera.position.set(0, 1.4, 4.5)
    this.defaultCamera = { pos: this.camera.position.clone(), target: new THREE.Vector3(0, 1, 0) } // 格鬥模式的預設鏡頭（離開自由模式時回到這裡）

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

    this._applySuperFog(0)

    // 絕招打光：從鏡頭位置往人物照的暖色聚光燈（正面打光，臉上不會有頭頂光的濃陰影），平常強度 0
    // aim 是照射點（相對人物腳底，胸口附近）；distance 0 = 照射距離不限，鏡頭拉回時人物仍照得到
    // 不投影：燈在鏡頭位置時影子都在人物背後看不到，開著反而會在人物身上出現網格狀的 shadow acne
    const spot = new THREE.SpotLight(0xffc040, 0, 0, Math.PI / 7, 0.5, 1.5)
    this.superSpot = { light: spot, aim: new THREE.Vector3(0, 1.3, 0), peak: 60 }
    this.scene.add(spot, spot.target)

    this.stage = new Stage({ scene: this.scene, halfWidth: this.stageHalfWidth, showRuler: this.params.showDebug, showWalls: this.params.showDebug, showGround: this.params.showGround })
    this.hitEffect = new HitEffect({ scene: this.scene })
    // P1 腳底的淡藍色橢圓（範圍同推擠框）
    this.footMarker = new FootMarker({ scene: this.scene })
    // 戰鬥流程兩種模式共用，只換空間規則：格鬥模式 LineSpace、自由模式 FreeMode 的 PlaneSpace
    this.lineSpace = new LineSpace({ getHalfWidth: () => this.stageHalfWidth, maxDistance: this.maxDistance, overheadHeight: this.characterHeight * 0.8 })
    this.combat = new Combat({
      space: this.lineSpace,
      sound: this.sound,
      hitEffect: this.hitEffect,
      frameMeter: this.frameMeter,
      hitstopFrames: this.hitstopFrames,
      bufferFrames: this.bufferFrames,
      dashBufferFrames: this.dashBufferFrames,
      rushInputFrames: this.rushInputFrames,
      knockdownSoundFrame: this.knockdownSoundFrame,
      hooks: {
        onHit: (attacker, target, info) => this._onHit(attacker, target, info),
        onCombo: (slot, count) => this.hud?.setCombo(slot, count),
        onSuperStart: (fighter, key) => this._onSuperStart(fighter, key),
        isWaiting: fighter => this._isWaitingSuperStart(fighter),
      },
    })
    this.freeMode = new FreeMode({
      camera: this.camera,
      controls: this.controls,
      combat: this.combat,
      // 離對手近時用格鬥模式的 AI（對手已換算到自己的方向上，沒有邊界牆）
      aiThink: (slot, self, opponent) => this.ai[slot].think(self, opponent, Infinity),
      isStandGuard: slot => slot === 'p2' && this.params.p2Guard,
    })
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

    this._setupGaugeGui(gui)

    const bgFolder = gui.addFolder('背景').close() // 預設收起
    const skyFolder = bgFolder.addFolder('天空盒')
    skyFolder.add(this.params, 'sky', Object.keys(this.skies)).name('天空').listen().onChange(v => this.setSky(v))
    skyFolder.add(this.params, 'skyRotation', 0, 360, 1).name('轉動（度）').onChange(() => this._applySkyRotation())
    skyFolder.add(this.params, 'cloudCover', 0, 1, 0.05).name('雲量（動態天空）').onChange(v => this.skyDome.setCloudCover(v))
    skyFolder.add(this.params, 'horizonFog').name('地平線霧').onChange(() => this._applySuperFog(this.superFogAmount))
    skyFolder.add(this.params, 'fogNear', 0, 60, 1).name('霧開始（m）').onChange(() => this._applySuperFog(this.superFogAmount))
    skyFolder.add(this.params, 'fogFar', 10, 100, 1).name('霧最濃（m）').onChange(() => this._applySuperFog(this.superFogAmount))

    const sceneFolder = bgFolder.addFolder('場景')
    sceneFolder.add(this.params, 'scene', Object.keys(this.scenes)).name('3D 場景').listen().onChange(v => this.setScene(v))
    sceneFolder.add(this.params, 'envRotation', 0, 360, 1).name('轉動（度）').listen().onChange(() => this._applyEnvTransform()).onFinishChange(() => this._applyStageWidth())
    sceneFolder.add(this.params, 'envOffsetX', -20, 20, 0.1).name('左右 X（m）').listen().onChange(() => this._applyEnvTransform()).onFinishChange(() => this._applyStageWidth())
    sceneFolder.add(this.params, 'envOffsetY', -0.5, 0.5, 0.01).name('高度 Y（m）').listen().onChange(() => this._applyEnvTransform()).onFinishChange(() => this._applyStageWidth())
    sceneFolder.add(this.params, 'envOffsetZ', -20, 20, 0.1).name('前後 Z（m）').listen().onChange(() => this._applyEnvTransform()).onFinishChange(() => this._applyStageWidth())
    sceneFolder.add(this.params, 'envScale', 0.2, 3, 0.05).name('大小').listen().onChange(() => this._applyEnvTransform()).onFinishChange(() => this._applyStageWidth())
    sceneFolder.add(this, 'stageMaxHalfWidth', 2, 15, 0.5).name('打鬥場地半寬（m）').listen().onChange(() => this._applyStageWidth())
    sceneFolder.add(this.params, 'sceneWalls').name('場景牆壁當邊界').onChange(() => this._applyStageWidth())
    sceneFolder.add(this.params, 'showGround').name('顯示影子地板').onChange(v => this.stage.setGroundVisible(v && !this.envModel))

    bgFolder.add(this.superCamera, 'dimLevel', 0, 1, 0.05).name('絕招時變暗到')

    const playFolder = gui.addFolder('播放設定')
    this.guiControllers.timeScale = playFolder.add(this.params, 'timeScale', 0, 2, 0.05).name('遊戲速度（- / =）')
    this.pauseController = playFolder.add(this.params, 'paused').name('暫停（主鍵盤 0）')

    const viewFolder = gui.addFolder('顯示')
    this.guiControllers.showFrameMeter = viewFolder.add(this.params, 'showFrameMeter').name('顯示幀數表（O）').onChange(v => this._setFrameMeterVisible(v))
    viewFolder.add(this.params, 'showCombo').name('顯示連段數').onChange(v => this._setComboVisible(v))
    this.guiControllers.showXray = viewFolder.add(this.params, 'showXray').name('被擋住時透視角色（X）')
    this.guiControllers.cameraCollision = viewFolder.add(this.params, 'cameraCollision').name('鏡頭避開物體（B）').onChange(v => this._setCameraCollision(v))
    this.guiControllers.showDebug = viewFolder.add(this.params, 'showDebug').name('顯示除錯：座標、判定框、邊界牆（P）').onChange(v => this._setDebugVisible(v))
    const debugFolder = viewFolder
    debugFolder.add(this.params, 'showSkeleton').name('顯示骨架').onChange(v => {
      fighters().forEach(f => f.setSkeletonVisible(v))
    })
  }

  /**
   * GUI「戰鬥數值」：血量 / 量條的初始值與回復速度、命中 / 被防禦時的增減（點）
   * 量條設定改 P1 的 Gauge 並同步到 P2；命中數值直接改 Combat.gaugeRules（雙方共用）
   * 初始值（血量上限、初始格數）按「重置血量與量條」或換人物後才生效
   */
  _setupGaugeGui(gui) {
    const folder = gui.addFolder('戰鬥數值')
    const { p1, p2 } = this.combat.gauges
    const rules = this.combat.gaugeRules
    const addGauge = (target, key, name, min, max, step) => {
      target.add(p1, key, min, max, step).name(name).onChange(v => { p2[key] = v })
    }

    const baseFolder = folder.addFolder('初始值')
    addGauge(baseFolder, 'maxHp', '血量上限', 1000, 30000, 500)
    addGauge(baseFolder, 'barSize', 'DG / SG 每格點數', 1000, 12000, 500)
    addGauge(baseFolder, 'startDgBars', 'DG 初始格數', 0, p1.maxBars, 1)
    addGauge(baseFolder, 'startSgBars', 'SG 初始格數', 0, p1.maxBars, 1)
    baseFolder.add({ reset: () => this.combat.resetGauges() }, 'reset').name('重置血量與量條')

    const regenFolder = folder.addFolder('回復 / 消耗')
    addGauge(regenFolder, 'dgRegen', 'DG 回復（每 60 幀）', 0, 12000, 100)
    addGauge(regenFolder, 'sgRegen', 'SG 回復（每 60 幀）', 0, 3000, 50)
    addGauge(regenFolder, 'wlDecay', '虛血 WL 減少（每 60 幀）', 0, 2000, 50)
    addGauge(regenFolder, 'emptyRushWL', 'DG 不足衝刺取消：WL 增加', 0, 5000, 100)
    addGauge(regenFolder, 'overflowPerWL', '防禦溢出幾點 DG = 1 WL', 1, 100, 1)
    addGauge(regenFolder, 'dgEmptyDelay', 'DG 歸 0 後幾幀才回復', 0, 600, 10)

    const strengthFolder = folder.addFolder('招式倍率')
    const strengthNames = { light: '輕拳', medium: '中拳', heavy: '重拳', airHeavy: '空中重攻擊' }
    Object.entries(strengthNames).forEach(([key, name]) => strengthFolder.add(rules.strength, key, 0, 5, 0.1).name(name))

    // 擊中 / 被防禦：攻擊方與被打方的增減（× 招式倍率）
    const fieldNames = { damage: '傷害（敵血量減少）', dg: 'DG', oppDg: '敵 DG', sg: 'SG', oppSg: '敵 SG' }
    ;[['hit', '擊中'], ['block', '被防禦']].forEach(([type, title]) => {
      const sub = folder.addFolder(title)
      Object.entries(fieldNames).forEach(([key, name]) => {
        const [min, max] = key === 'damage' ? [0, 2000] : [-3000, 3000]
        sub.add(rules[type], key, min, max, 10).name(name)
      })
    })

    folder.add(rules, 'superDamage', 0, 3000, 50).name('SA 每次擊中傷害')
  }

  /**
   * 格鬥模式一個玩家這一幀的原始輸入（交給 Combat 做預約 / 衝刺取消）：AI 操作時由 AI 決定，否則讀鍵盤
   * 「P2 木樁防禦」打開時 P2 一直防禦
   */
  _getRawInput(slot) {
    const fighter = this[slot]
    const dash = this.pendingDash[slot]
    this.pendingDash[slot] = 0
    if (this.params[`${slot}AI`]) return this.ai[slot].think(fighter, this._getOpponent(fighter), this.stageHalfWidth)

    const keys = slot === 'p1' ? this.p1Keys : this.p2Keys
    let move = (this.keys.has(keys.right) ? 1 : 0) - (this.keys.has(keys.left) ? 1 : 0)
    const jumpKeys = [keys.jump].flat()
    // 下 + 後：站在原地防禦（不後退）；只按後是一邊後退一邊防禦
    const isStandGuard = this.keys.has(keys.down) && move !== 0 && move === -fighter.facingSign
    if (isStandGuard) move = 0
    const isPostGuard = slot === 'p2' && this.params.p2Guard
    return { move, dash, jump: jumpKeys.some(code => this.keys.has(code)), guard: isStandGuard || isPostGuard, standGuard: isStandGuard }
  }

  _getOpponent(fighter) {
    return fighter === this.p1 ? this.p2 : this.p1
  }

  /**
   * 命中（Combat 呼叫）：鏡頭晃動；格鬥模式另有命中鏡頭（第 1 段打中拉近、打飛那一下拉回）與受擊搖晃
   * 自由模式沒有命中鏡頭；受擊搖晃是沿 z 軸搖，自由模式會跟走位衝突，不做
   */
  _onHit(attacker, target, { move, isLaunch, isBlock, hitstop }) {
    if (isBlock) return
    this._startCameraShake(this._getCameraShake(attacker))
    if (this.freeMode.isActive) return
    if (move.hitShake) this._startShake(target, hitstop, move.hitShake === true ? this.hitShake.cycles : move.hitShake)
    if (attacker.getCurrentMove()?.hitCamera) {
      if (isLaunch) this._releaseHitCamera(attacker)
      else if (attacker.hitWindow === 0 && !this.hitCam) this._startHitCamera(attacker)
    }
  }

  /**
   * 絕招開始（Combat 呼叫，招式已停在第 0 幀、第 1 幀音效已播）
   * 格鬥模式：開始鏡頭演出（演出凍結期間由 _updateCinematic 推進），回傳 0
   * 自由模式：不演出、從動畫開頭直接播；回傳對手要凍結的幀數 = 格鬥模式演出凍結（拉近 + 停留）期間放招的人推進的幀數
   */
  _onSuperStart(fighter, key) {
    if (!this.freeMode.isActive) {
      this._startCinematic(fighter, key)
      return 0
    }
    const { zoomIn, hold } = this.superCamera
    return Math.max(0, zoomIn + hold - this._getSuperAnimStart(fighter.moves[key]))
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
    this._endOrbitCamera() // 環繞中打中：先回到一般鏡頭，命中鏡頭才記得到正確的一般鏡頭
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
      distance: this._getZoomDistance(base.offset.length()), // 同絕招拉近：一般鏡頭的距離按比例拉近
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

  /** 鏡頭由程式控制中（OrbitControls 停用）：絕招演出、命中鏡頭、環繞鏡頭 */
  _isCameraLocked() {
    return !!(this._isCinematicCamera() || this.hitCam || this.orbitCam)
  }

  /** 絕招演出控制鏡頭中（演出中按 H 環繞後，演出就不再控制鏡頭，只管燈光與凍結） */
  _isCinematicCamera() {
    return !!this.cinematic && !this.cinematic.isCameraFree
  }

  /**
   * 渲染前：把拖曳的角度疊在目前鏡頭上，繞注視點轉（垂直角度限制在頭頂 ~ 腳底之間）
   * 鎖定結束且放開滑鼠：角度直接併進一般鏡頭（不還原），之後交給 OrbitControls
   */
  _applyCameraDrag() {
    const d = this.camDrag
    d.isApplied = false
    if (!d.yaw && !d.pitch) return
    const isBake = !this._isCameraLocked() && !d.isDragging
    if (!isBake) {
      d.pos.copy(this.camera.position)
      d.quat.copy(this.camera.quaternion)
      d.isApplied = true
    }
    const target = this.controls.target
    this._rotateCamera(this.camera.position, target, d.yaw, d.pitch)
    this.camera.lookAt(target)
    if (isBake) {
      d.yaw = 0
      d.pitch = 0
    }
  }

  /** 透視剪影只開給鏡頭跟隨的人：自由模式 = 跟隨的人（C 切換），格鬥模式 = P1 */
  _updateXray() {
    if (!this.p1 || !this.p2) return
    const target = this.params.showXray ? (this.freeMode.isActive ? this[this.freeMode.followSlot] : this.p1) : null
    ;[this.p1, this.p2].forEach(f => f.setXray(f === target))
  }

  /** 鏡頭避開物體開關（B、GUI）：打開時替場景模型建 BVH，射線才夠快 */
  _setCameraCollision(isOn) {
    this.params.cameraCollision = isOn
    this.camCollide.dist = Infinity
    if (isOn && this.envModel) this.freeMode._buildBVH(this.envModel)
    this.guiControllers?.cameraCollision.updateDisplay()
  }

  /**
   * 渲染前：從注視點往鏡頭發射線，被場景模型擋住就把鏡頭拉近到擋住的地方前面（留 margin，最近 minDist）
   * 擋住時立刻拉近（不會穿進物體），沒擋住時慢慢退回原本的距離
   */
  _applyCameraCollision(delta) {
    const cc = this.camCollide
    cc.isApplied = false
    if (!this.params.cameraCollision || !this.envModel) return
    const margin = 0.25
    const minDist = 0.6
    const target = this.controls.target
    const dir = this.camera.position.clone().sub(target)
    const full = dir.length()
    if (full < 1e-4) return
    dir.divideScalar(full)

    this.freeMode._buildBVH(this.envModel) // 換場景後第一次用到時建（已建過會跳過）
    const ray = cc.raycaster
    ray.far = full
    ray.set(target, dir)
    const hit = ray.intersectObject(this.envModel, true).find(item => item.object.visible)
    const goal = hit ? Math.max(minDist, hit.distance - margin) : full

    cc.dist = Math.min(cc.dist, full)
    cc.dist = goal < cc.dist ? goal : cc.dist + (goal - cc.dist) * Math.min(1, delta * 4)
    if (cc.dist >= full - 1e-3) return
    cc.pos.copy(this.camera.position)
    this.camera.position.copy(target).addScaledVector(dir, cc.dist)
    cc.isApplied = true
  }

  _restoreCameraCollision() {
    const cc = this.camCollide
    if (cc.isApplied) this.camera.position.copy(cc.pos)
  }

  /** 渲染後：還原成演出鏡頭本身的位置，演出的計算不受拖曳影響 */
  _restoreCameraDrag() {
    const d = this.camDrag
    if (!d.isApplied) return
    this.camera.position.copy(d.pos)
    this.camera.quaternion.copy(d.quat)
  }

  /**
   * 自由模式切換（M）：進入時中斷招式與演出，人物在場景裡自由走動（見 freeMode.js），鏡頭平滑轉成俯角看 P1
   * 離開時兩人回到開場的格鬥位置（x = ±startGap / 2、面向對方），鏡頭回到格鬥模式的預設位置
   */
  toggleFreeMode() {
    if (!this.p1 || !this.p2) return
    const fm = this.freeMode
    if (!fm.isActive) {
      this.resetAll()
      this.combat.space = fm.space
      fm.enter({ p1: this.p1, p2: this.p2 }, this.envModel)
      this.hud.setCoordsVisible(false)
      this._setHelpMode(true)
      return
    }

    fm.exit()
    this.combat.space = this.lineSpace
    this.p1.x = -this.startGap / 2
    this.p2.x = this.startGap / 2
    this.resetAll() // 回到站立：y、z 歸零、面向左右
    this.p1.faceTo(this.p2, true)
    this.p2.faceTo(this.p1, true)
    this.controls.target.copy(this.defaultCamera.target)
    this.camera.position.copy(this.defaultCamera.pos)
    this.cameraPull = 0
    this.hud.setCoordsVisible(this.params.showDebug)
    this._setHelpMode(false)
  }

  /** 操作說明 / 除錯視窗切換成自由 / 格鬥模式的內容 */
  _setHelpMode(isFree) {
    this.helpDockEl.classList.toggle('is_free', isFree)
  }

  /** 自由模式的 Esc：立刻取消所有出拳、招式（位置、面向保留），停掉音效、特效、晃鏡頭與輸入預約 */
  _cancelFreeMoves() {
    this.freeMode.cancelAll() // 也會清掉 combat 的頓幀、吸附、輸入預約
    this.ai.p1.reset()
    this.ai.p2.reset()
    this.sound.stopAll()
    this.hitEffect.clear()
    this.camShake = null
  }

  /** 拉近後的鏡頭距離：目前距離 × zoomRate，但不比 superCamera.distance 更近（也不比目前更遠） */
  _getZoomDistance(currentDistance) {
    const { distance, zoomRate } = this.superCamera
    return Math.min(currentDistance, Math.max(distance, currentDistance * zoomRate))
  }

  /**
   * 環繞鏡頭開始（H）：環繞中不理會
   * 絕招演出、命中鏡頭中也可以按：解除它們的鏡頭鎖定，繞的是它們開始前的一般鏡頭；演出本身（燈光、凍結）照常
   * 從目前畫面的鏡頭（含滑鼠拖曳的角度）開始，前 pullTime 秒過渡到環繞的路線，不會跳一下
   */
  startOrbitCamera() {
    if (!this.p1 || !this.p2 || this.orbitCam || this.freeMode.isActive) return
    const c = this.cinematic
    const h = this.hitCam
    let base
    if (h) base = { target: h.base.target.clone(), offset: h.base.offset.clone() }
    else if (c) base = { target: c.fromTarget.clone(), offset: c.fromOffset.clone() }
    else base = { target: this.controls.target.clone(), offset: this.camera.position.clone().sub(this.controls.target) }
    if (c) c.isCameraFree = true
    this.hitCam = null

    // 起點 = 畫面上看到的鏡頭：拖曳角度併進來後歸零
    const fromTarget = this.controls.target.clone()
    const fromPos = this._rotateCamera(this.camera.position.clone(), fromTarget, this.camDrag.yaw, this.camDrag.pitch)
    this.camDrag.yaw = 0
    this.camDrag.pitch = 0

    this.orbitCam = { time: 0, ...base, fromPos, fromTarget }
    this.controls.enabled = false
  }

  /** pos 繞 target 轉 yaw（水平）、pitch（垂直，限制在頭頂 ~ 腳底之間），回傳 pos */
  _rotateCamera(pos, target, yaw, pitch) {
    if (!yaw && !pitch) return pos
    const sph = new THREE.Spherical().setFromVector3(pos.sub(target))
    sph.theta += yaw
    sph.phi = THREE.MathUtils.clamp(sph.phi + pitch, 0.05, Math.PI - 0.05)
    return pos.setFromSpherical(sph).add(target)
  }

  /**
   * 環繞鏡頭每個畫面更新：注視點跟著兩人中點，鏡頭繞著它轉一整圈（慢進慢出）
   * 距離倍率：前 pullTime 秒拉遠到 pullScale、最後 returnTime 秒拉回 1，轉完剛好回到原本的位置
   */
  _updateOrbitCamera(realDelta) {
    const o = this.orbitCam
    const { duration, pullTime, returnTime, pullScale } = this.orbitCamera
    o.time += realDelta
    const smooth = t => t * t * (3 - 2 * t)
    const easeInOut = t => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2)
    const angle = Math.PI * 2 * easeInOut(Math.min(1, o.time / duration))
    const pullOut = smooth(Math.min(1, o.time / pullTime))
    const pullBack = smooth(THREE.MathUtils.clamp((duration - o.time) / returnTime, 0, 1))
    const scale = 1 + (pullScale - 1) * Math.min(pullOut, pullBack)

    const target = o.target.clone()
    target.x = (this.p1.x + this.p2.x) / 2
    const offset = o.offset.clone().applyAxisAngle(THREE.Object3D.DEFAULT_UP, angle).multiplyScalar(scale)
    const pos = target.clone().add(offset)
    // 前 pullTime 秒：從開始時的鏡頭（例如絕招拉近的鏡頭）過渡到環繞路線
    this.camera.position.lerpVectors(o.fromPos, pos, pullOut)
    this.controls.target.lerpVectors(o.fromTarget, target, pullOut)
    this.camera.lookAt(this.controls.target)

    if (o.time >= duration) this._endOrbitCamera()
  }

  /** 環繞鏡頭結束：回到開始時的一般鏡頭（注視點對齊兩人中點） */
  _endOrbitCamera() {
    const o = this.orbitCam
    if (!o) return
    const target = o.target.clone()
    if (this.p1 && this.p2) target.x = (this.p1.x + this.p2.x) / 2
    this.camera.position.copy(target).add(o.offset)
    this.controls.target.copy(target)
    this.controls.enabled = !this._isCinematicCamera()
    this.orbitCam = null
  }

  /** 命中鏡頭直接回到一般鏡頭（Esc 重置、換人物） */
  _endHitCamera() {
    const h = this.hitCam
    if (!h) return
    const target = h.base.target.clone()
    if (this.p1 && this.p2) target.x = (this.p1.x + this.p2.x) / 2
    this.camera.position.copy(target).add(h.base.offset)
    this.controls.target.copy(target)
    this.controls.enabled = !this._isCinematicCamera()
    this.cameraPull = 0
    this.hitCam = null
  }

  /** 招式的命中鏡頭設定：預設值（main.js hitCamera）+ 招式的 hitCamera 物件（true = 全用預設） */
  _getHitCameraConfig(move) {
    const own = typeof move?.hitCamera === 'object' ? move.hitCamera : {}
    return { ...this.hitCamera, ...own, lookAhead: { ...this.hitCamera.lookAhead, ...own.lookAhead } }
  }

  /** 命中鏡頭的位置：攻擊方背後、往鏡頭那側偏 angle 度，距離 distance，看著攻擊方胸口（再偏 lookAhead：x 往對手、y 往上） */
  _getHitCameraPose(fighter, cfg, distance) {
    const { angle, height, lookAhead } = cfg
    const a = THREE.MathUtils.degToRad(angle)
    const target = new THREE.Vector3(fighter.x + fighter.facingSign * lookAhead.x, this.characterHeight * 0.7 + lookAhead.y, 0)
    const back = new THREE.Vector3(-fighter.facingSign * Math.cos(a), 0, Math.sin(a))
    const pos = target.clone().addScaledVector(back, distance)
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
      ;({ pos: toPos, target: toTarget } = this._getHitCameraPose(f, h.cfg, h.distance))
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
      this.controls.enabled = !this._isCinematicCamera()
      this.cameraPull = 0
      this.hitCam = null
    }
  }

  /** 絕招演出開始：人物停在招式第 0 幀，鏡頭從目前位置拉近到人物胸口 */
  _startCinematic(fighter, key) {
    this._endOrbitCamera() // 環繞中放絕招：先回到一般鏡頭，演出結束才回得去
    fighter.snapToCurrentAction() // 演出停頓期間顯示絕招的第 1 幀（不從之前的動作淡入）
    // 畫面補間的「上一幀」也記成絕招第 1 幀：之後 _animate 會再記一次，前後兩幀都是絕招第 1 幀
    // 不然 animStart 是 zoomOut / after 的絕招（凍結期間不推進），凍結結束的第一個畫面會內插回出招前的姿勢（看起來像閃回閒置）
    fighter.captureFrame()

    const fromTarget = this.controls.target.clone()
    const fromOffset = this.camera.position.clone().sub(fromTarget) // 一般鏡頭相對注視點的位置
    const zoomTarget = new THREE.Vector3(fighter.x, this.characterHeight * 0.7, 0)
    // 沿著目前鏡頭的方向按比例拉近（不比 superCamera.distance 更近）
    const zoomPos = zoomTarget.clone().addScaledVector(fromOffset.clone().normalize(), this._getZoomDistance(fromOffset.length()))

    this.cinematic = { fighter, time: 0, frozenSteps: 0, animStart: this._getSuperAnimStart(fighter.moves[key]), fromTarget, fromOffset, zoomPos, zoomTarget }
    this.controls.enabled = false
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

  _togglePause() {
    this.params.paused = !this.params.paused
    this.pauseController?.updateDisplay()
  }

  /** Esc：中斷所有招式、演出、頓幀、吸附、輸入預約與音效，雙方回到站立（位置保留） */
  resetAll() {
    if (!this.p1 || !this.p2) return
    this._endHitCamera()
    this._endOrbitCamera()
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
    this.accumulator = 0
    this.combat.reset()
    this.pendingDash = { p1: 0, p2: 0 }
    this.ai.p1.reset()
    this.ai.p2.reset()
    this.sound.stopAll()
    this.p1.resetToIdle()
    this.p2.resetToIdle()
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
      this.combat.stepFrozen(c.fighter)
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
    // 按 H 解除後（isCameraFree）鏡頭也不歸演出管
    if (!this.hitCam && !c.isCameraFree) {
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
      if (!this.hitCam && !c.isCameraFree) {
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

  _animate = () => {
    requestAnimationFrame(this._animate)
    // 切分頁回來時 delta 可能很大，限制上限避免一次補太多幀
    const realDelta = Math.min(this.clock.getDelta(), 0.1)

    if (this.cinematic) this._updateCinematic(realDelta)

    const fighters = this.p1 && this.p2 ? [this.p1, this.p2] : []
    // 自由模式：不跑格鬥邏輯與畫面補間，人物由 FreeMode 直接移動
    const isFree = this.freeMode.isActive
    if (fighters.length && isFree) {
      this.freeMode.update(this.params.paused ? 0 : realDelta * this.params.timeScale, this.keys, { p1: this.params.p1AI, p2: this.params.p2AI }, realDelta)
      this.freeMode.applyInterpolation(this.params.paused)
      this.hitEffect.update(this.params.paused ? 0 : realDelta * this.params.timeScale)
      this.footMarker.update() // 推擠框跟著人物走，腳底橢圓也跟著
    } else if (fighters.length) {
      const step = 1 / FPS
      if (!this._isFrozen()) {
        this.accumulator += this.params.paused ? 0 : realDelta * this.params.timeScale
        // 絕招演出開始後剩下的時間不再補幀
        while (this.accumulator >= step && !this._isFrozen()) {
          this.accumulator -= step
          this.combat.step({ p1: this._getRawInput('p1'), p2: this._getRawInput('p2') })
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
      else if (this.orbitCam) this._updateOrbitCamera(realDelta)
      else if (!this._isCinematicCamera()) this._followCamera(realDelta)
      this.hud.updateCoords(fighters)
      // 人物位置更新完才對齊腳底橢圓
      this.footMarker.update()
    }

    // 演出中由 _updateCinematic 控制鏡頭、命中鏡頭中由 _updateHitCamera 控制、環繞中由 _updateOrbitCamera 控制
    if (!this._isCameraLocked()) this.controls.update()
    this.hud.update(realDelta)
    this.hud.updateGauges(this.combat.gauges)
    this.skyDome.update(realDelta, this.camera)

    this._updateXray()
    this._applyCameraDrag()
    this._applyCameraCollision(realDelta)
    this._applyCameraShake(this.params.paused ? 0 : realDelta * this.params.timeScale)
    this.renderer.render(this.scene, this.camera)
    this.camera.position.sub(this.camShakeOffset) // 晃動只影響這個畫面
    this._restoreCameraCollision()
    this._restoreCameraDrag()
    // 還原成邏輯幀的姿勢，下一次推進從正確的狀態繼續
    if (isFree) this.freeMode.restoreFrames()
    else fighters.forEach(f => f.restoreFrame())
  }
}

// 掛到 window 方便在 DevTools console 裡直接查看，例如 viewer.p1、viewer.p2
window.viewer = new FighterViewer()
