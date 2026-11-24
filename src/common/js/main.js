import * as THREE from 'three'
import GUI from 'three/addons/libs/lil-gui.module.min.js'
import { Fighter, FPS } from './games/fighting/fighter.js'
import { FrameMeter } from './games/fighting/frameMeter.js'
import { MixamoLoader } from './engine/assets/mixamoLoader.js'
import { Stage } from './games/fighting/stage.js'
import { Hud } from './games/fighting/hud.js'
import { Popup } from './engine/ui/popup.js'
import { Sound } from './engine/audio/sound.js'
import { HitEffect } from './engine/fx/hitEffect.js'
import { FootMarker } from './games/fighting/footMarker.js'
import { FreeMode } from './games/fighting/freeMode.js'
import { Combat, LineSpace } from './games/fighting/combat.js'
import { addSmileMorph } from './engine/character/faceMorph.js'
import { FighterAI, AI_LEVELS } from './games/fighting/ai.js'
import { Roguelike } from './games/fighting/roguelike.js'
import { WEATHERS } from './engine/world/atmosphere.js'
import { GameCore } from './engine/core/gameCore.js'
import { OrbitCamera } from './engine/camera/orbitCamera.js'
import { PointerLook } from './engine/input/pointerLook.js'
import { brightenScene, getHipsPin, makeInPlace, speedUpClip, trimClip } from './engine/assets/clipTools.js'

const MODEL_DIR = 'src/model'
// 聲音依用途分資料夾：fight/hit 打擊、fight/superArt 絕招；weather 天氣、ambient 環境（之後加）
const SOUND_DIR = 'src/sound'
const FIGHT_HIT_SOUND_DIR = `${SOUND_DIR}/fight/hit`
const FIGHT_SUPER_SOUND_DIR = `${SOUND_DIR}/fight/superArt`
const AMBIENT_SOUND_DIR = `${SOUND_DIR}/ambient`
const SUPER_ARTS = ['dog_bear', 'kick_ball', 'monkey_turn', 'shake_head', 'dodge_step', 'wind_step']

/**
 * FighterViewer：雙人對戰場景
 * 流程：建立場景 → 載入人物 FBX 與共用動作 FBX，在程式裡綁定（見 mixamoLoader.js）
 *       → 建立 P1 / P2 Fighter → 固定 60fps 推進遊戲邏輯（_step）：
 *         輸入 → 人物更新 → 吸附 → 推擠 → 面向 → 命中判定 → 連段 → 幀數表
 *       → 畫面更新（GameCore 的遊戲迴圈呼叫 _update / _beforeRender / _afterRender）：絕招演出、鏡頭、HUD 與渲染，跟螢幕更新率走
 * 絕招演出：鏡頭拉近 + 停留期間只有放招的人推進招式（幀數表記成凍結中的前搖），其他一切暫停；鏡頭拉回時遊戲已經繼續
 * P2 用方向鍵操作（← → 移動 / 防禦、↑ 跳、↓ + 後原地防禦），按著 Shift 再按 P1 的數字鍵 = P2 出招；GUI 勾選「AI 操作」時改由 ai.js 操作
 */
class FighterViewer {
  constructor(options) {
    const def = {
      el: '#stage',
      characters: [
        { name: 'Zhao Tiechun', url: `${MODEL_DIR}/characters/meshy.glb`, brightness: 1.35, smile: { corners: [[-0.034, 1.556], [0.034, 1.556]], radius: 0.014, lift: 0.007, outward: 0.003, back: 0.002, minZ: 0.05 } },
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
        fastRun: `${MODEL_DIR}/anims/normal/StandardRun.fbx`, // 自由模式的衝刺
        dash: `${MODEL_DIR}/anims/normal/Walking_dash.fbx`, // 衝刺（地面 / 空中 / 衝刺取消共用），後衝倒著播
        hit: `${MODEL_DIR}/anims/normal/HitTo.fbx`,
        light: `${MODEL_DIR}/anims/normal/Punching_L.fbx`,
        medium: `${MODEL_DIR}/anims/normal/Punching_M.fbx`,
        heavy: `${MODEL_DIR}/anims/normal/Punching_H.fbx`,
        airHeavy: `${MODEL_DIR}/anims/normal/MmaKick.fbx`, // 空中重攻擊
        fly: `${MODEL_DIR}/anims/normal/FlyingBack.fbx`, // 被打飛（招式的 launch）、浮空挨打（lock.juggle）
        getUp: `${MODEL_DIR}/anims/normal/KipUp.fbx`, // 飛走後起身
        // 血量 0、連段結束：站著死（受擊 / 防禦硬直結束時）；被打飛的 fly 播完倒地後接 flyDeath（播完不起身，期間無敵）
        death: `${MODEL_DIR}/anims/normal/Standing_Death.fbx`,
        flyDeath: `${MODEL_DIR}/anims/normal/FlyingBack_Death.fbx`,
        jump: `${MODEL_DIR}/anims/normal/Jumping.fbx`,
        block: `${MODEL_DIR}/anims/normal/BodyBlock.fbx`,
        // 自由模式坐下（freeMode.js sitAnims）：坐下 = standUp 倒著播 → sitIdle 循環；起身 = standUp 正著播
        standUp: `${MODEL_DIR}/anims/normal/StandingUp.fbx`,
        sitIdle: `${MODEL_DIR}/anims/normal/SittingIdle.fbx`,
        hideIdle: `${MODEL_DIR}/anims/normal/StandardIdle.fbx`, // 躲在櫃子裡站著（freeMode.js hide.idleAnim）
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
      // 接在另一個動作後面播的動作：臀部水平位置固定在對齊目標的位置（動作 key → 目標 key），才不會偏離人物
      //   FlyingBack_Death 原檔的臀部回到 x 0、z 0，跟 FlyingBack 固定的位置不同，接上時人會跳開
      alignHipsAnims: { flyDeath: 'fly' },
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
        standUp: { start: 68, end: 12 }, // 起身（坐下時倒著播）：結尾跟 idle 接不太起來，裁掉最後 20 幀
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
      //   props = 放在場景裡的物件（世界座標，不跟 transform 移動）：
      //     { type: 'sit', url, position: [x, y, z], rotation（度）, scale, radius } 可以坐下的物件（sitSpot.js；自由模式靠近按 F）
      //     { type: 'hide', url, position, facing（門朝的方向，度）, height } 可以躲進去的物件（hideSpot.js；實心，F 躲藏 / 離開）
      scenes: {
        無: { model: null, halfWidth: 5 },
        庭院: { model: `${MODEL_DIR}/background/courtyard.glb`, ground: [0.0252, -0.0414, 0.6321], transform: { x: -0.3, y: -0.03, z: 4, rotation: 0, scale: 0.9 } },
        // 模型中央是房子與門口台階：往後移，人物站在房子前的空地，房子當背景
        閥門房: {
          model: `${MODEL_DIR}/background/bayard_station_valve_house.glb`, ground: [0.0013, -0.0167, 9.416], transform: { x: 1.5, y: -0.05, z: -8.1, rotation: 0, scale: 0.9 },
          props: [{ type: 'sit', url: `${MODEL_DIR}/items/animated_fire.glb`, position: [-4.5, 0, -2.5] }],
        },
        // 室內（天花板約 2.8 公尺）：模型裡 (-28, -1) 那塊大廳移到場地中心，打鬥線到鏡頭之間左右 7.5 公尺內沒有牆，背後牆約 3 公尺
        後室: {
          model: `${MODEL_DIR}/background/backrooms_vr.glb`, ground: [0, 0, -0.12], transform: { x: 28, y: 0, z: 1, rotation: 0, scale: 1 },
          props: [
            { type: 'sit', url: `${MODEL_DIR}/items/animated_fire.glb`, position: [28, 0, 2] },
            // 櫃子靠在打鬥場地後面的牆邊（牆約在 z = -3.3），門朝鏡頭（+z）
            { type: 'hide', url: `${MODEL_DIR}/items/locker_rough_texture.glb`, position: [3, 0, -2.9], facing: 0 },
          ],
        },
        // 後室 2：另一張後室地圖（條紋 / 點點壁紙、地毯）；模型原點那塊就是空地：左右 8.8 公尺、前 13 公尺、背後牆 3.6 公尺
        後室2: { model: `${MODEL_DIR}/background/backrooms_vr2.glb`, ground: [0, 0, 0.01], transform: { x: 0, y: 0, z: 0, rotation: 0, scale: 1 } },
        // PSX 後室：PS1 風格的低面數後室；模型裡 (6, -22) 那塊移到場地中心：左右 9 公尺、前 16 公尺、背後牆 6 公尺，打鬥線到鏡頭之間沒有牆
        PSX後室: { model: `${MODEL_DIR}/background/psx_-_backroom.glb`, ground: [0, 0, -0.34], transform: { x: -6, y: 0, z: 22, rotation: 0, scale: 1 } },
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
      startGap: 3, // 開場兩人距離（P1 x = -1.5、P2 x = 1.5）
      // 選完升級牌進下一層時 P1 的補給：血量 + 上限的 hpRate、DG / SG 各 + 幾格（血量 / 量條其餘保留，不會回滿）
      stageReward: { hpRate: 0.1, dgBars: 1, sgBars: 1 },
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
      // 自由模式 → 格鬥模式（M）：人物飛回開場位置、鏡頭移回預設位置的過渡（時間同進入自由模式的鏡頭轉向 freeMode.js enterTime）
      //   arcHeight = 飛行弧線最高多高（公尺）
      fightReturn: { arcHeight: 1.2 },
      // 音效：一般招式命中 hit、絕招命中 superHit、防禦住 block、倒地 knockdown；其他 key 給招式的 sounds 用；{ url, volume } 可個別調音量
      sounds: {
        // 格鬥：打擊、防禦、倒地（src/sound/fight/hit）
        hit: { url: `${FIGHT_HIT_SOUND_DIR}/hit2.mp3`, volume: 0.8 },
        superHit: { url: `${FIGHT_HIT_SOUND_DIR}/hit2.mp3`, volume: 0.8 },
        block: `${FIGHT_HIT_SOUND_DIR}/hit1.mp3`,
        knockdown: `${FIGHT_HIT_SOUND_DIR}/knockdown.wav`,
        // 格鬥：絕招的語音、音效（src/sound/fight/superArt）
        dog_bear: `${FIGHT_SUPER_SOUND_DIR}/dog_bear.wav`,
        dog_bear_title: `${FIGHT_SUPER_SOUND_DIR}/dog_bear_title.wav`,
        kick_ball_title: `${FIGHT_SUPER_SOUND_DIR}/kick_ball_title.wav`,
        shake_head: `${FIGHT_SUPER_SOUND_DIR}/shake_head.wav`,
        shake_head_title: `${FIGHT_SUPER_SOUND_DIR}/shake_head_title.wav`,
        dodge_step_title: `${FIGHT_SUPER_SOUND_DIR}/dodge_step_title.wav`,
        wind_step_title: { url: `${FIGHT_SUPER_SOUND_DIR}/wind_step_title.wav`, volume: 0.8 },
        // 環境（src/sound/ambient）：循環播放，音量跟著天氣（見 _updateWeatherSound）
        raining: `${AMBIENT_SOUND_DIR}/raining.wav`,
        // 天氣（src/sound/weather）：之後加
      },
      // 天氣聲：音量變化的平滑秒數（雨量本身也會依天氣過渡慢慢變，兩個疊起來）
      weatherSoundFade: 1,
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
        // 絕招欄位（數字鍵盤 4 / 5 / 6）：依序放 roguelike 學到的絕招（第 1 格是一開始就會的閃身步）
        superSlots: ['Numpad4', 'Numpad5', 'Numpad6'],
        // 除錯：主鍵盤 4 ~ 9 直接出絕招（不管有沒有學到；SG 照樣要 1 格）
        debugSupers: { Digit4: 'dodge_step', Digit5: 'kick_ball', Digit6: 'wind_step', Digit7: 'dog_bear', Digit8: 'shake_head', Digit9: 'monkey_turn' },
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
    this.mixamo = new MixamoLoader()
    this.sourceCache = {} // url → Promise<{ scene, clips }>，同一個人物只綁定一次
    this.p1 = null
    this.p2 = null
    this.keys = new Set()
    // GUI 勾選「AI 操作」時由 AI 按鍵；SG 不滿 1 格時不放絕招
    this.ai = {
      p1: new FighterAI({
        canSuper: () => this.combat.gauges.p1.canSuper,
        getGauges: () => ({ self: this.combat.gauges.p1, opp: this.combat.gauges.p2 }),
        getSuperStartup: (fighter, key) => this._getSuperStartup(fighter, key),
      }),
      p2: new FighterAI({
        canSuper: () => this.combat.gauges.p2.canSuper,
        getGauges: () => ({ self: this.combat.gauges.p2, opp: this.combat.gauges.p1 }),
        getSuperStartup: (fighter, key) => this._getSuperStartup(fighter, key),
      }),
    }
    this.pendingDash = { p1: 0, p2: 0 } // 格鬥模式連按兩下方向鍵：衝刺方向（世界座標），下一幀遊戲邏輯取走
    this.lastTap = { p1: { code: '', time: 0 }, p2: { code: '', time: 0 } } // 上一次按下的方向鍵，判斷連按用
    this.stageMaxHalfWidth = this.stageHalfWidth // GUI 設定的場地半寬；實際邊界 stageHalfWidth 可能被場景的牆縮小
    this.defaultHalfWidth = this.stageHalfWidth // 場景沒填 halfWidth 時用的半寬
    this.activeProp = null // P1 正在用的物件（坐著的營火、躲著的櫃子）
    this.cameraPull = 0 // 跳躍時鏡頭額外往後拉的距離
    this.returning = null // 自由 → 格鬥模式的過渡中：{ time, duration, items: [{ fighter, from, to, fromRot, toRot }], camFrom, camTo }
    this.hitCam = null // 命中鏡頭中：{ attacker, move, phase: 'in' / 'out', time, fromPos, fromTarget, base: { target, offset } }
    this.shake = null // 受擊搖晃中：{ fighter, time, duration }（秒）
    this.accumulator = 0 // 尚未消化的時間，累積滿 1/60 秒就推進 1 幀
    this.superDim = 0 // 絕招演出的變暗程度（0 = 正常、1 = 暗到 dimLevel）
    this.superFogAmount = 0 // 絕招演出的霧濃度 0 ~ 1（場地的霧：平常是地平線霧，演出時漸變成演出的霧，人物不受影響）
    // 以下在 _setupScene 建立（engine/）：
    //   sky 天空與霧、environment 場景模型與物件、cameraShaker 晃鏡頭、cameraCollision 鏡頭避開物體、
    //   cameraDrag 鎖定鏡頭時拖曳、orbiter 環繞鏡頭（H）、pointerLook 自由模式的滑鼠視角
    this.cinematic = null // 絕招演出中：{ fighter, time, frozenSteps, animStart, fromTarget, fromOffset, zoomPos, zoomTarget }
    this.combat = null // 共用的戰鬥流程（combat.js）：輸入預約、頓幀、吸附、連段等狀態都在裡面
    this.lineSpace = null // 格鬥模式的空間規則
    this.superSpot = null // 絕招聚光燈：{ light, aim, peak }
    this.frameMeter = new FrameMeter()
    // 關卡制 + 升級牌（試做）：升級套在 P1 身上
    this.roguelike = new Roguelike({
      slotLabels: this.p1Keys.superSlots.map(code => code.replace('Numpad', '')),
      getContext: () => this.p1 && { fighter: this.p1, gauge: this.combat.gauges.p1 },
      onPicked: () => this._startNextStage(),
      onRestart: () => this._restartRun(),
    })
    this.sound = new Sound({ files: this.sounds })
    this.isLoading = false
    this.params = {
      p1: this.characters[0].name,
      p2: this.characters[1].name,
      p2Guard: false, // P2 木樁一直按著後（防禦）
      p1AI: false, // P1 由 AI 操作
      p2AI: false, // P2 由 AI 操作
      p2AILevel: 'easy', // P2 電腦難度（AI_LEVELS 的 key）：每層開始時依層數自動設定，GUI 可在這一層中途改
      scene: '閥門房',
      sky: '動態天空',
      skyRotation: 16, // 天空水平轉動角度（度）
      cloudCover: 0.5, // 動態天空的雲量 0 ~ 1
      // 地平線霧：場景模型越遠越融進天空的地平線色（離鏡頭 fogNear ~ fogFar 公尺漸濃），模型邊緣和天空不會有明顯分界
      //   霧色 = 動態天空的地平線色；全景圖則取圖片地平線那一圈的平均色
      horizonFog: true,
      fogNear: 15,
      fogFar: 70,
      // 黑暗霧（取代地平線霧）：以中心點為圓心，開始 ~ 全暗（公尺）之間漸暗；天空變暗 0 ~ 1；人物不受影響
      darkFog: false,
      darkFogCenter: '鏡頭', // 鏡頭 / 人物（自由模式 = 鏡頭跟隨的人，格鬥模式 = P1）
      darkFogNear: 4,
      darkFogFar: 14,
      darkFogSky: 1,
      darkFogColor: '#000000',
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
      showDebug: false, // 除錯顯示（O）：X 軸刻度尺與座標 + 判定框 + 左右邊界牆
      cameraCollision: false, // 鏡頭避開物體（B）：注視點和鏡頭之間被場景擋住時，鏡頭拉近到物體前面
      showXray: true, // 透視剪影（X）：鏡頭跟隨的人（自由模式跟隨的人、格鬥模式 P1）被場景擋住時，畫出剪影
      showFrameMeter: true, // 幀數表 + 連段傷害顯示（P）
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
    this.core.start()

    try {
      await this.setCharacter('p1', this.params.p1)
      await this.setCharacter('p2', this.params.p2)
    } catch (err) {
      console.error(err)
      this._showLoading(true, '載入失敗，請看 console')
    }
  }

  bindEvents() {
    // 操作說明 (?)、除錯 (bug)：一次只開一個
    const closeOthers = (popup, isOpen) => {
      if (isOpen) this.popups.forEach(other => other !== popup && other.isOpen && other.toggle(false))
    }
    this.popups = ['#help', '#debugHelp'].filter(el => document.querySelector(el)).map(el => new Popup({ el, onToggle: closeOthers }))

    window.addEventListener('keydown', e => {
      // Alt：放開滑鼠鎖定（自由模式），游標出現可以點 GUI；點畫面再鎖定
      if (e.code === 'AltLeft' || e.code === 'AltRight') {
        e.preventDefault()
        this.pointerLook.unlock()
      }
      // 選升級牌中：1 / 2 / 3（主鍵盤或數字鍵盤）選牌；結算視窗：Enter 重新開始（按鈕有焦點時空白鍵也可以）；其他遊戲按鍵都不理
      if (this.roguelike.isChoosing) {
        const index = ['1', '2', '3'].indexOf(e.code.replace(/^(Digit|Numpad)/, ''))
        if (!e.repeat && index >= 0) this.roguelike.choose(index)
        return
      }
      if (this.roguelike.isGameOver) {
        if (!e.repeat && (e.code === 'Enter' || e.code === 'NumpadEnter')) {
          e.preventDefault() // 按鈕有焦點時 Enter 也會觸發 click，避免重複
          this.roguelike.restart()
        }
        return
      }
      // 出招鍵：按著數字鍵盤 + = P2 出招，否則 P1；該玩家由 AI 操作時不理會
      const isAttackKey = this._isAttackKey(e.code)
      const slot = isAttackKey && this.keys.has(this.p2AttackKey) ? 'p2' : 'p1'
      if (!e.repeat && isAttackKey && !this.params[`${slot}AI`]) {
        const st = this.combat.input[slot]
        if (e.code === this.p1Keys.light) st.pendingAttack = 'light'
        if (e.code === this.p1Keys.medium) st.pendingAttack = 'medium'
        if (e.code === this.p1Keys.heavy) st.pendingAttack = 'heavy'
        if (e.code === this.p1Keys.rush) st.rushLife = this.rushInputFrames
        const superKey = this._getSlotMove(e.code) || this.p1Keys.debugSupers[e.code]
        if (superKey) st.pendingAttack = superKey
      }
      // 連按兩下方向鍵 = 衝刺：只有格鬥模式（自由模式用 Shift 快跑）
      if (!e.repeat && !this.freeMode.isActive) {
        this._detectDash('p1', e.code)
        this._detectDash('p2', e.code)
      }
      if (!e.repeat && e.code === 'Digit0') this._togglePause() // 主鍵盤 0（數字鍵盤 0 是衝刺取消）
      // Esc：立刻取消出拳 / 招式（格鬥模式全部重置；自由模式位置、面向保留），HP / DG / SG / WL 回到初始值
      if (!e.repeat && e.code === 'Escape') {
        this.freeMode.isActive ? this._cancelFreeMoves() : this.resetAll()
        this.combat.resetGauges()
      }
      // 介面 / 除錯 / AI / 遊戲速度快捷鍵；在 GUI 輸入框打字時不觸發
      if (!e.target.closest?.('input, textarea, select')) {
        if (!e.repeat && e.code === 'KeyP') this._setFrameMeterVisible(!this.params.showFrameMeter)
        if (!e.repeat && e.code === 'KeyO') this._setDebugVisible(!this.params.showDebug)
        if (!e.repeat && e.code === 'KeyX') this._setXrayVisible(!this.params.showXray)
        // 主鍵盤 1 ~ 0 留給除錯工具：1 = P1 AI、2 = P2 AI、0 = 暫停（數字鍵盤的數字是出招鍵，e.code 不同）
        if (!e.repeat && e.code === 'Digit1') this._toggleAI('p1')
        if (!e.repeat && e.code === 'Digit2') this._toggleAI('p2')
        if (!e.repeat && e.code === 'KeyC') this.freeMode.switchFollow()
        if (!e.repeat && e.code === 'KeyN' && !this.returning) this.freeMode.toggleFirstPerson()
        if (!e.repeat && e.code === 'Backslash') this._resetGui()
        if (!e.repeat && e.code === 'KeyB') this._setCameraCollision(!this.params.cameraCollision)
        if (!e.repeat && e.code === 'KeyH') this.startOrbitCamera()
        if (!e.repeat && e.code === 'KeyM' && !this.returning) this.toggleFreeMode()
        if (!e.repeat && e.code === 'KeyF') this._interact()
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
      if (e.code === 'AltLeft' || e.code === 'AltRight') e.preventDefault() // 不要讓瀏覽器把焦點移到選單列
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
    return [k.light, k.medium, k.heavy, k.rush, ...k.superSlots].includes(code) || !!k.debugSupers[code]
  }

  /** 絕招欄位鍵 → 那一格放的招式 key（空格 = null） */
  _getSlotMove(code) {
    const index = this.p1Keys.superSlots.indexOf(code)
    return index >= 0 ? this.roguelike.state.slots[index] || null : null
  }

  /** 幀數表 + 連段傷害顯示 / 收合（P、GUI「顯示幀數表」）；下方的操作說明 (?) 不受影響 */
  _setFrameMeterVisible(isVisible) {
    this.params.showFrameMeter = isVisible
    document.querySelectorAll('#frameMeter, #comboDebug').forEach(el => el.classList.toggle('is_uiHide', !isVisible))
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

  /** 除錯顯示（O、GUI「顯示除錯」）：X 軸刻度尺與座標、判定框、左右邊界牆一起 */
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
    this.hud.setAI(slot, this.params[`${slot}AI`]) // 血條旁的紅點閃爍 = AI 操作中
  }

  /** 遊戲速度加減（- / =），0 ~ 2 */
  _changeTimeScale(delta) {
    this.params.timeScale = Math.round(Math.min(2, Math.max(0, this.params.timeScale + delta)) * 100) / 100
    this.guiControllers?.timeScale.updateDisplay()
  }

  /** 操作說明裡的按鍵示意：按著的鍵亮起；絕招欄位寫上目前放的招式名稱，空格變暗（is_locked） */
  _updateKeycaps() {
    this.keycapEls.forEach(el => {
      el.classList.toggle('is_down', this.keys.has(el.dataset.key))
      if (!this.p1Keys.superSlots.includes(el.dataset.key)) return
      const move = this._getSlotMove(el.dataset.key)
      el.classList.toggle('is_locked', !move)
      const label = el.querySelector('small')
      const text = move ? this.p1?.moves[move]?.name || move : '空'
      if (label && label.textContent !== text) label.textContent = text
    })
  }

  /**
   * 死亡動畫播完：P2 → 暫停遊戲、出升級牌；P1 → 結算視窗
   * 選完牌（roguelike onPicked）→ 下一層：雙方回到開場位置；P2 血量與量條回滿，P1 保留目前狀態再補一點（stageReward）
   * 結算按「重新開始」→ 第 1 層：雙方血量與量條全部重置
   */
  _onKO(slot) {
    if (this.freeMode.isActive) return
    if (slot === 'p2') this.roguelike.open()
    else this.roguelike.gameOver() // P1 被打倒：結算（止步層數 + 評價），按「重新開始」從第 1 層重來
  }

  /** 選完牌：P1 保留血量 / 量條，再補 stageReward；P2（新的對手）回滿 */
  _startNextStage() {
    const { p1, p2 } = this.combat.gauges
    const { hpRate, dgBars, sgBars } = this.stageReward
    p1.hp = Math.min(p1.maxHp, p1.hp + p1.maxHp * hpRate)
    p1.addDg(p1.barSize * dgBars)
    p1.addSg(p1.barSize * sgBars)
    this._applyEnemyStage()
    p2.reset()
    this._resetStagePositions()
  }

  /** 重新開始（結算後）：雙方血量與量條全部重置 */
  _restartRun() {
    this._applyEnemyStage()
    this.combat.resetGauges()
    this._resetStagePositions()
  }

  /** 依目前層數設定敵人（P2）：HP 上限（每層 +enemyHpPerStage）、AI 難度（P2 開 AI 時才有作用） */
  _applyEnemyStage() {
    this.combat.gauges.p2.maxHp = this.roguelike.getEnemyMaxHp(this.enemyBaseHp)
    this._setP2AILevel(this.roguelike.getEnemyLevel())
  }

  /** P2 電腦難度（GUI「P2 電腦難度」也會呼叫）；到下一層時會照層數再設一次 */
  _setP2AILevel(level) {
    this.params.p2AILevel = level
    this.ai.p2.setLevel(level)
    this.guiControllers?.p2AILevel?.updateDisplay()
  }

  /** 換層 / 重新開始：中斷所有動作，雙方回到開場位置、面向對方 */
  _resetStagePositions() {
    this.resetAll()
    this.p1.x = -this.startGap / 2
    this.p2.x = this.startGap / 2
    this.p1.faceTo(this.p2, true)
    this.p2.faceTo(this.p1, true)
    // 畫面補間的上一幀 / 這一幀都換成新位置，不會從倒地的位置滑過來
    ;[this.p1, this.p2].forEach(f => { f.captureFrame(); f.captureFrame() })
    this._updateKeycaps()
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

    if (this.freeMode.isActive) this.toggleFreeMode(true) // 換人物：先離開自由模式（不播過渡）
    this._endHitCamera() // 換人物：命中鏡頭直接回到一般鏡頭
    this.orbiter.end()
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
      moveSet: config.moveSet, // 人物自己的招式表（moveSets.js extendMoveSet）；沒填用預設
      moveSpeed: this.params.moveSpeed,
      showDebug: this.params.showDebug,
      showSkeleton: this.params.showSkeleton,
    })
    this.params[slot] = name
    if (slot === 'p1') {
      this.footMarker.setTarget(this.p1)
      this.roguelike.applyFighter(this.p1) // 換人物後重新套用升級（解鎖的絕招、攻擊力…）
      this._updateKeycaps()
    }
    this.hud.setName(slot, name)
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

  /** 切換天空（skies 的名稱；見 engine/world/sky.js） */
  setSky(name) {
    if (!this.skies[name]) return
    this.params.sky = name
    this.sky.setSky(name)
    this.atmosphere?.apply() // 全景圖也跟著晝夜變暗
  }

  /** 目前的 3D 場景模型（Group；沒有 = null） */
  get envModel() {
    return this.environment?.model ?? null
  }

  /** 目前場景裡的物件（場景設定的 props，例如可以坐下的營火 SitSpot） */
  get props() {
    return this.environment?.props ?? []
  }

  /**
   * 切換 3D 場景（scenes 的名稱；載入見 engine/world/environment.js）
   * 擺放套用場景的 transform（GUI 可再調）、打鬥場地半寬換成場景的 halfWidth；模型換好後由 _onSceneModel 調整場地
   */
  setScene(name) {
    const entry = this.scenes[name]
    if (!entry) return
    this.params.scene = name
    const { x = 0, y = 0, z = 0, rotation = 0, scale = 1 } = entry.transform || {}
    Object.assign(this.params, { envOffsetX: x, envOffsetY: y, envOffsetZ: z, envRotation: rotation, envScale: scale })
    this.stageMaxHalfWidth = entry.halfWidth ?? this.defaultHalfWidth
    this.activeProp = null
    this.environment.setScene(name)
  }

  /**
   * 場景模型換好了：場地寬度（場景的牆）、自由模式的擋牆；地面自己會接影子，影子地板先藏起來（疊在一起會有兩層影子）
   * 沒有場景模型：影子地板照 GUI 設定
   */
  _onSceneModel(model) {
    if (this.stage) {
      this._applyStageWidth()
      this.stage.setGroundVisible(!model && this.params.showGround)
    }
    if (this.freeMode?.isActive) this.freeMode.setEnv(model)
  }

  /**
   * 物件每個畫面更新：營火的動畫一直播；自由模式中 P1 靠近（或坐著）時發亮、顯示 F 提示
   * @param {number} delta 遊戲時間（秒）
   */
  _updateProps(delta) {
    const fm = this.freeMode
    const isBusy = fm.isActive && (fm.isSitting('p1') || fm.isHiding('p1'))
    if (!isBusy) this.activeProp = null // 被打中等原因中斷了
    // 靠近的物件只亮最近的那一個（營火和櫃子靠在一起時不會兩個都亮）
    const near = isBusy ? null : this._getNearProp()
    this.props.forEach(prop => {
      const isUsing = prop === this.activeProp
      const isActive = fm.isActive && !this.returning && !this.params.p1AI && (isUsing || prop === near)
      prop.update(delta, { isActive, label: prop.getLabel(isUsing), camera: this.camera })
    })
  }

  /** P1 互動距離內、最近的物件 */
  _getNearProp() {
    const pos = this.p1?.model.position
    if (!pos) return null
    return this.props
      .filter(prop => prop.isNear(this.p1))
      .sort((a, b) => a.worldPosition.distanceTo(pos) - b.worldPosition.distanceTo(pos))[0] ?? null
  }

  /** F：自由模式中，靠近營火坐下 / 起身，靠近櫃子躲進去 / 出來 */
  _interact() {
    const fm = this.freeMode
    if (!fm.isActive || this.params.p1AI) return
    if (fm.isSitting('p1')) {
      fm.standUp('p1')
      return
    }
    if (fm.isHiding('p1')) {
      fm.leaveHide('p1')
      return
    }
    const prop = this._getNearProp()
    if (!prop) return
    const isStarted = prop.kind === 'hide' ? fm.hideIn('p1', prop) : fm.sitDown('p1', prop.worldPosition)
    if (isStarted) this.activeProp = prop
  }

  /** 實心的物件（櫃子）交給自由模式的地形當碰撞物件 */
  _syncPropColliders() {
    this.freeMode?.terrain.setColliders(this.props.filter(prop => prop.kind === 'hide').map(prop => prop.group))
  }

  /** 黑暗霧的設定（GUI）：開關、距離、顏色、天空變暗 */
  _applyDarkFog() {
    const { darkFog, darkFogNear, darkFogFar, darkFogSky, darkFogColor } = this.params
    this.sky.setDarkFog({ enabled: darkFog, near: darkFogNear, far: Math.max(darkFogNear + 0.1, darkFogFar), skyDarken: darkFogSky, color: darkFogColor })
  }

  /** 黑暗霧的中心：鏡頭，或人物胸口（自由模式 = 鏡頭跟隨的人，格鬥模式 = P1） */
  _updateDarkFogCenter() {
    if (!this.params.darkFog) return
    const fighter = this.freeMode.isActive ? this[this.freeMode.followSlot] : this.p1
    if (this.params.darkFogCenter === '人物' && fighter) {
      this.sky.setFogCenter(fighter.model.position.clone().setY(fighter.model.position.y + 1))
      return
    }
    this.sky.setFogCenter(this.camera.position)
  }

  /**
   * 人物的霧：主要視角的人物（自由模式 = 鏡頭跟隨的人，格鬥模式 = P1）一直看得見，其他人物跟場景一樣被霧蓋住（黑暗霧時遠了就看不到）
   * 只在主要視角換人、或換了人物時才真的切換（Fighter.setFogged 會略過沒變的）
   */
  _updateFighterFog() {
    const main = this.freeMode.isActive ? this[this.freeMode.followSlot] : this.p1
    ;[this.p1, this.p2].filter(Boolean).forEach(f => f.setFogged(f !== main, material => this.sky.patchMaterial(material)))
  }

  /**
   * \ 鍵：GUI 所有設定回到一開始的值；只重置跟預設值不同的設定（onChange 照常觸發，例如場景、天氣跟著換回來）
   * 沒變的不動：lil-gui 的 reset 就算值一樣也會觸發 onChange（例如角色會整個重新建立）
   * 按鈕類（例如「打一次閃電」）不會被觸發
   */
  _resetGui() {
    this.gui?.controllersRecursive().forEach(c => {
      const value = c.getValue()
      if (typeof value === 'function' || value === c.initialValue) return
      c.reset()
    })
  }

  /** 天空水平轉動 */
  _applySkyRotation() {
    this.sky.setRotation(this.params.skyRotation)
  }

  /** 3D 場景模型的水平轉動（繞場地中心）、位移與大小（GUI） */
  _applyEnvTransform() {
    const { envRotation, envOffsetX, envOffsetY, envOffsetZ, envScale } = this.params
    this.environment.setTransform({ rotation: envRotation, x: envOffsetX, y: envOffsetY, z: envOffsetZ, scale: envScale })
  }

  /**
   * 打鬥場地寬度（邊界 x = ±stageHalfWidth）：邊界牆、刻度尺、影子範圍一起更新；人物超出的話下一幀被推回邊界內
   * 寬度 = GUI 設定的半寬，開啟「場景牆壁當邊界」時取它和場景牆壁距離較小的那個
   */
  _applyStageWidth() {
    this.stageHalfWidth = Math.min(this.stageMaxHalfWidth, this._getSceneWallDistance())
    this.stage.setHalfWidth(this.stageHalfWidth)
    if (this.freeMode) this.freeMode.bounds = this.stageHalfWidth // 沒有場景時，自由模式限制在這個方框內
    const cam = this.core.lights.dirLight.shadow.camera
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
    if (!this.params.sceneWalls) return Infinity
    return this.environment.getWallDistance({ heights: this.sceneWallHeights, maxDistance: this.stageMaxHalfWidth })
  }

  /**
   * 場地霧：amount 0 = 平常的地平線霧（關掉時推到很遠）、1 = 絕招演出的霧（superCamera 的 fogColor、fogNear ~ fogFar）
   * 中間的顏色與距離線性漸變
   */
  _applySuperFog(amount) {
    this.superFogAmount = amount
    if (!this.sky) return
    const { horizonFog, fogNear, fogFar } = this.params
    const sc = this.superCamera
    this.sky.setHorizonFog({ enabled: horizonFog, near: fogNear, far: fogFar })
    this.sky.setFogBlend(amount, { color: sc.fogColor, near: sc.fogNear, far: sc.fogFar })
  }

  /**
   * 場地亮度 = 絕招演出的變暗；環境光、主光、天空一起調整
   * 絕招聚光燈不受影響，演出時只有放絕招的人被照亮
   */
  _applyStageLight() {
    this.core?.setDim(1 + (this.superCamera.dimLevel - 1) * this.superDim)
  }

  // internal

  _setupScene() {
    // 遊戲核心（engine/core/gameCore.js）：渲染器、場景、鏡頭、天空、場景模型、時間天氣、燈光、鏡頭工具、遊戲迴圈
    // 換關卡時這一層一直存在；這裡只接上格鬥遊戲的 hooks
    const { skyRotation, cloudCover, horizonFog, fogNear, fogFar } = this.params
    this.core = new GameCore({
      el: this.stageEl,
      skies: this.skies,
      skyOptions: { rotation: skyRotation, cloudCover, horizonFog: { enabled: horizonFog, near: fogNear, far: fogFar } },
      scenes: this.scenes,
      lights: { shadowHalfWidth: this.stageHalfWidth + 2 }, // 陰影範圍涵蓋整個場地寬度
      cameraShake: { duration: this.cameraShake.frames / FPS, frequency: this.cameraShake.frequency },
      hooks: {
        onUpdate: realDelta => this._update(realDelta),
        onBeforeRender: realDelta => this._beforeRender(realDelta),
        onAfterRender: () => this._afterRender(),
        getGameDelta: realDelta => (this.params.paused ? 0 : realDelta * this.params.timeScale),
        isCameraLocked: () => this._isCameraLocked(),
        isFisheye: () => this.freeMode?.isActive && this.freeMode.isFirstPerson, // 第一人稱的輕微魚眼
        skipCameraCollision: () => !!this.freeMode?.isFirstPerson, // 第一人稱鏡頭在眼睛，不用避開
        onSceneModel: model => this._onSceneModel(model),
        onPropsChange: () => this._syncPropColliders(),
        onLoadStart: name => !this.isLoading && this._showLoading(true, name),
        onProgress: (e, name) => this._onProgress(e, name),
        onLoadEnd: () => !this.isLoading && this._showLoading(false),
      },
    })
    // 原本的名稱照用（main.js 其他地方不用改）
    const core = this.core
    Object.assign(this, {
      renderer: core.renderer,
      scene: core.scene,
      camera: core.camera,
      controls: core.controls,
      fisheye: core.fisheye,
      sky: core.sky,
      environment: core.environment,
      atmosphere: core.atmosphere,
      cameraShaker: core.cameraShaker,
      cameraCollision: core.cameraCollision,
      cameraDrag: core.cameraDrag,
    })
    this.cameraCollision.setEnabled(this.params.cameraCollision)
    this.setSky(this.params.sky)
    this.setScene(this.params.scene)
    this.defaultCamera = { pos: this.camera.position.clone(), target: this.controls.target.clone() } // 格鬥模式的預設鏡頭（離開自由模式時回到這裡）

    // 環繞鏡頭（H）、自由模式的滑鼠視角：注視點、按鍵都跟格鬥玩法有關，留在這裡
    const canvas = this.renderer.domElement
    this.orbiter = new OrbitCamera({
      camera: this.camera,
      controls: this.controls,
      ...this.orbitCamera,
      // 注視點：格鬥模式跟著兩人中點，自由模式跟著鏡頭跟隨的人
      getCenter: target => {
        const fm = this.freeMode
        if (fm?.isActive) {
          const f = this[fm.followSlot]
          return f ? f.model.position.clone().setY(fm.cameraGroundY + fm.followHeight) : target
        }
        if (this.p1 && this.p2) target.x = (this.p1.x + this.p2.x) / 2
        return target
      },
      onEnd: () => { this.controls.enabled = !this._isCinematicCamera() },
    })
    // 自由模式：滑鼠中鍵 = 鎖定對手（再按一次解除）；鎖定對手中按任何滑鼠鍵 = 回到一般鏡頭
    this.pointerLook = new PointerLook({
      canvas,
      controls: this.controls,
      onLook: (dx, dy) => this.freeMode.addLook(dx, dy),
      onButton: button => (button === 1 ? this.freeMode.toggleLockOn() : this.freeMode.setLockOn(false)),
      isBlocked: () => !!this.returning,
    })
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
        onKO: slot => this._onKO(slot),
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
      isCameraHeld: () => this.orbiter.isActive, // 環繞鏡頭（H）中：自由模式不動鏡頭
    })
    this._syncPropColliders() // 場景的物件比自由模式先建好：補交碰撞物件
    this.hud = new Hud({ camera: this.camera, canvas: this.renderer.domElement, showCoords: this.params.showDebug })
    this.enemyBaseHp = this.combat.gauges.p2.maxHp // 第 1 層敵人的 HP 上限（之後每層加 roguelike enemyHpPerStage）
    this._applyEnemyStage() // 第 1 層：簡單
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

    if (config.brightness) brightenScene(character.scene, config.brightness)
    if (config.smile) addSmileMorph(character.scene, config.smile)

    const clips = {}
    // 有 alignHipsAnims 的動作最後才處理：要先知道對齊目標（例如 fly）固定後的臀部位置
    const order = [...keys.keys()].sort((a, b) => Number(keys[a] in this.alignHipsAnims) - Number(keys[b] in this.alignHipsAnims))
    order.forEach(i => {
      const key = keys[i]
      let clip = this.mixamo.bindAnimation(character, anims[i], key)
      const trim = this.trimAnims[key]
      if (trim) clip = trimClip(clip, trim.start ?? 0, trim.end ?? 0, FPS)
      const speed = this.speedAnims[key]
      if (speed) clip = speedUpClip(clip, speed.to, speed.rate, FPS)
      clips[key] = makeInPlace(clip, {
        isRootMotion: this.rootMotionAnims.includes(key),
        isFlattenRise: this.flattenRiseAnims.includes(key),
        isAxisX: this.rootMotionAxisX.includes(key),
        isCenterHips: this.centerHipsAnims.includes(key),
        pinTo: getHipsPin(clips[this.alignHipsAnims[key]]),
      })
    })
    return { scene: character.scene, clips }
  }

  _setupGui() {
    const gui = new GUI({ title: 'Fighter 控制台' })
    this.gui = gui // \ 鍵重置所有設定（_resetGui）
    const names = this.characters.map(c => c.name)
    const fighters = () => [this.p1, this.p2].filter(Boolean)

    gui.add(this.params, 'p1', names).name('P1 角色').listen().onChange(v => this.setCharacter('p1', v))
    gui.add(this.params, 'p2', names).name('P2 角色').listen().onChange(v => this.setCharacter('p2', v))
    gui.add(this.params, 'p2Guard').name('P2 木樁防禦')
    this.guiControllers = {} // 快捷鍵改了數值時要更新顯示的控制項
    // P2 電腦難度：只改這一層；進下一層時照層數重新設定（1~3 簡單、4~6 中等、7~9 困難、10~ 極難）
    const levelOptions = Object.fromEntries(Object.entries(AI_LEVELS).map(([key, { name }]) => [name, key]))
    this.guiControllers.p2AILevel = gui.add(this.params, 'p2AILevel', levelOptions).name('P2 電腦難度').onChange(v => this._setP2AILevel(v))

    this._setupGaugeGui(gui)

    const skyFolder = gui.addFolder('背景（天空盒）').close() // 預設收起
    skyFolder.add(this.params, 'sky', Object.keys(this.skies)).name('天空').listen().onChange(v => this.setSky(v))
    skyFolder.add(this.params, 'skyRotation', 0, 360, 1).name('轉動（度）').onChange(() => this._applySkyRotation())
    skyFolder.add(this.params, 'cloudCover', 0, 1, 0.05).name('雲量（動態天空）').onChange(v => {
      this.atmosphere.cloudCover = v // 晴天的雲量（陰天、雨天會蓋滿）
      this.atmosphere.apply()
    })
    skyFolder.add(this.params, 'horizonFog').name('地平線霧').onChange(() => this._applySuperFog(this.superFogAmount))
    skyFolder.add(this.params, 'fogNear', 0, 60, 1).name('霧開始（m）').onChange(() => this._applySuperFog(this.superFogAmount))
    skyFolder.add(this.params, 'fogFar', 10, 100, 1).name('霧最濃（m）').onChange(() => this._applySuperFog(this.superFogAmount))
    // 時間與天氣：時間 0 ~ 24 點（可以讓它自己流動）、天氣切換時平滑過渡
    const atmo = this.atmosphere
    const timeFolder = gui.addFolder('天氣與時間')
    timeFolder.add(atmo, 'time', 0, 24, 0.1).name('時間（點）').listen().onChange(v => atmo.setTime(v))
    timeFolder.add(atmo, 'isRunning').name('時間流動')
    timeFolder.add(atmo, 'speed', 0, 240, 1).name('流速（分鐘 / 秒）')
    timeFolder.add(atmo, 'weather', Object.keys(WEATHERS)).name('天氣').onChange(v => atmo.setWeather(v))
    timeFolder.add(atmo, 'transition', 0, 10, 0.5).name('天氣過渡（秒）')
    timeFolder.add(atmo.lightning, 'enabled').name('閃電（雨天）')
    timeFolder.add(atmo, 'triggerLightning').name('打一次閃電')
    // 黑暗霧：離中心點越遠越暗，最後看不到
    const darkFolder = gui.addFolder('黑暗霧')
    const applyDark = () => this._applyDarkFog()
    darkFolder.add(this.params, 'darkFog').name('開啟').onChange(applyDark)
    darkFolder.add(this.params, 'darkFogCenter', ['鏡頭', '人物']).name('中心')
    darkFolder.add(this.params, 'darkFogNear', 0, 40, 0.5).name('開始變暗（m）').onChange(applyDark)
    darkFolder.add(this.params, 'darkFogFar', 1, 80, 0.5).name('全暗（m）').onChange(applyDark)
    darkFolder.add(this.params, 'darkFogSky', 0, 1, 0.05).name('天空變暗').onChange(applyDark)
    darkFolder.addColor(this.params, 'darkFogColor').name('顏色').onChange(applyDark)

    const sceneFolder = gui.addFolder('場景（3D 模組）').close()
    sceneFolder.add(this.params, 'scene', Object.keys(this.scenes)).name('3D 場景').listen().onChange(v => this.setScene(v))
    sceneFolder.add(this.params, 'envRotation', 0, 360, 1).name('轉動（度）').listen().onChange(() => this._applyEnvTransform()).onFinishChange(() => this._applyStageWidth())
    sceneFolder.add(this.params, 'envOffsetX', -20, 20, 0.1).name('左右 X（m）').listen().onChange(() => this._applyEnvTransform()).onFinishChange(() => this._applyStageWidth())
    sceneFolder.add(this.params, 'envOffsetY', -0.5, 0.5, 0.01).name('高度 Y（m）').listen().onChange(() => this._applyEnvTransform()).onFinishChange(() => this._applyStageWidth())
    sceneFolder.add(this.params, 'envOffsetZ', -20, 20, 0.1).name('前後 Z（m）').listen().onChange(() => this._applyEnvTransform()).onFinishChange(() => this._applyStageWidth())
    sceneFolder.add(this.params, 'envScale', 0.2, 3, 0.05).name('大小').listen().onChange(() => this._applyEnvTransform()).onFinishChange(() => this._applyStageWidth())
    sceneFolder.add(this, 'stageMaxHalfWidth', 2, 15, 0.5).name('打鬥場地半寬（m）').listen().onChange(() => this._applyStageWidth())
    sceneFolder.add(this.params, 'sceneWalls').name('場景牆壁當邊界').onChange(() => this._applyStageWidth())
    sceneFolder.add(this.params, 'showGround').name('顯示影子地板').onChange(v => this.stage.setGroundVisible(v && !this.envModel))

    sceneFolder.add(this.superCamera, 'dimLevel', 0, 1, 0.05).name('絕招時變暗到')

    const playFolder = gui.addFolder('播放設定')
    this.guiControllers.timeScale = playFolder.add(this.params, 'timeScale', 0, 2, 0.05).name('遊戲速度（- / =）')
    this.pauseController = playFolder.add(this.params, 'paused').name('暫停（主鍵盤 0）')

    const viewFolder = gui.addFolder('顯示')
    this.guiControllers.showFrameMeter = viewFolder.add(this.params, 'showFrameMeter').name('顯示幀數表 + 連段傷害（P）').onChange(v => this._setFrameMeterVisible(v))
    viewFolder.add(this.params, 'showCombo').name('顯示連段數').onChange(v => this._setComboVisible(v))
    this.guiControllers.showXray = viewFolder.add(this.params, 'showXray').name('被擋住時透視角色（X）')
    this.guiControllers.cameraCollision = viewFolder.add(this.params, 'cameraCollision').name('鏡頭避開物體（B）').onChange(v => this._setCameraCollision(v))
    this.guiControllers.showDebug = viewFolder.add(this.params, 'showDebug').name('顯示除錯：座標、判定框、邊界牆（O）').onChange(v => this._setDebugVisible(v))
    const fisheyeFolder = viewFolder.addFolder('第一人稱魚眼').close()
    fisheyeFolder.add(this.fisheye, 'fov', 45, 140, 1).name('視角（度）').onChange(() => this.fisheye.refresh())
    fisheyeFolder.add(this.fisheye, 'strength', 0, 0.6, 0.01).name('扭曲強度')
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
    addGauge(baseFolder, 'startDgBars', 'DG 初始格數', 0, p1.dgMaxBars, 1)
    addGauge(baseFolder, 'startSgBars', 'SG 初始格數', 0, p1.maxBars, 1)
    baseFolder.add({ reset: () => this.combat.resetGauges() }, 'reset').name('重置血量與量條')

    const regenFolder = folder.addFolder('回復 / 消耗（每 60 幀)')
    addGauge(regenFolder, 'dgRegen', 'DG 回復', 0, 12000, 100)
    addGauge(regenFolder, 'sgRegen', 'SG 回復', 0, 3000, 50)
    addGauge(regenFolder, 'wlDecay', 'WL 移除', 0, 2000, 50)
    addGauge(regenFolder, 'rushBars', '衝刺取消消耗 DG 格數', 0, p1.dgMaxBars, 1)
    addGauge(regenFolder, 'emptyRushWL', 'WL 增加: 取消溢出', 0, 5000, 100)
    addGauge(regenFolder, 'overflowPerWL', 'WL 增加: 防禦溢出', 1, 100, 1)
    addGauge(regenFolder, 'dgEmptyDelay', 'DG溢出後，回復CD', 0, 600, 10)
    addGauge(regenFolder, 'blockDgDelay', '防禦成功後，DG 回復CD', 0, 300, 5)
    addGauge(regenFolder, 'rushDgDelay', '衝刺取消後，DG 回復CD', 0, 300, 5)

    // 招式傷害：擊中時敵血量減少（空中重攻擊跟著重拳）
    const damageFolder = folder.addFolder('招式傷害')
    const damageNames = { light: '輕拳', medium: '中拳', heavy: '重拳（含空中重攻擊）' }
    Object.entries(damageNames).forEach(([key, name]) => damageFolder.add(rules.damage, key, 0, 3000, 10).name(name))
    damageFolder.add(rules, 'superDamage', 0, 3000, 50).name('SA 默認每擊傷害')

    // 連段補正：這招打中後，同一連段下一擊的傷害倍率（累乘），最低 minScaling
    const scalingFolder = folder.addFolder('連段補正')
    Object.entries(damageNames).forEach(([key, name]) => scalingFolder.add(rules.scaling, key, 0, 1, 0.05).name(name))
    scalingFolder.add(rules, 'rushScaling', 0, 1, 0.05).name('衝刺取消')
    scalingFolder.add(rules, 'minScaling', 0, 1, 0.05).name('最低補正')
    scalingFolder.add(rules, 'superMinScaling', 0, 1, 0.05).name('SA 最低補正')
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
    this.freeMode.faceAttacker(attacker, target) // 自由模式：鏡頭跟隨的人被攻擊（含被防禦）→ 鏡頭平滑轉向攻擊方
    if (isBlock) return
    this.cameraShaker.start(this._getCameraShake(attacker))
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
    this.orbiter.end() // 環繞中打中：先回到一般鏡頭，命中鏡頭才記得到正確的一般鏡頭
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
    return !!(this._isCinematicCamera() || this.hitCam || this.orbiter.isActive || this.returning)
  }

  /** 絕招演出控制鏡頭中（演出中按 H 環繞後，演出就不再控制鏡頭，只管燈光與凍結） */
  _isCinematicCamera() {
    return !!this.cinematic && !this.cinematic.isCameraFree
  }

  /** 透視剪影只開給鏡頭跟隨的人：自由模式 = 跟隨的人（C 切換），格鬥模式 = P1 */
  _updateXray() {
    if (!this.p1 || !this.p2) return
    const target = this.params.showXray ? (this.freeMode.isActive ? this[this.freeMode.followSlot] : this.p1) : null
    ;[this.p1, this.p2].forEach(f => f.setXray(f === target))
  }

  /** 鏡頭避開物體開關（B、GUI） */
  _setCameraCollision(isOn) {
    this.params.cameraCollision = isOn
    this.cameraCollision.setEnabled(isOn)
    this.guiControllers?.cameraCollision.updateDisplay()
  }

  /**
   * 自由模式切換（M）：進入時中斷招式與演出，人物在場景裡自由走動（見 freeMode.js），鏡頭平滑轉成俯角看 P1
   * 離開時兩人飛回開場的格鬥位置（x = ±startGap / 2、面向對方），鏡頭移回格鬥模式的預設位置（見 _startFightReturn）
   * @param {boolean} isInstant 直接切回格鬥模式、不播過渡（換人物時）
   */
  toggleFreeMode(isInstant = false) {
    if (!this.p1 || !this.p2) return
    const fm = this.freeMode
    if (!fm.isActive) {
      this.resetAll()
      this.combat.space = fm.space
      fm.enter({ p1: this.p1, p2: this.p2 }, this.envModel)
      this._setMouseLook(true)
      this._setHelpMode(true)
      return
    }
    if (isInstant) this._finishFightReturn()
    else this._startFightReturn()
  }

  /**
   * 自由 → 格鬥模式的過渡開始：先取消所有動作，記下兩人與鏡頭現在的位置、開場位置
   * 過渡期間（_updateFightReturn）遊戲不推進，兩人播跳躍的滯空姿勢沿弧線飛回去、轉向對方，鏡頭同時移回預設位置
   */
  _startFightReturn() {
    this._cancelFreeMoves()
    if (this.freeMode.isFirstPerson) this.freeMode.toggleFirstPerson() // 先回到第三人稱（模型顯示），再飛回去
    this._setMouseLook(false)
    const half = this.startGap / 2
    const toRot = { p1: Math.PI / 2, p2: -Math.PI / 2 } // 開場 P1 在左面向右、P2 在右面向左
    const items = [['p1', -half], ['p2', half]].map(([slot, x]) => {
      const fighter = this[slot]
      fighter.playLoop('jump') // 跳躍動畫的時間由這裡控制（timeScale 0）
      return { fighter, from: fighter.model.position.clone(), to: new THREE.Vector3(x, 0, 0), fromRot: fighter.model.rotation.y, toRot: toRot[slot] }
    })
    this.returning = {
      time: 0,
      duration: this.freeMode.enterTime,
      items,
      camFrom: { pos: this.camera.position.clone(), target: this.controls.target.clone() },
      camTo: { pos: this.defaultCamera.pos.clone(), target: this.defaultCamera.target.clone() },
    }
  }

  /** 過渡每個畫面：位置沿弧線、方向轉最短角度、鏡頭位置與注視點一起內插；跑完才真的切回格鬥模式 */
  _updateFightReturn(realDelta) {
    const r = this.returning
    r.time = Math.min(r.duration, r.time + realDelta)
    const t = r.time / r.duration
    const k = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2 // 先加速再減速
    const { animTakeoff, animLand, animFps } = this.p1.jump
    r.items.forEach(({ fighter, from, to, fromRot, toRot }) => {
      const pos = fighter.model.position.lerpVectors(from, to, k)
      pos.y += Math.sin(Math.PI * k) * this.fightReturn.arcHeight
      const diff = Math.atan2(Math.sin(toRot - fromRot), Math.cos(toRot - fromRot))
      fighter.model.rotation.y = fromRot + diff * k
      // 跳躍動畫：起跳 → 落地之間跟著進度播
      const action = fighter.actions.jump
      if (action) action.time = (animTakeoff + (animLand - animTakeoff) * k) / animFps
      fighter.mixer.update(0)
      fighter.model.updateMatrixWorld(true)
      fighter.updateBoxes() // 推擠框跟著（腳底橢圓、除錯顯示）
    })
    this.camera.position.lerpVectors(r.camFrom.pos, r.camTo.pos, k)
    this.controls.target.lerpVectors(r.camFrom.target, r.camTo.target, k)
    this.camera.lookAt(this.controls.target)
    if (t >= 1) this._finishFightReturn()
  }

  /** 真的切回格鬥模式：兩人站回開場位置、面向對方，鏡頭回到預設位置 */
  _finishFightReturn() {
    this.returning = null
    this.freeMode.exit()
    this._setMouseLook(false)
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

  /** 自由模式的滑鼠操作：打開時鎖定滑鼠（游標隱藏），移動滑鼠轉鏡頭（engine/input/pointerLook.js）；關閉時還原 */
  _setMouseLook(isOn) {
    this.pointerLook.setEnabled(isOn)
    if (!isOn) this.controls.enableZoom = true // 第一人稱時關掉的縮放還原
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
    this.cameraShaker.stop()
  }

  /** 拉近後的鏡頭距離：目前距離 × zoomRate，但不比 superCamera.distance 更近（也不比目前更遠） */
  _getZoomDistance(currentDistance) {
    const { distance, zoomRate } = this.superCamera
    return Math.min(currentDistance, Math.max(distance, currentDistance * zoomRate))
  }

  /**
   * 環繞鏡頭開始（H）：環繞中不理會；自由模式繞著鏡頭跟隨的人（第三人稱才可以），環繞中滑鼠不轉鏡頭
   * 絕招演出、命中鏡頭中也可以按：解除它們的鏡頭鎖定，繞的是它們開始前的一般鏡頭；演出本身（燈光、凍結）照常
   * 從目前畫面的鏡頭（含滑鼠拖曳的角度）開始，前 pullTime 秒過渡到環繞的路線，不會跳一下
   */
  startOrbitCamera() {
    // 自由模式：第一人稱、切換第一 / 第三人稱途中不能環繞
    const fm = this.freeMode
    if (!this.p1 || !this.p2 || this.orbiter.isActive || this.returning) return
    if (fm.isActive && (fm.isFirstPerson || fm.fpBlend)) return
    const c = this.cinematic
    const h = this.hitCam
    let base
    if (h) base = { target: h.base.target.clone(), offset: h.base.offset.clone() }
    else if (c) base = { target: c.fromTarget.clone(), offset: c.fromOffset.clone() }
    else base = { target: this.controls.target.clone(), offset: this.camera.position.clone().sub(this.controls.target) }
    if (c) c.isCameraFree = true
    this.hitCam = null

    // 起點 = 畫面上看到的鏡頭：拖曳角度併進來後歸零
    const from = { pos: this.cameraDrag.takeRotatedPosition(), target: this.controls.target.clone() }
    this.orbiter.start(base, from)
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
    this.orbiter.end() // 環繞中放絕招：先回到一般鏡頭，演出結束才回得去
    fighter.snapToCurrentAction() // 演出停頓期間顯示絕招的第 1 幀（不從之前的動作淡入）
    // 畫面補間的「上一幀」也記成絕招第 1 幀：之後 _update 會再記一次，前後兩幀都是絕招第 1 幀
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
    this.orbiter.end()
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
    this.cameraShaker.stop()
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

  /**
   * 絕招從按下到出攻擊判定，對手實際經過幾幀（AI 算能不能抓破綻 / 搶在對手出判定前用）
   * 演出凍結（zoomIn + hold）期間對手不動：凍結中絕招推進的幀不算；animStart 在凍結之後則要多等
   * = 第一次攻擊判定的 stateFrame（含 firstPassDelay）- 凍結幀數 + animStart
   */
  _getSuperStartup(fighter, key) {
    const move = fighter.moves[key]
    if (!move) return Infinity
    const { zoomIn, hold } = this.superCamera
    const firstActive = fighter.getFirstActiveFrame(move) - 1 + (move.firstPassDelay ?? 0)
    return Math.max(0, firstActive - (zoomIn + hold) + this._getSuperAnimStart(move))
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

  /**
   * 每個畫面的遊戲更新（GameCore hooks.onUpdate）：絕招演出、格鬥 / 自由模式的邏輯、角色補間、鏡頭跟隨
   * 之後 GameCore 會更新 OrbitControls（鏡頭沒被鎖住時）、天空、時間天氣
   */
  _update(realDelta) {
    if (this.cinematic) this._updateCinematic(realDelta)

    const fighters = this.p1 && this.p2 ? [this.p1, this.p2] : []
    const gameDelta = this.params.paused ? 0 : realDelta * this.params.timeScale
    // 自由模式：不跑格鬥邏輯與畫面補間，人物由 FreeMode 直接移動
    const isFree = this.freeMode.isActive
    this.isFreeFrame = isFree // 渲染後還原姿勢時要知道這個畫面是哪種模式（_afterRender）
    if (fighters.length && this.returning) {
      this._updateFightReturn(realDelta) // 自由 → 格鬥模式的過渡：遊戲不推進
      this.footMarker.update()
    } else if (fighters.length && isFree) {
      this.freeMode.update(gameDelta, this.keys, { p1: this.params.p1AI, p2: this.params.p2AI }, realDelta)
      if (this.orbiter.isActive) this.orbiter.update(realDelta) // 環繞鏡頭（H）：繞著鏡頭跟隨的人
      this.freeMode.applyInterpolation(this.params.paused)
      this.hitEffect.update(gameDelta)
      this.footMarker.update() // 推擠框跟著人物走，腳底橢圓也跟著
      this.hud.updateCoords(fighters) // 除錯顯示的座標（含 z）
    } else if (fighters.length) {
      const step = 1 / FPS
      // 選升級牌、結算視窗中：遊戲停住
      if (!this._isFrozen() && !this.roguelike.isMenuOpen) {
        this.accumulator += gameDelta
        // 絕招演出開始後剩下的時間不再補幀
        while (this.accumulator >= step && !this._isFrozen()) {
          this.accumulator -= step
          this.combat.step({ p1: this._getRawInput('p1'), p2: this._getRawInput('p2') })
          fighters.forEach(f => f.captureFrame())
        }
        if (this._isFrozen()) this.accumulator = 0
      }

      // 畫面補間：在上一幀與這一幀之間內插（凍結 / 暫停時直接顯示這一幀）
      const alpha = this._isFrozen() || this.params.paused || this.roguelike.isMenuOpen ? 1 : this.accumulator / step
      fighters.forEach(f => f.applyInterpolation(alpha))
      this._updateShake(gameDelta)
      this.hitEffect.update(gameDelta)

      // 演出中由 _updateCinematic 控制鏡頭、命中鏡頭中由 _updateHitCamera 控制、環繞中由 orbiter 控制
      if (this.hitCam) this._updateHitCamera(realDelta)
      else if (this.orbiter.isActive) this.orbiter.update(realDelta)
      else if (!this._isCinematicCamera()) this._followCamera(realDelta)
      this.hud.updateCoords(fighters)
      // 人物位置更新完才對齊腳底橢圓
      this.footMarker.update()
    }
  }

  /** 渲染前（GameCore hooks.onBeforeRender）：HUD、霧的中心、人物的霧、互動物件、透視剪影 */
  _beforeRender(realDelta) {
    const gameDelta = this.params.paused ? 0 : realDelta * this.params.timeScale
    this.hud.update(realDelta)
    this.hud.updateGauges(this.combat.gauges)
    this.hud.updateComboDebug(this.combat.comboStats)
    this._updateDarkFogCenter()
    this._updateFighterFog()
    this._updateProps(gameDelta)
    this._updateXray()
    this._updateWeatherSound()
  }

  /**
   * 天氣聲：雨聲的音量 = 雨量（雨量依天氣過渡慢慢變，所以開始下雨漸大聲、雨停漸小聲）
   * 只在音量變了一點以上才更新（Sound.setLoop 每次會重新開始淡入淡出）
   */
  _updateWeatherSound() {
    const level = this.atmosphere.rainAmount
    const last = this.rainSoundLevel ?? 0
    if (Math.abs(level - last) < 0.02 && !(level === 0 && last !== 0)) return
    this.rainSoundLevel = level
    this.sound.setLoop('raining', level, this.weatherSoundFade)
  }

  /** 渲染後（GameCore hooks.onAfterRender）：還原成邏輯幀的姿勢，下一次推進從正確的狀態繼續 */
  _afterRender() {
    if (this.isFreeFrame) this.freeMode.restoreFrames()
    else [this.p1, this.p2].filter(Boolean).forEach(f => f.restoreFrame())
  }
}

// 掛到 window 方便在 DevTools console 裡直接查看，例如 viewer.p1、viewer.p2
window.viewer = new FighterViewer()
