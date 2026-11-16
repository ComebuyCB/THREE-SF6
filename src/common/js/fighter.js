import * as THREE from 'three'
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js'
import { OBB } from 'three/addons/math/OBB.js'

// 遊戲邏輯固定 60 幀 / 秒，幀數表與招式數據都以此為單位
export const FPS = 60
const STEP = 1 / FPS

// three.js 載入後骨頭名稱的冒號會被移除：mixamorig:Head → mixamorigHead
const BONE_PREFIX = 'mixamorig'

// 受擊判定框：把幾根骨頭的世界座標包成一個方框，再往外擴 pad（公尺）
// zPad：z 軸額外加寬。畫面只看得到 x、y，但判定是 3D 的，手打在人物前後一點點時會揮空
const HURTBOX_PARTS = [
  { name: 'head', bones: ['Head', 'HeadTop_End'], pad: 0.1, zPad: 0.3 },
  { name: 'body', bones: ['Hips', 'Spine1', 'Spine2', 'Neck', 'LeftArm', 'RightArm'], pad: 0.08, zPad: 0.3 },
  { name: 'legs', bones: ['LeftUpLeg', 'LeftLeg', 'LeftFoot', 'RightUpLeg', 'RightLeg', 'RightFoot'], pad: 0.06 },
]

const COLOR = {
  hurtbox: 0x44ff88,
  hitbox: 0xff3344,
  pushbox: 0xffcc33,
}

/** hits 的一段 → [開始, 結束]（幀數表編號，含結束幀）：數字 = 從該幀起 hitFrames 幀，陣列 = 直接指定 */
function hitRange(hit, hitFrames = 1) {
  return Array.isArray(hit) ? hit : [hit, hit + hitFrames - 1]
}

// 畫面補間用的暫存四元數
const _qPrev = new THREE.Quaternion()
const _qCurr = new THREE.Quaternion()

/** 依時間取 root motion 曲線上的值（線性內插） */
function sampleCurve({ times, values }, t) {
  if (t <= times[0]) return values[0]
  const last = times.length - 1
  if (t >= times[last]) return values[last]

  let i = 1
  while (times[i] < t) i++
  const r = (t - times[i - 1]) / (times[i] - times[i - 1])
  return values[i - 1] + (values[i] - values[i - 1]) * r
}

/**
 * Fighter：單一格鬥人物
 * 負責：模型、動作狀態機（idle / walk / walkBack / attack / hit / down）、招式數據、判定框計算、受擊反應
 * 不負責：輸入、雙方推擠、命中判斷、絕招演出，這些由 FighterViewer 統一處理
 * update() 每呼叫一次 = 1 幀（1/60 秒）
 */
export class Fighter {
  constructor(options) {
    const def = {
      scene: null,
      // { scene, clips }：clips 的 key 見 main.js 的 anims；可給多個 Fighter 共用，內部會 clone
      // clip.rootMotion = { times, values }：動畫臀部的前後位移，見 main.js _makeInPlace
      source: null,
      name: '',
      x: 0,
      faceRight: true,
      characterHeight: 1.75,
      moveSpeed: 2, // 公尺 / 秒
      backSpeedRate: 0.8, // 後退速度比例
      walkAnimSpeed: 1, // 走路動畫播放倍率；負數 = 倒著播（換上的走路動畫原本是往後走時設成負數）
      pushHalfWidth: 0.25, // 推擠範圍半寬（公尺）
      fadeTime: 0.1,
      /**
       * 招式數據（幀）：總幀數 = 動畫長度；前搖 startup、收招 recovery，中間全部是攻擊判定
       * hitStun：命中後對手的硬直幀數
       * hitstop：命中 / 被防禦時雙方停頓幾幀（頓幀）；沒填用 main.js 的 hitstopFrames
       *   參考：輕拳 6、中拳 7、重拳 8
       * hitShake：命中時被打中的人在頓幀期間搖晃；true = 搖 main.js hitShake.cycles 次，數字 = 搖幾次
       * chainCancel：預約。攻擊判定第 1 幀的前 chainEarly 幀 ~ 攻擊判定最後 1 幀之間，
       *   按任何攻擊鍵 / 絕招鍵 / 衝刺取消鍵都會記住，這招碰到對手（打中或被防禦）才觸發，揮空不觸發：
       *   - 攻擊 / 絕招：收招少 chainCancel 幀，收招結束直接出那一招
       *   - 衝刺取消：碰到對手時觸發
       * chainEarly：見 chainCancel，預設 5
       * chainMirror：命中後，下一次出同一招時鏡像（左右手交換），連續命中就左右輪流
       * knockback：擊退初速（公尺 / 秒，約退 knockback / 8 公尺）
       * hitInterval：多段攻擊，每幾幀算一段，每段最多命中一次；沒填 = 整段只命中一次
       * hitFrames：多段攻擊每段開頭有攻擊判定的幀數，其餘是段與段之間的空檔；沒填 = 整段都有判定
       * hits：手動指定每段的發生幀（1 起算，同幀數表的編號），每段持續 hitFrames 幀；有填時不看 startup / recovery / hitInterval
       *   也可以寫成 [開始, 結束]（含結束幀）個別指定長度，例如 [50, 60]
       *   第一段之前 = 前搖、段與段之間 = 空檔（顯示成前搖）、最後一段結束後 = 收招
       * blockStun：被防禦時對手的防禦硬直幀數；沒填用人物的 blockStun
       * hitRadius：攻擊判定球半徑（公尺）；沒填用人物的 hitRadius
       * hitLimb：{ from, to, width, extend } 攻擊判定改成沿著肢體方向的長方體（取代判定球）
       *   從 from 骨頭到 to 骨頭，再往外延伸 extend 公尺；截面寬 width 公尺
       * sounds：招式音效 [{ name, frame, delay }]：name = main.js sounds 的 key；frame = 第幾幀播（幀數表編號，沒填 = 1）；delay = 再延遲幾秒（現實時間）
       *   絕招的第 1 幀 = 按下絕招的瞬間（鏡頭演出開始、畫面定格時）
       * lockDistance：吸附時對手與攻擊方的距離（公尺，兩人中心）；沒填 = 推擠框剛好貼齊
       * grab：{ from, to, range, distance, stunFrame } 招式第 from ~ to 幀，對手在地面且距離 range 公尺內時把對手吸過來，
       *   保持 distance 公尺；對手進入受擊硬直，受擊動畫播到第 stunFrame 幀停住，直到被打飛或招式結束（無視防禦）
       *   抓取不算命中；之後的攻擊判定照判定球判斷
       * launchDistance：打飛時對手飛多遠（公尺）；沒填 = 照飛走動畫本身的位移
       * launchReverse：打飛方向反過來（對手先轉身再往後飛）
       * yaw：出招期間人物額外轉幾度（繞 Y 軸，正值 = 從面向方向往左轉）；mirror：出招期間左右鏡像
       * faceCamera：出招期間人物一律面向鏡頭；面向右時鏡像、面向左時照原樣（動畫的側向位移跟著畫面方向）
       * dashThrough：{ from, to, gap, missEnd, lastNoPass } 第 from ~ to 幀快速往前穿過對手，停在對手另一側 gap 公尺（穿越期間不推擠）
       *   lastNoPass：repeatOnHit 最後一次不穿越，衝到對手面前（推擠框貼齊）
       *   lastDistance：repeatOnHit 最後一次改成往前衝固定距離（公尺），不照對手位置
       *   這段沒碰到對手（打中或被防禦）的話，第 to + missEnd 幀後直接結束招式
       * length：招式只用到第幾幀（動畫後面不播）
       * firstPassDelay：repeatOnHit 第一次動畫多播前面幾幀（招式數據照第二次起的幀數，第一次自動往後挪）
       * repeatOnHit：{ at, times } 打中時，第 at 幀後轉身、從頭再出一次同招，最多出 times 次（最後一次才 launch）
       *   沒打中那次就照 length 結束
       * advance：{ from, to, distance } 招式第 from ~ to 幀（幀數表編號，1 起算）平均往前移動 distance 公尺
       * rootMotion：攻擊判定期間套用動畫本身的前後位移
       * launch：最後一段命中時把對手打飛（飛走 → 起身）
       * isSuper：絕招，出招時有鏡頭演出；GUI「招式選取」只列出絕招
       * animStart：絕招從演出的哪個時間點開始播（之前停在第 1 幀，招式幀數也不推進）
       *   'zoomIn' 鏡頭拉近時（預設）/ 'hold' 凍結停留時 / 'zoomOut' 鏡頭拉遠時（遊戲恢復）/ 'after' 鏡頭拉遠後
       *   拉近、停留期間播的部分只是凍結中的動畫（不做命中判定，幀數表畫成綠色虛線）
       * lockTarget：命中後把對手吸附在面前，直到被打飛或招式結束
       * heavyHitEffect：命中時用重擊特效（火花較多、噴較遠）；絕招一律是重擊特效
       * holdUntilLand：空中出招時，動畫播完停在最後一幀，直到落地（接落地硬直）才結束；發生後攻擊判定一直持續到落地
       * hitBones：攻擊判定掛在哪些骨頭，沒填用預設的雙手
       * key 要和 main.js anims 的 key 相同（動畫長度 = 總幀數）
       */
      // 空中出招時改用的招式：地面招式 key → 空中招式 key（沒列的照地面招式）
      airMoves: { heavy: 'airHeavy' },
      moves: {
        // startup = 發生幀 - 1（快打的「發生 10F」= 第 10 幀第一次有攻擊判定）
        light: { name: '輕攻擊', startup: 10, recovery: 11, hitStun: 25, blockStun: 15, hitstop: 6, chainCancel: 5, chainMirror: true, knockback: 1, hitBones: ['RightHand'] }, // Punching_L 是右手出拳
        medium: { name: '中攻擊', startup: 15, recovery: 13, hitStun: 30, blockStun: 17, hitstop: 7, chainCancel: 5, chainMirror: true, hitShake: 1, knockback: 1.7, hitBones: ['RightHand'] }, // Punching_M 是右手出拳，手臂約第 16~21 幀伸直（裁掉前 5 幀後）
        heavy: { name: '重攻擊', startup: 20, recovery: 15, hitStun: 35, blockStun: 20, hitstop: 8, chainCancel: 6, chainMirror: true, hitShake: true, heavyHitEffect: true, knockback: 2.5, hitBones: ['LeftHand'] }, // Punching_H 是左手出拳
        // 空中重攻擊（MmaKick，20 幀）：第 10 幀發生，攻擊判定持續到落地
        airHeavy: { name: '空中重攻擊', startup: 9, recovery: 0, hitStun: 35, blockStun: 20, hitstop: 8, hitShake: true, knockback: 2.5, holdUntilLand: true, hitLimb: { from: 'LeftLeg', to: 'LeftFoot', width: 0.25, extend: 0.12 } }, // MmaKick 是左腳踢出、右腳在下；判定是左小腿（膝蓋 → 腳踝再延伸到腳尖）
        dog_bear: { name: 'dog_bear', isSuper: true, animStart: 'zoomOut', sounds: [{ name: 'dog_bear_title', frame: 1 }, { name: 'dog_bear', frame: 10, delay: 0.1 }], advance: { from: 1, to: 15, distance: 2 }, hits: [18, 68, 103, 153, 198, 243, 293, 328], hitFrames: 10, hitStun: 60, blockStun: 30, knockback: 0, rootMotion: true, launch: true, lockTarget: true, lockDistance: 0.75 },
        // 以下絕招數據先用預設值，之後再依動畫調整
        kick_ball: { name: 'kick_ball', isSuper: true, sounds: [{ name: 'kick_ball_title', frame: 1 }], grab: { from: 44, to: 49, range: 1, distance: 0.6, stunFrame: 10 }, hits: [148], hitFrames: 11, launchDistance: 4, hitStun: 30, knockback: 2, rootMotion: true, launch: true, hitBones: ['LeftFoot', 'RightFoot'] },
        monkey_turn: { name: 'monkey_turn', isSuper: true, startup: 17, recovery: 40, hitStun: 30, knockback: 2, rootMotion: true, launch: true },
        shake_head: { name: 'shake_head', isSuper: true, animStart: 'zoomOut', hitBones: ['RightHand'], sounds: [{ name: 'shake_head_title', frame: 1 }, { name: 'shake_head', frame: 2 }], faceCamera: true, advance: { from: 2, to: 418, distance: 1.5 }, hits: [[8, 18], [48, 58], [93, 103], [143, 153], [183, 193], [223, 233], [273, 283], [318, 328], [378, 418]], hitStun: 80, blockStun: 50, knockback: 0, launch: true, lockTarget: true, lockDistance: 0.75 },
        dodge_step: { name: 'dodge_step', isSuper: true, sounds: [{ name: 'dodge_step_title', frame: 1 }], faceCamera: true, length: 40, firstPassDelay: 48, repeatOnHit: { at: 30, times: 4 }, dashThrough: { from: 5, to: 14, gap: 0.8, lastDistance: 4 }, launchDistance: 4, launchReverse: true, hits: [[5, 14]], hitStun: 45, knockback: 0, launch: true, hitBones: ['LeftHand', 'RightHand', 'Spine2'] },
      },
      hitBones: ['LeftHand', 'RightHand'], // 預設攻擊判定骨頭
      /**
       * 跳躍（幀）：起跳前 prejump → 滯空 air → 落地硬直 landing
       * 高度 = heightRate × 身高（腳底離地），上升、下降各用一段拋物線計算
       * apexRate：滯空的第幾成到最高點；小於 0.5 = 上升快、下降慢（0.5 = 上下對稱）
       * animTakeoff / animLand：Jumping 動畫裡雙腳離地、落地的幀，用來把動畫對到上面三段
       *   以動畫檔本身的幀數填寫（animFps，Mixamo 下載的 30F），跟遊戲邏輯的 FPS 無關
       */
      jump: {
        prejump: 0,
        air: 45,
        landing: 5, // 落地硬直；0 = 落地直接回到站立
        heightRate: 1.25,
        apexRate: 0.4,
        forwardSpeed: 2, // 斜跳水平速度（公尺 / 秒）
        backSpeed: 2,
        animTakeoff: 11,
        animLand: 31,
        animFps: 30,
      },
      // 衝刺：前前 / 後後，固定 frames 幀內移動 distance 公尺，期間不能出招、不能防禦
      // 空中衝刺（跳躍中按 0 或連按兩下方向鍵）也用同一組數據；衝刺期間停在當下高度，之後落下，直到落地都不能再出招
      dash: {
        frames: 20,
        forwardDistance: 1.2,
        backDistance: 1,
        animSpeed: 1, // 衝刺動畫（Walking_dash）播放倍率
      },
      blockStun: 5, // 防禦硬直（幀）
      blockPush: 1.5, // 防禦時往後滑的初速（公尺 / 秒）
      hitRadius: 0.18, // 攻擊判定球半徑（公尺），所有招式共用；個別招式可用 hitRadius 覆蓋
      flashStrength: 0.3, // 受擊偏紅程度（0~1）：綠、藍色最多壓掉多少比例，刻意調淡
      flashFrames: 10,
      superInvincibleFrames: 10, // 絕招前幾幀無敵（攻擊判定開始就結束）
      flashGlow: 0.25, // 受擊時身體疊加的紅色自發光（0~1）
      // 衝刺取消（按鈕 0）：輕 / 重攻擊命中後可取消成往前衝刺，衝刺中可以隨時出招
      rush: {
        moves: ['light', 'medium', 'heavy'], // 哪些招式命中後可以取消
        glowTime: 0.5, // 發光秒數
        glowColor: 0x66ffcc,
        glowStrength: 0.6, // 發光強度（0~1）
        freezeFrames: 10, // 按下時雙方先停頓幾幀（頓幀），之後才開始衝刺
        animStartFrame: 5, // 停頓的第幾幀開始播衝刺動畫（人還不會移動，對手仍停住）
        lockFrames: 5, // 衝刺開始後前幾幀不能出招
        lockSpeedRate: 2, // 不能出招的那幾幀，前進速度是前前的幾倍
      },
      showDebug: true,
      showSkeleton: false,
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
    this.model = null
    this.mixer = null
    this.actions = {} // clips 的 key + walkBack → AnimationAction
    this.currentAction = null
    this.state = 'idle'
    this.stateFrame = 0 // 目前狀態已經過幾幀（0 起算）
    this.stateLength = 0 // attack / hit / down 的總幀數
    this.isStateHeld = false // 絕招演出期間停在第 0 幀，下一次 update 不推進
    this.currentMove = null // 出招中的招式 key，見 moves
    this.hitWindow = -1 // 已命中的段數（多段攻擊用），同一段不重複命中
    this.hitStunFrames = 0 // 這次受擊的硬直幀數，由攻擊方的招式決定
    this.blockStunFrames = 0 // 這次防禦的硬直幀數，招式有填 blockStun 時用招式的
    this.flyFrames = 0 // 倒地中「飛走」的幀數，之後接起身
    this.knockVelocity = 0
    this.isGuarding = false // 這一幀是否按著後（防禦）
    this.isAirborne = false
    this.isJumpArc = false // 跳躍中用公式算高度；被打飛時改成自由落下
    this.jumpDir = 0 // 起跳時的方向（世界座標 -1 / 0 / 1）
    this.dashDir = 0 // 衝刺方向（世界座標 -1 / 1）
    this.vx = 0 // 空中水平速度（公尺 / 秒）
    this.vy = 0 // 垂直速度（公尺 / 秒）
    this.airFrame = 0 // 離地後經過幾幀，用來對應跳躍動畫
    this.hasAirAttacked = false // 一次跳躍只能出一招
    this.hasAirDashed = false // 一次跳躍只能空中衝刺一次
    this.flashFrame = 0
    this.materials = [] // { material, color, emissive }：clone 過的材質與原本的顏色、自發光
    this.hitConfirmed = false // 這次出招已經打中對手（防禦住不算），衝刺取消用
    this.isRush = false // 目前的衝刺是衝刺取消：期間可以出招
    this.glowFrame = 0
    this.isMirrored = false // 目前這次出招是否鏡像（chainMirror）
    this.nextMirror = false // 下一次出 chainMirror 招式時是否鏡像
    this.pushVelocity = 0 // 打到邊界的對手時，自己往後退的速度（公尺 / 秒）
    this.chainKey = null // chainCancel：預約的下一招（攻擊或絕招）
    this.queuedAttack = null // 預約的絕招：絕招要由 main.js 開演出，收招結束後交給 main.js 送出
    this.twinActions = new Map() // 同一個動作重新播放時改播分身，才能從舊的淡入新的（連打不會瞬間跳回第 0 幀）
    this.connected = false // 這次出招已經碰到對手（打中或被防禦），衝刺取消用
    this.rushQueued = false // 預約了衝刺取消：碰到對手時觸發（chainCancel 招式照預約時段，其他招式前搖 ~ 攻擊判定）
    this.startedMove = false // 這一幀開始出招（main.js 清掉收招預約用）
    this.keepRushAnim = false // 衝刺動畫已在停頓中先播了，開始衝刺時不要重播
    this.rushAttack = null // 衝刺取消的停頓 / 不能出招期間按的招式，可以出招的第一幀出（絕招由 main.js 開演出）
    this.usedRush = false // 這一幀用掉了衝刺取消鍵（main.js 清掉記住的輸入）
    this.recoveryCut = 0 // chainCancel：這次出招的收招少了幾幀
    this.hurtboxParts = [] // { box, bones, pad, helper }
    this.hitParts = [] // { name, sphere, bone, helper }：所有招式用到的骨頭，出招時只啟用該招的部分
    this.limbHit = null // { obb, helper }：hitLimb 招式的長方體判定
    this.boneCache = {} // 骨頭名稱（不含前綴）→ 骨頭，見 _getBone
    this.pushBox = new THREE.Box3()
    this.debugGroup = new THREE.Group()
    this.skeletonHelper = null

    // 5. init
    this.init()
  }

  init() {
    this._setupModel()
    this._buildActions()
    this._setupBoxes()
    this.setDebugVisible(this.showDebug)
    this.setSkeletonVisible(this.showSkeleton)
    this.scene.add(this.model, this.debugGroup)
    this._applyFacing()
    // state 初始值就是 idle，要強制播放，否則 _setState 會當作沒變而跳過
    this._setState('idle', true)
  }

  // public

  get x() {
    return this.model ? this.model.position.x : this._x
  }

  set x(value) {
    if (this.model) this.model.position.x = value
    else this._x = value
  }

  get facingSign() {
    return this.faceRight ? 1 : -1
  }

  get y() {
    return this.model.position.y
  }

  set y(value) {
    this.model.position.y = value
  }

  /** 可以自由行動（可出招、移動、跳） */
  get canAct() {
    return this.state === 'idle' || this.state === 'walk' || this.state === 'walkBack'
  }

  /** 這一幀被打到時能否防禦：在地上、按著後、沒有在出招 / 受擊 */
  get canBlock() {
    return this.isGuarding && !this.isAirborne && (this.canAct || this.state === 'block')
  }

  /** 被打飛、飛走動畫還沒播完（還沒起身）：判定為空中受擊，可以被追打 */
  get isLaunched() {
    return this.state === 'down' && this.stateFrame < this.flyFrames
  }

  /**
   * 無敵：起身期間（飛走中不無敵，見 isLaunched）；絕招的前 superInvincibleFrames 幀，但攻擊判定第 1 幀起就不再無敵（以先到的為準）
   * 絕招鏡頭演出期間遊戲暫停，本來就不會被打
   */
  get isInvincible() {
    if (this.state === 'down') return !this.isLaunched
    const move = this.getCurrentMove()
    if (!move?.isSuper) return false
    const firstActive = move.hits ? hitRange(move.hits[0], move.hitFrames)[0] : move.startup + 1
    return this.stateFrame + 1 <= this.superInvincibleFrames && this.moveFrame < firstActive
  }

  /** 臀部離地高度（公尺），座標標示用 */
  get hipsHeight() {
    return this.hipsBone ? this.hipsBone.getWorldPosition(new THREE.Vector3()).y : 0
  }

  /** 動畫的總幀數 */
  getClipLength(key) {
    const clip = this.actions[key]?.getClip()
    return clip ? Math.round(clip.duration * FPS) : 0
  }

  /**
   * 推進 1 幀
   * @param {{ move: number, attack: string | null, jump: boolean, guard: boolean, dash: number }} input
   *   move：世界座標方向 -1 / 0 / 1；attack：招式 key；jump：按著上；guard：不移動但當作按著後（木樁防禦用）
   *   dash：連按兩下方向鍵觸發的衝刺方向（世界座標 -1 / 1），0 = 沒有
   */
  update(input = { move: 0, attack: null, jump: false, guard: false }) {
    this.isGuarding = !!input.guard || (input.move !== 0 && input.move === -this.facingSign)
    this._advanceState()

    const airDashDir = this._getAirDashDir(input)
    const airAttack = input.attack && (this.airMoves[input.attack] ?? input.attack)
    const canAirAttack = this.state === 'air' && !this.hasAirAttacked && airAttack && this.actions[airAttack] && !this.moves[airAttack]?.isSuper

    // 預約時段內按衝刺取消：先記住，碰到對手時觸發（見 main.js _step）
    if (input.rush && !this.canRush && !this.rushQueued && this._canQueueRush()) {
      this.rushQueued = true
      this.usedRush = true
    }

    // 衝刺取消：停頓中（輸入會延到停頓結束這一幀）或前 lockFrames 幀按的招式先記住
    const isRushLocked = this.state === 'dash' && this.isRush && this.stateFrame < this.rush.lockFrames
    if (input.attack && this.actions[input.attack] && ((input.rush && this.canRush) || isRushLocked)) this.rushAttack = input.attack

    if (input.rush && this.canRush) {
      this.usedRush = true
      this._startRush()
    } else if (this._canChain(input.attack)) {
      // 預約下一招（以最後按的為準），碰到對手才會在這招結束時出（見 _advanceState）
      this.chainKey = input.attack
    } else if (this.isRushReady && (input.attack || this.rushAttack) && !this.moves[input.attack || this.rushAttack]?.isSuper) {
      // 衝刺取消中，前 lockFrames 幀之後可以隨時出招（含先記住的）
      const key = input.attack || this.rushAttack
      this.rushAttack = null
      this.startMove(key)
      this.isStateHeld = false
    } else if (airDashDir) {
      this._startAirDash(airDashDir)
      if (input.rush) this.usedRush = true
    } else if (this.state === 'dash' || this.state === 'airDash') {
      this._dashStep()
    } else if (this.state === 'hit' || this.state === 'block') {
      this.x += this.knockVelocity * STEP
      this.knockVelocity *= Math.exp(-8 * STEP)
    } else if (canAirAttack) {
      // 空中攻擊：airMoves 有列的改用空中招式，其餘沿用地面招式；一次跳躍只能出一招
      this.hasAirAttacked = true
      this.currentMove = airAttack
      this._setState('attack')
    } else if (this.canAct) {
      // 5. 走路中按衝刺取消鍵 = 前前 / 後後
      const walkDash = input.rush && input.move !== 0 ? input.move : 0
      if (input.attack && this.actions[input.attack]) {
        this.startMove(input.attack)
        this.isStateHeld = false
        // 跟出招鍵同時（或稍早）按了衝刺取消：出招後立刻預約
        if (input.rush && this._canQueueRush()) {
          this.rushQueued = true
          this.usedRush = true
        }
      } else if (input.dash || walkDash) {
        if (walkDash) this.usedRush = true
        this.dashDir = input.dash || walkDash
        this._setState('dash')
        this._dashStep() // 進入衝刺的這一幀也要移動，frames 幀才會剛好走完全程
      } else if (input.jump && this.actions.jump) {
        // 起跳方向在按下的瞬間決定，空中不能改
        this.jumpDir = input.move
        this._setState('jumpStart')
      } else if (input.guard) {
        this._setState('idle')
      } else if (input.move !== 0) {
        const isForward = input.move === this.facingSign
        const speed = this.moveSpeed * (isForward ? 1 : this.backSpeedRate)
        this.x += input.move * speed * STEP
        this._setState(isForward ? 'walk' : 'walkBack')
      } else {
        this._setState('idle')
      }
    }

    this._updateAirborne()
    this._syncJumpAnimation()
    this._syncGrabbedAnimation()

    const action = this.currentAction
    const prevTime = action.time
    this.mixer.update(STEP)
    this._applyRootMotion(action, prevTime)
    this._applyChainCut()
    this._applyAdvance()
    this._checkDashThroughMiss()
    this._checkPassFlow()
    this._updatePushback()
    this._updateFlash()
    this._updateGlow()
  }

  /** 出招；停在第 0 幀，下一次 update 才開始算（絕招演出時先呼叫這個再凍結畫面） */
  startMove(key) {
    this.currentMove = key
    this._setState('attack', true)
    this.isStateHeld = true
    this.mixer.update(0) // 讓姿勢立刻變成招式第 0 幀
  }

  /** 防禦住攻擊：播防禦動作、往後滑一點，硬直 = 招式的 blockStun（沒填用人物的 blockStun） */
  takeBlock(fromX, move) {
    this.blockStunFrames = move?.blockStun ?? this.blockStun
    const away = this.x >= fromX ? 1 : -1
    this.knockVelocity = away * (move?.knockback || this.blockPush) // 被防禦也照招式的擊退推開；擊退 0 的招式用人物的 blockPush
    this._setState('block', true)
  }

  /** 目前招式的數據（出招中才有） */
  getCurrentMove() {
    return this.state === 'attack' ? this.moves[this.currentMove] : null
  }

  /**
   * 幀數表用的目前幀類型
   * @returns {'startup' | 'active' | 'recovery' | 'stun' | 'block' | 'dash' | 'down' | 'invincible' | 'prejump' | 'air' | 'landing' | null} null 代表可自由行動
   */
  getFrameType() {
    if (this.state === 'hit') return 'stun'
    if (this.state === 'block') return 'block'
    if (this.state === 'jumpStart') return 'prejump'
    if (this.state === 'air') return 'air'
    if (this.state === 'land') return 'landing'
    if (this.state === 'dash' || this.state === 'airDash') return 'dash'
    if (this.isLaunched) return 'stun' // 飛走中是受擊硬直（可被追打），起身才是無敵的倒地
    if (this.state === 'down') return 'down'
    if (this.state !== 'attack') return null
    if (this.isInvincible) return 'invincible' // 絕招開頭的無敵幀

    const phase = this._getAttackPhase()
    if (phase !== 'active') return phase

    // 多段攻擊：每段只有開頭 hitFrames 幀有判定，空檔顯示成前搖（下一段的前搖）
    const { startup, hits, hitInterval, hitFrames } = this.moves[this.currentMove]
    if (hits) {
      const frame = this.moveFrame
      return hits.some(h => {
        const [from, to] = hitRange(h, hitFrames)
        return frame >= from && frame <= to
      }) ? 'active' : 'startup'
    }
    if (hitInterval && hitFrames && (this.stateFrame - startup) % hitInterval >= hitFrames) return 'startup'
    return 'active'
  }

  /** 招式的大階段：前搖 / 攻擊段（含多段之間的空檔）/ 收招 */
  _getAttackPhase() {
    const { startup, recovery, hits, hitFrames } = this.moves[this.currentMove]
    if (hits) {
      const frame = this.moveFrame // 幀數表的編號（1 起算）
      if (frame < hitRange(hits[0], hitFrames)[0]) return 'startup'
      if (frame > hitRange(hits[hits.length - 1], hitFrames)[1]) return 'recovery'
      return 'active'
    }
    if (this.stateFrame < startup) return 'startup'
    // holdUntilLand：空中發生後一直是攻擊判定，直到落地
    if (this.isAirborne && this.moves[this.currentMove].holdUntilLand) return 'active'
    // chainCancel 縮短的是收招，攻擊判定幀不變
    if (this.stateFrame >= this.stateLength - (recovery - this.recoveryCut)) return 'recovery'
    return 'active'
  }

  /** 轉向對手；攻擊、受擊、倒地中不轉身 */
  faceTo(targetX) {
    if (!this.canAct) return
    const faceRight = targetX >= this.x
    if (faceRight === this.faceRight) return
    this.faceRight = faceRight
    this._applyFacing()
  }

  /** 依目前骨頭位置更新受擊框、攻擊判定與推擠框；呼叫前需先更新 matrixWorld */
  updateBoxes() {
    const pos = new THREE.Vector3()

    this.hurtboxParts.forEach(part => {
      part.box.makeEmpty()
      part.bones.forEach(bone => part.box.expandByPoint(bone.getWorldPosition(pos)))
      part.box.expandByScalar(part.pad)
      part.box.min.z -= part.zPad
      part.box.max.z += part.zPad
      part.helper.visible = !this.isInvincible
    })

    const isHitActive = this.isHitActive()
    const activeBones = this._getActiveHitBones()
    const move = this.getCurrentMove()
    const radius = move?.hitRadius ?? this.hitRadius
    this.hitParts.forEach(part => {
      part.bone.getWorldPosition(part.sphere.center)
      part.sphere.radius = radius
      part.helper.position.copy(part.sphere.center)
      part.helper.scale.setScalar(radius / this.hitRadius) // 判定球網格是用預設半徑建的
      part.helper.visible = isHitActive && !move?.hitLimb && activeBones.includes(part.name)
    })
    this._updateLimbHit(move?.hitLimb, isHitActive)

    this.pushBox.min.set(this.x - this.pushHalfWidth, 0, -0.3)
    this.pushBox.max.set(this.x + this.pushHalfWidth, 0.02, 0.3)
  }

  /** 攻擊判定只在 active 幀、且目前這一段尚未命中時有效 */
  isHitActive() {
    return this.getFrameType() === 'active' && this._getHitWindow().index !== this.hitWindow
  }

  /** 攻擊判定是否碰到對手的任一受擊框 */
  checkHit(target) {
    if (!this.isHitActive() || target.isInvincible) return false
    const activeBones = this._getActiveHitBones()
    if (this.getCurrentMove()?.hitLimb) return target.hurtboxParts.some(hurt => this.limbHit.obb.intersectsBox3(hurt.box))
    return this.hitParts
      .filter(hit => activeBones.includes(hit.name))
      .some(hit => target.hurtboxParts.some(hurt => hurt.box.intersectsSphere(hit.sphere)))
  }

  /**
   * 命中點（打擊特效用）：攻擊判定碰到的受擊框上，離判定中心最近的點
   * 找不到接觸（例如吸附中必定命中、沒有實際碰到）就用對手身體中心
   */
  getHitPoint(target) {
    const point = new THREE.Vector3()
    if (this.getCurrentMove()?.hitLimb) {
      const { obb } = this.limbHit
      const hurt = target.hurtboxParts.find(h => obb.intersectsBox3(h.box))
      if (hurt) return hurt.box.clampPoint(obb.center, point)
    } else {
      const activeBones = this._getActiveHitBones()
      for (const hit of this.hitParts) {
        if (!activeBones.includes(hit.name)) continue
        const hurt = target.hurtboxParts.find(h => h.box.intersectsSphere(hit.sphere))
        if (hurt) return hurt.box.clampPoint(hit.sphere.center, point)
      }
    }
    const body = target.hurtboxParts.find(h => h.name === 'body') || target.hurtboxParts[0]
    return body ? body.box.getCenter(point) : point.set(target.x, 1, 0)
  }

  /**
   * 記錄這一段已命中
   * @returns {boolean} 是否要把對手打飛（launch 招式的最後一段）
   */
  registerHit() {
    const { index, count } = this._getHitWindow()
    this.hitWindow = index
    this.connected = true
    if (this.moves[this.currentMove].chainMirror) this.nextMirror = !this.isMirrored // 下一次同招換手
    const move = this.moves[this.currentMove]
    // repeatOnHit 的招式：最後一次才打飛
    return !!move.launch && index === count - 1 && (!move.repeatOnHit || this.passCount >= (move.repeatOnHit.times ?? 2))
  }

  /**
   * 被打中：中斷目前動作、擊退或打飛、閃紅光
   * @param {number} fromX 攻擊方位置，決定擊退方向
   * @param {{ hitStun: number, knockback: number }} move 攻擊方的招式數據
   * @param {boolean} isLaunch 打飛：播飛走 + 起身，只有起身無敵（空中、飛走中被打到也一律重新打飛）
   */
  takeHit(fromX, move, isLaunch = false) {
    this.grabFrame = 0
    this.flashFrame = this.flashFrames
    this._applyFlash(1) // 頓幀期間不會 update，先亮起來
    this.knockVelocity = 0

    if ((isLaunch || this.isAirborne || this.isLaunched) && this.actions.fly) {
      if (this.isJumpArc) {
        // 從跳躍拋物線切到自由落下，延續當下的垂直速度
        this.vy = this._getJumpVelocity(this.airFrame / this.jump.air)
        this.isJumpArc = false
      }
      this.vx = 0
      this.flyScale = this._getFlyScale(move.launchDistance)
      if (move.launchReverse) {
        // 反向打飛：轉身後照常往背後飛，動作方向才對
        this.faceRight = !this.faceRight
        this._applyFacing()
      }
      this._setState('down', true)
      return
    }

    const away = this.x >= fromX ? 1 : -1
    this.knockVelocity = away * move.knockback
    this.hitStunFrames = move.hitStun
    this._setState('hit', true)
    this.snapToCurrentAction()
  }

  /**
   * 不淡入，立刻變成目前動作的第 1 幀
   * 受擊、絕招用：頓幀 / 絕招演出期間動畫不會推進，不這樣做的話停住時看到的還是之前的姿勢
   */
  snapToCurrentAction() {
    const action = this.currentAction
    if (!action) return
    this.mixer.stopAllAction()
    action.reset()
    action.setEffectiveTimeScale(1)
    action.setEffectiveWeight(1)
    action.play()
    this.mixer.update(0)
  }

  setDebugVisible(isVisible) {
    this.showDebug = isVisible
    this.debugGroup.visible = isVisible
  }

  setSkeletonVisible(isVisible) {
    this.showSkeleton = isVisible
    this.skeletonHelper.visible = isVisible
  }

  /** 從場景移除（切換人物時用） */
  dispose() {
    this.mixer.stopAllAction()
    this.scene.remove(this.model, this.debugGroup)
    this.materials.forEach(({ material }) => material.dispose())
  }

  // internal

  _setupModel() {
    const x = this._x ?? 0
    // SkeletonUtils.clone 才會連骨架一起複製，一般 clone 會讓兩個人物共用骨頭
    this.model = SkeletonUtils.clone(this.source.scene)

    // clone 出來的骨架矩陣還沒算過，直接量包圍盒會幾乎是 0，縮放就會爆掉
    this.model.updateMatrixWorld(true)
    this.model.traverse(obj => {
      if (obj.isSkinnedMesh) obj.skeleton.update()
    })
    const box = new THREE.Box3().setFromObject(this.model)
    this.model.scale.setScalar(this.characterHeight / (box.max.y - box.min.y))
    this.model.position.x = x

    this.model.traverse(obj => {
      if (!obj.isMesh) return
      obj.castShadow = true
      obj.receiveShadow = true
      // 材質也要 clone，受擊閃光才不會影響到同一個人物檔的另一個人物
      const list = Array.isArray(obj.material) ? obj.material : [obj.material]
      const cloned = list.map(material => {
        const copy = material.clone()
        copy.fog = false // 場景的霧只蓋場地（絕招演出用），人物不受影響
        if (copy.color) this.materials.push({ material: copy, color: copy.color.clone(), emissive: copy.emissive?.clone() })
        return copy
      })
      obj.material = Array.isArray(obj.material) ? cloned : cloned[0]
    })

    this.skeletonHelper = new THREE.SkeletonHelper(this.model)
    this.debugGroup.add(this.skeletonHelper)

    this.mixer = new THREE.AnimationMixer(this.model)
  }

  /** 建立動作；缺少的動作用現有動作代替 */
  _buildActions() {
    const clips = this.source.clips
    const walk = clips.walk

    const map = {
      ...clips,
      idle: clips.idle || (walk && THREE.AnimationUtils.subclip(walk, 'idle_fallback', 0, 1)), // 沒有 idle：walking 第一格
      walkBack: clips.walkBack || walk?.clone(), // 沒有後退動作：walking 倒著播，見 _play
      dash: clips.dash || walk, // 沒有衝刺動作：用 walking 代替
    }
    this.hasWalkBackClip = !!clips.walkBack

    Object.entries(map).forEach(([key, clip]) => {
      if (clip) this.actions[key] = this.mixer.clipAction(clip)
    })

    Object.entries(this.moves).forEach(([key, { startup, recovery, hits, hitFrames }]) => {
      const length = this.getClipLength(key)
      if (hits) {
        const end = hitRange(hits[hits.length - 1], hitFrames)[1]
        if (length && end > length) console.warn(`[${this.name}] ${key} 動畫只有 ${length} 幀，最後一段攻擊到第 ${end} 幀`)
        return
      }
      if (length && length <= startup + recovery) {
        console.warn(`[${this.name}] ${key} 動畫只有 ${length} 幀，扣掉前搖 ${startup} 與收招 ${recovery} 後沒有攻擊判定`)
      }
    })
  }

  /**
   * hitLimb 的長方體判定：長軸從 from 骨頭指向 to 骨頭，長度 = 兩骨頭距離 + extend，截面 width × width
   * 截面的旋轉取「把 Y 軸轉到肢體方向」的最短旋轉，長方體繞長軸的角度不影響太大
   */
  _updateLimbHit(limb, isHitActive) {
    const { obb, helper } = this.limbHit
    const from = limb && this._getBone(limb.from)
    const to = limb && this._getBone(limb.to)
    helper.visible = !!(from && to) && isHitActive
    if (!from || !to) {
      obb.halfSize.set(0, 0, 0)
      return
    }

    const start = from.getWorldPosition(new THREE.Vector3())
    const dir = to.getWorldPosition(new THREE.Vector3()).sub(start)
    const length = dir.length() + (limb.extend ?? 0)
    dir.normalize()
    const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir)

    obb.center.copy(start).addScaledVector(dir, length / 2)
    obb.halfSize.set(limb.width / 2, length / 2, limb.width / 2)
    obb.rotation.setFromMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(quaternion))

    helper.position.copy(obb.center)
    helper.quaternion.copy(quaternion)
    helper.scale.set(limb.width, length, limb.width)
  }

  /** 依 Mixamo 骨頭名稱（不含前綴）取得骨頭，查過的會記住 */
  _getBone(name) {
    if (!(name in this.boneCache)) this.boneCache[name] = this.model.getObjectByName(`${BONE_PREFIX}${name}`) || null
    return this.boneCache[name]
  }

  _setupBoxes() {
    this.boneCache = {} // 換模型時重查
    const getBone = name => this._getBone(name)

    this.hurtboxParts = HURTBOX_PARTS.map(part => {
      const box = new THREE.Box3()
      const helper = new THREE.Box3Helper(box, COLOR.hurtbox)
      this.debugGroup.add(helper)
      return { name: part.name, box, pad: part.pad, zPad: part.zPad || 0, helper, bones: part.bones.map(getBone).filter(Boolean) }
    }).filter(part => part.bones.length)

    this.hipsBone = getBone('Hips')

    // 所有招式用到的攻擊骨頭都建一顆判定球
    const names = new Set(this.hitBones)
    Object.values(this.moves).forEach(move => move.hitBones?.forEach(name => names.add(name)))

    const sphereGeo = new THREE.SphereGeometry(this.hitRadius, 12, 8)
    const sphereMat = new THREE.MeshBasicMaterial({ color: COLOR.hitbox, wireframe: true })
    this.hitParts = [...names].map(name => ({ name, bone: getBone(name) })).filter(part => part.bone).map(part => {
      const helper = new THREE.Mesh(sphereGeo, sphereMat)
      this.debugGroup.add(helper)
      return { ...part, helper, sphere: new THREE.Sphere(new THREE.Vector3(), this.hitRadius) }
    })

    // hitLimb 招式共用的長方體判定（1 × 1 × 1 的網格，依肢體長度縮放）
    const limbHelper = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), sphereMat)
    limbHelper.visible = false
    this.debugGroup.add(limbHelper)
    this.limbHit = { obb: new OBB(), helper: limbHelper }

    this.debugGroup.add(new THREE.Box3Helper(this.pushBox, COLOR.pushbox))
  }

  /** 推進狀態幀數：attack / hit / down 到期就回到 idle；倒地中飛走播完接起身 */
  _advanceState() {
    if (this.isStateHeld) {
      this.isStateHeld = false
      return
    }
    if (this.canAct) return

    this.stateFrame++
    if (this.state === 'air') return // 滯空由 _updateAirborne 依高度判斷落地

    if (this.state === 'jumpStart') {
      if (this.stateFrame >= this.jump.prejump) this._takeOff()
    } else if (this.stateFrame >= this.stateLength && this.state === 'attack' && this.chainKey && this.connected && !this.isAirborne) {
      const key = this.chainKey
      if (this.moves[key].isSuper) {
        // 絕招要開演出：先回到站立，下一幀由 main.js 送出
        this.queuedAttack = key
        this._setState('idle')
      } else {
        // 直接出預約的招式（同招連打時 chainMirror 會換手）
        // 不定格第 0 幀：接在上一招最後一幀之後，幀數連貫
        this.currentMove = key
        this._setState('attack', true)
      }
    } else if (this.stateFrame >= this.stateLength && this.isAirborne && this.getCurrentMove()?.holdUntilLand) {
      // holdUntilLand：停在最後一幀等落地（落地由 _updateAirborne 切到落地硬直）
    } else if (this.stateFrame >= this.stateLength) {
      // 空中出招 / 空中衝刺結束還沒落地：回到滯空姿勢
      this._setState(this.isAirborne && ['attack', 'airDash'].includes(this.state) ? 'air' : 'idle')
    } else if (this.state === 'down' && this.stateFrame === this.flyFrames) {
      this._play('getUp', true)
    }
  }

  /** 目前招式的攻擊判定骨頭 */
  _getActiveHitBones() {
    return this.moves[this.currentMove]?.hitBones || this.hitBones
  }

  /**
   * 多段攻擊的目前段數
   * hits 有填：目前已到第幾個發生幀
   * 否則段數 = 攻擊判定幀數 / hitInterval（無條件捨去），餘數併入最後一段，避免最後一段只剩 1、2 幀
   */
  _getHitWindow() {
    const move = this.moves[this.currentMove]
    if (move?.hits) {
      const frame = this.moveFrame
      const index = Math.max(0, move.hits.findLastIndex(h => frame >= hitRange(h, move.hitFrames)[0]))
      return { index, count: move.hits.length }
    }
    if (!move?.hitInterval) return { index: 0, count: 1 }

    const activeLength = this.stateLength - move.startup - move.recovery
    const count = Math.max(1, Math.floor(activeLength / move.hitInterval))
    const index = Math.min(count - 1, Math.floor((this.stateFrame - move.startup) / move.hitInterval))
    return { index, count }
  }

  /**
   * 跳躍拋物線：最高點 h、上升 Tu 秒、下降 Td 秒（Tu = apexRate × 滯空）
   * 上升重力 2h/Tu²、起跳速度 2h/Tu；下降重力 2h/Td²（上升快、下降慢時，下降重力較小）
   * 空中被打飛、空中衝刺後的自由落下都用下降重力
   */
  _getJumpPhysics() {
    const h = this.jump.heightRate * this.characterHeight
    const T = this.jump.air / FPS
    const a = this._getApexRate()
    const up = a * T
    const down = (1 - a) * T
    return { speed: (2 * h) / up, riseGravity: (2 * h) / up ** 2, gravity: (2 * h) / down ** 2 }
  }

  /** 最高點在滯空的比例，限制在 0.1 ~ 0.9 避免除以 0 */
  _getApexRate() {
    return Math.min(0.9, Math.max(0.1, this.jump.apexRate ?? 0.5))
  }

  /** 跳躍進度 p（0 ~ 1）的高度：最高點前後各一段拋物線 */
  _getJumpHeight(p) {
    const h = this.jump.heightRate * this.characterHeight
    const a = this._getApexRate()
    const r = p < a ? 1 - p / a : (p - a) / (1 - a)
    return h * (1 - r * r)
  }

  /** 跳躍進度 p 的垂直速度（公尺 / 秒）：上升段由起跳速度遞減，下降段從 0 開始往下加速 */
  _getJumpVelocity(p) {
    const { speed, riseGravity, gravity } = this._getJumpPhysics()
    const T = this.jump.air / FPS
    const a = this._getApexRate()
    return p < a ? speed - riseGravity * p * T : -gravity * (p - a) * T
  }

  /** 衝刺 1 幀的位移：全程平均分到每一幀 */
  _dashStep() {
    const { frames, forwardDistance, backDistance } = this.dash
    const distance = this.dashDir === this.facingSign ? forwardDistance : backDistance
    // 衝刺取消：不能出招的前 lockFrames 幀用 lockSpeedRate 倍速前進
    const rate = this.isRush && this.stateFrame < this.rush.lockFrames ? this.rush.lockSpeedRate : 1
    this.x += this.dashDir * (distance / frames) * rate
  }

  /**
   * 這一幀要不要空中衝刺，回傳方向（世界座標 -1 / 1），0 = 不衝刺
   * 連按兩下方向鍵照按的方向；按 0 時看按著的方向，沒按方向就照起跳方向，垂直跳則往前
   */
  _getAirDashDir(input) {
    if (this.state !== 'air' || this.hasAirDashed) return 0
    if (input.dash) return input.dash
    if (!input.rush) return 0
    return input.move || this.jumpDir || this.facingSign
  }

  /** 空中衝刺：停在當下高度水平衝 dash.frames 幀，之後自由落下；直到落地都不能出招、不能再衝刺 */
  _startAirDash(dir) {
    this.hasAirDashed = true
    this.hasAirAttacked = true
    this.dashDir = dir
    this.isJumpArc = false // 衝刺結束後從 0 速度自由落下
    this.vx = 0
    this.vy = 0
    this._setState('airDash')
    this._dashStep() // 進入衝刺的這一幀也要移動
  }

  _takeOff() {
    const { forwardSpeed, backSpeed } = this.jump
    const dir = this.jumpDir
    this.isAirborne = true
    this.hasAirAttacked = false
    this.hasAirDashed = false
    this.airFrame = 0
    this.isJumpArc = true
    this.vy = this._getJumpPhysics().speed
    this.vx = dir * (dir === this.facingSign ? forwardSpeed : backSpeed)
    this._setState('air')
  }

  /** 空中物理：拋物線、水平速度；腳底碰地就落地（被打飛也一樣會落下） */
  _updateAirborne() {
    if (!this.isAirborne || this.state === 'airDash') return // 空中衝刺中停在當下高度
    this.airFrame++
    this.x += this.vx * STEP

    if (this.isJumpArc) {
      // 跳躍用公式算高度，最高點剛好 = 目標高度、第 air 幀剛好落地（逐幀累加速度會有誤差）
      this.y = this._getJumpHeight(this.airFrame / this.jump.air)
    } else {
      // 空中被打飛：從當下的速度自由落下
      this.y += this.vy * STEP
      // 往上時用上升重力、往下時用下降重力，跟跳躍軌跡一致
      const { riseGravity, gravity } = this._getJumpPhysics()
      this.vy -= (this.vy > 0 ? riseGravity : gravity) * STEP
    }
    if (this.y > 0) return

    this.y = 0
    this.vx = 0
    this.vy = 0
    this.isAirborne = false
    this.isJumpArc = false
    // 被打飛時讓飛走動畫繼續播；跳躍或空中出招則進入落地硬直（landing 為 0 時直接站立）
    if (this.state === 'air' || this.state === 'attack') this._setState(this.jump.landing > 0 ? 'land' : 'idle')
  }

  /** 跳躍動畫不照時間播，而是依「起跳前 / 滯空 / 落地」的進度對到動畫裡相對的位置 */
  _syncJumpAnimation() {
    if (!['jumpStart', 'air', 'land'].includes(this.state)) return
    const action = this.actions.jump
    const { prejump, air, landing, animTakeoff, animLand, animFps } = this.jump
    // 動畫裡的時間點（秒）
    const takeoff = animTakeoff / animFps
    const land = animLand / animFps
    const end = action.getClip().duration
    const lerp = (from, to, r) => from + (to - from) * Math.min(1, r)

    let time = lerp(land, end, this.stateFrame / landing)
    if (this.state === 'jumpStart') time = lerp(0, takeoff, this.stateFrame / prejump)
    else if (this.state === 'air') {
      // 動畫的最高點在中間：上升段對到前半、下降段對到後半，動作才會跟著不對稱的軌跡
      const p = Math.min(1, this.airFrame / air)
      const a = this._getApexRate()
      const animP = p < a ? 0.5 * (p / a) : 0.5 + 0.5 * ((p - a) / (1 - a))
      time = lerp(takeoff, land, animP)
    }
    // 動畫速度設為 0（見 _setState），mixer.update 不會再推進時間
    action.time = time
  }

  /** root motion：把動畫臀部的前後位移轉成人物座標（動畫本身已改成原地播放） */
  _applyRootMotion(action, prevTime) {
    const curve = action.getClip().rootMotion
    if (!curve) return

    const isOn = this.state === 'down'
      ? action === this.actions.fly
      : this.state === 'attack' && this.moves[this.currentMove].rootMotion && this._getAttackPhase() === 'active'
    if (!isOn) return

    let delta = sampleCurve(curve, action.time) - sampleCurve(curve, prevTime)
    if (this.state === 'down') delta *= this.flyScale ?? 1
    // 動畫的前方是模型的 +Z，轉成世界座標的面向方向
    // 面向鏡頭的招式取側向（X）位移時：模型沒有旋轉，動畫的 X 直接對到世界 X（scale.x 帶鏡像的正負號）
    // 取前後（Z）位移時照一般招式，往對手方向前進
    if (this.getCurrentMove()?.faceCamera && curve.axis === 'x') this.x += delta * this.model.scale.x
    else this.x += delta * Math.abs(this.model.scale.x) * this.facingSign
  }

  /** 飛走動畫位移的縮放倍率，讓總飛行距離 = distance 公尺；沒指定或動畫沒有位移時為 1 */
  _getFlyScale(distance) {
    const values = this.actions.fly?.getClip().rootMotion?.values
    if (!distance || !values?.length) return 1
    const total = Math.abs(values[values.length - 1]) * Math.abs(this.model.scale.x)
    return total > 1e-3 ? distance / total : 1
  }

  /**
   * 被抓住：進入受擊硬直且不會自己結束，受擊動畫播到第 stunFrame 幀（1 起算）就停住
   * 被打中（takeHit）或 release() 才解除
   */
  grab(stunFrame) {
    this.knockVelocity = 0
    this.hitStunFrames = Infinity
    this._setState('hit', true)
    this.grabFrame = stunFrame
    this.currentAction.setEffectiveTimeScale(0) // 動畫時間由 _syncGrabbedAnimation 控制
  }

  /** 放開：還被抓著的話回到站立 */
  release() {
    if (!this.grabFrame) return
    this.grabFrame = 0
    if (this.state !== 'hit') return
    this._setState('idle')
    this.currentAction.setEffectiveTimeScale(1) // 沒有受擊動作時，被停住的是 idle 本身
  }

  /** 跳躍中：起跳前、滯空、落地硬直，或人在空中（含空中出招、被打飛） */
  get isJumping() {
    return this.isAirborne || ['jumpStart', 'air', 'land'].includes(this.state)
  }

  get isGrabbed() {
    return !!this.grabFrame && this.state === 'hit'
  }

  _syncGrabbedAnimation() {
    if (!this.isGrabbed) return
    this.currentAction.time = Math.min(this.stateFrame, this.grabFrame - 1) / FPS
  }

  /** 招式的固定前進：第 from ~ to 幀每幀往面向方向前進 distance / 幀數；同一幀只走一次 */
  _applyAdvance() {
    const move = this.getCurrentMove()
    if (!move?.advance || this.advanceFrame === this.stateFrame) return
    const { from, to, distance } = move.advance
    const frame = this.moveFrame
    if (frame < from || frame > to) return
    this.advanceFrame = this.stateFrame
    this.x += this.facingSign * (distance / (to - from + 1))
  }

  /** 切換狀態並播放對應動作 */
  _setState(state, isRestart = false) {
    if (this.state === state && !isRestart) return
    this.state = state
    this.stateFrame = 0
    this.isRush = false
    if (state !== 'dash') this.rushAttack = null
    if (state === 'attack') {
      this.startedMove = true
      this.passPlan = null // dashThrough：{ startX, endX }，由 main.js 在穿越第 1 幀決定
      this.hitConfirmed = false
      // chainMirror：上一次同招命中才鏡像，鏡像只用一次
      this.isMirrored = !!this.moves[this.currentMove]?.chainMirror && this.nextMirror
      this.nextMirror = false
      this.chainKey = null
      this.recoveryCut = 0
      this.connected = false
      this.rushQueued = false
    }

    let actionKey = state
    if (state === 'attack') {
      this.hitWindow = -1
      this.advanceFrame = -1
      this.passCount = 1 // repeatOnHit：第幾次（再出一次時由 _checkPassFlow 加 1）
      this.stateLength = this._getMoveLength()
      actionKey = this.currentMove
    } else if (state === 'hit') {
      this.stateLength = this.hitStunFrames
      if (!this.actions.hit) actionKey = 'idle'
    } else if (state === 'block') {
      this.stateLength = this.blockStunFrames
      if (!this.actions.block) actionKey = 'idle'
    } else if (state === 'dash') {
      this.stateLength = this.dash.frames
      actionKey = 'dash'
    } else if (state === 'airDash') {
      this.stateLength = this.dash.frames
      actionKey = 'dash'
    } else if (state === 'land') {
      this.stateLength = this.jump.landing
      actionKey = 'jump'
    } else if (state === 'jumpStart' || state === 'air') {
      actionKey = 'jump'
    } else if (state === 'down') {
      this.flyFrames = this.getClipLength('fly')
      this.stateLength = this.flyFrames + this.getClipLength('getUp')
      actionKey = 'fly'
    }

    this._applyFacing() // 有 yaw / mirror 的招式：進出招式時切換

    const isOnce = ['attack', 'hit', 'down', 'block'].includes(state)
    this._play(actionKey, isOnce, isRestart || state === 'attack' || state === 'dash')
  }

  _play(key, isOnce, isRestart) {
    let next = this.actions[key]
    if (!next) return
    // 衝刺取消停頓中已經先播了衝刺動畫：接著播，不要從頭來
    if (this.keepRushAnim) {
      this.keepRushAnim = false
      if (next === this.currentAction) return
    }

    const prev = this.currentAction
    if (prev?.getClip() === next.getClip() && !isRestart) return
    // 出招 / 受擊重新播放同一個動作：改播另一個分身，從目前姿勢淡入（不會瞬間跳回第 0 幀）
    if (isRestart && prev && prev.getClip().name === next.getClip().name && ['attack', 'hit'].includes(this.state)) {
      next = this._getTwinAction(prev)
    }

    // 沒有後退動作時，walking 反方向播（LoopRepeat 會自動從結尾繞回）
    let timeScale = 1
    if (key === 'walk') timeScale = this.walkAnimSpeed
    if (key === 'walkBack') timeScale = this.hasWalkBackClip ? 1 : -this.walkAnimSpeed
    if (key === 'jump') timeScale = 0 // 跳躍動畫的時間由 _syncJumpAnimation 控制
    // 衝刺（地面 / 空中）：往後衝時倒著播
    if (key === 'dash') timeScale = (this.dashDir === this.facingSign ? 1 : -1) * this.dash.animSpeed

    next.reset()
    next.setEffectiveTimeScale(timeScale)
    next.setEffectiveWeight(1)
    next.setLoop(isOnce ? THREE.LoopOnce : THREE.LoopRepeat, Infinity)
    next.clampWhenFinished = true
    next.play()

    if (prev && prev !== next) prev.crossFadeTo(next, this.fadeTime, false)
    this.currentAction = next
  }

  /**
   * 畫面補間：邏輯只有 FPS 幀 / 秒，螢幕更新率較高時，畫面在前後兩個邏輯幀之間內插，看起來才不會頓
   * captureFrame：每推進 1 幀邏輯後呼叫，記下這幀所有骨頭的旋轉 / 位移與人物位置
   * applyInterpolation(alpha)：渲染前呼叫，alpha = 0 → 上一幀、1 → 這一幀
   * restoreFrame：渲染後呼叫，還原成這一幀，邏輯（判定框、root motion 等）不受補間影響
   * 面向（rotation.y）不補間，轉身維持瞬間完成
   */
  captureFrame() {
    if (!this.model) return
    if (!this.interp) {
      const bones = []
      this.model.traverse(obj => obj.isBone && bones.push(obj))
      const size = bones.length * 7 + 2
      this.interp = { bones, prev: new Float32Array(size), curr: new Float32Array(size), hasPrev: false }
    }

    const it = this.interp
    it.prev.set(it.curr)
    it.bones.forEach((bone, i) => {
      bone.quaternion.toArray(it.curr, i * 7)
      bone.position.toArray(it.curr, i * 7 + 4)
    })
    const o = it.bones.length * 7
    it.curr[o] = this.model.position.x
    it.curr[o + 1] = this.model.position.y

    if (!it.hasPrev) {
      it.prev.set(it.curr)
      it.hasPrev = true
    }
  }

  applyInterpolation(alpha) {
    const it = this.interp
    if (!it) return
    const { bones, prev, curr } = it
    const lerp = i => (alpha >= 1 ? curr[i] : prev[i] + (curr[i] - prev[i]) * alpha)

    bones.forEach((bone, i) => {
      const o = i * 7
      _qPrev.fromArray(prev, o)
      _qCurr.fromArray(curr, o)
      bone.quaternion.slerpQuaternions(_qPrev, _qCurr, Math.min(1, alpha))
      bone.position.set(lerp(o + 4), lerp(o + 5), lerp(o + 6))
    })
    const o = bones.length * 7
    this.model.position.x = lerp(o)
    this.model.position.y = lerp(o + 1)
  }

  restoreFrame() {
    this.applyInterpolation(1)
  }

  /** 同一個 clip 的另一個 AnimationAction（兩個輪流用），root motion 資料一起帶過去 */
  _getTwinAction(action) {
    if (!this.twinActions.has(action)) {
      const clip = action.getClip()
      const copy = clip.clone()
      copy.rootMotion = clip.rootMotion
      const twin = this.mixer.clipAction(copy)
      this.twinActions.set(action, twin)
      this.twinActions.set(twin, action)
    }
    return this.twinActions.get(action)
  }

  _applyFacing() {
    // Mixamo 人物預設面向 +Z，轉 ±90° 變成面向左右
    // 招式有 yaw / mirror 時：出招期間額外旋轉、左右鏡像（scale.x 取負，three.js 會自動處理反面）
    const move = this.getCurrentMove()
    const scale = Math.abs(this.model.scale.x)
    if (move?.faceCamera) {
      // 面向鏡頭（+Z）：面向右時鏡像、面向左時照原樣
      this.model.rotation.y = 0
      this.model.scale.x = this.faceRight ? -scale : scale
      return
    }
    const yaw = THREE.MathUtils.degToRad(move?.yaw ?? 0)
    this.model.rotation.y = (this.faceRight ? Math.PI / 2 : -Math.PI / 2) + yaw
    this.model.scale.x = move?.mirror || (move && this.isMirrored) ? -scale : scale
  }

  /**
   * 命中後的處理（由 main.js 在命中時呼叫，防禦住不算）
   */
  onHitConfirm() {
    const move = this.getCurrentMove()
    if (!move) return
    this.hitConfirmed = true
  }

  /** 預約：chainCancel 招式的預約時段內，按任何攻擊 / 絕招鍵 */
  _canChain(key) {
    return !!key && !!this.actions[key] && this._inQueueWindow()
  }

  /** 預約時段：攻擊判定第 1 幀的前 chainEarly 幀 ~ 攻擊判定最後 1 幀（幀數表編號） */
  _inQueueWindow() {
    const move = this.getCurrentMove()
    if (!move?.chainCancel || move.hits) return false
    const firstActive = move.startup + 1
    const lastActive = this.stateLength - (move.recovery - this.recoveryCut)
    const frame = this.moveFrame
    return frame >= firstActive - (move.chainEarly ?? 5) && frame <= lastActive
  }

  /** 有預約、而且碰到對手了：收招少 chainCancel 幀（只縮一次，攻擊判定幀不變） */
  _applyChainCut() {
    const move = this.getCurrentMove()
    if (!move?.chainCancel || !this.chainKey || !this.connected || this.recoveryCut) return
    this.recoveryCut = Math.max(0, Math.min(move.chainCancel, this.stateLength - this.stateFrame - 1))
    this.stateLength -= this.recoveryCut
  }

  /** 能否預約衝刺取消：chainCancel 招式照預約時段，其他可衝刺取消的招式在前搖或攻擊判定期間 */
  _canQueueRush() {
    if (this.state !== 'attack' || !this.rush.moves.includes(this.currentMove)) return false
    if (this.getCurrentMove().chainCancel) return this._inQueueWindow()
    return this._getAttackPhase() !== 'recovery'
  }

  /** 還要幾幀才能自由行動；空中、站立等沒有固定長度的狀態回傳 Infinity / 0（輸入預約用） */
  get framesUntilFree() {
    if (this.canAct) return 0
    if (this.state === 'attack' && this.isAirborne) return Infinity // 空中出招要等落地，不能預約接下一招 / 絕招
    if (['attack', 'hit', 'block', 'dash', 'land', 'down'].includes(this.state)) return this.stateLength - this.stateFrame
    if (this.state === 'jumpStart') return Infinity
    return Infinity
  }

  /** 打到邊界的對手時的後退：跟擊退一樣每秒衰減 e^-8 */
  _updatePushback() {
    if (!this.pushVelocity) return
    this.x += this.pushVelocity * STEP
    this.pushVelocity *= Math.exp(-8 * STEP)
    if (Math.abs(this.pushVelocity) < 0.01) this.pushVelocity = 0
  }

  /** 這一幀能否衝刺取消：可衝刺取消的招式碰到對手（打中或被防禦）後、招式還沒結束 */
  get canRush() {
    return this.state === 'attack' && this.connected && this.rush.moves.includes(this.currentMove)
  }

  /** 衝刺取消：發光 + 往前衝刺（距離 / 幀數同「前前」），衝刺中可以出招 */
  _startRush() {
    this.rushQueued = false
    const rushAttack = this.rushAttack
    this.dashDir = this.facingSign
    this._setState('dash')
    this.isRush = true
    this.rushAttack = rushAttack
    if (this.glowFrame <= 0) this.startGlow()
    this._dashStep() // 進入衝刺的這一幀也要移動
  }

  /** 中斷所有動作回到站立：狀態、位移速度、預約、發光 / 紅光、動畫全部重置（位置保留） */
  resetToIdle() {
    this.y = 0
    this.vx = 0
    this.vy = 0
    this.isAirborne = false
    this.isJumpArc = false
    this.knockVelocity = 0
    this.pushVelocity = 0
    this.grabFrame = 0
    this.chainKey = null
    this.queuedAttack = null
    this.rushQueued = false
    this.usedRush = false
    this.keepRushAnim = false
    this.rushAttack = null
    this.isRush = false
    this.isMirrored = false
    this.nextMirror = false
    this.isStateHeld = false
    this.flashFrame = 0
    this.glowFrame = 0
    this._applyFlash(0)
    this._applyGlow(0)

    this.mixer.stopAllAction()
    this.currentAction = null // 不從舊動作淡出，直接切到站立
    this.state = ''
    this._setState('idle')
    this.mixer.update(0)
    if (this.model) this.model.position.z = 0
    // 畫面補間：前後兩幀都設成現在的姿勢，避免補間到重置前的姿勢
    this.captureFrame()
    this.captureFrame()
  }

  /** dashThrough 穿越中（main.js 這段期間不推擠） */
  get isPassing() {
    return this.isDashing && !this.isLastPassStop
  }

  /** dashThrough 衝刺中（第 from ~ to 幀） */
  get isDashing() {
    const d = this.getCurrentMove()?.dashThrough
    if (!d) return false
    const frame = this.moveFrame
    return frame >= d.from && frame <= d.to
  }

  /** dashThrough 的 lastNoPass：repeatOnHit 最後一次不穿越，停在對手面前 */
  get isLastPassStop() {
    return !!this.getCurrentMove()?.dashThrough?.lastNoPass && this.isLastPass
  }

  /** repeatOnHit 的最後一次（沒有 repeatOnHit 的招式一律算最後一次） */
  get isLastPass() {
    return this.passCount >= (this.getCurrentMove()?.repeatOnHit?.times ?? 1)
  }

  /** dashThrough 沒碰到對手：穿越結束 missEnd 幀後直接結束招式 */
  _checkDashThroughMiss() {
    const d = this.getCurrentMove()?.dashThrough
    if (!d || d.missEnd == null || this.connected) return
    if (this.moveFrame > d.to + d.missEnd) this._setState(this.isAirborne ? 'air' : 'idle')
  }

  /** repeatOnHit：這次打中，第 at 幀後轉身面向對手、從頭再出一次（最多 times 次） */
  _checkPassFlow() {
    const move = this.getCurrentMove()
    const r = move?.repeatOnHit
    if (!r || this.passCount >= (r.times ?? 2) || !this.hitConfirmed || this.moveFrame <= r.at) return
    const next = this.passCount + 1
    this.faceRight = !this.faceRight // 已經穿到對手另一側
    this._setState('attack', true)
    this.passCount = next
    this.stateLength = this._getMoveLength()
    // 第二次起跳過 firstPassDelay：動畫從同一個姿勢開始
    this.currentAction.time = (move.firstPassDelay ?? 0) / FPS
  }

  /** 招式的幀數表編號（1 起算）；repeatOnHit 第一次有 firstPassDelay 時，招式數據要往後挪這麼多幀 */
  get moveFrame() {
    const delay = this.passCount === 1 ? (this.getCurrentMove()?.firstPassDelay ?? 0) : 0
    return this.stateFrame + 1 - delay
  }

  /** 招式總幀數：動畫長度，有 length 時取較短的；第一次再加 firstPassDelay */
  _getMoveLength() {
    const move = this.moves[this.currentMove]
    const delay = this.passCount === 1 ? (move.firstPassDelay ?? 0) : 0
    const clipLength = this.getClipLength(this.currentMove)
    const offset = this.passCount === 1 ? 0 : (move.firstPassDelay ?? 0) // 第二次起動畫從 firstPassDelay 開始播
    return Math.min(clipLength - offset, (move.length ?? Infinity) + delay)
  }

  /** 衝刺取消中、已過了不能出招的前 lockFrames 幀 */
  get isRushReady() {
    return this.state === 'dash' && this.isRush && this.stateFrame >= this.rush.lockFrames
  }

  /** 衝刺取消停頓中先播衝刺動畫；人不移動，由 main.js 在停頓期間推進動畫時間 */
  startRushAnim() {
    const next = this.actions.dash // 衝刺取消一律往前
    if (!next) return
    const prev = this.currentAction
    next.reset()
    next.setEffectiveTimeScale(this.dash.animSpeed)
    next.setEffectiveWeight(1)
    next.setLoop(THREE.LoopRepeat, Infinity)
    next.play()
    if (prev && prev !== next) prev.crossFadeTo(next, this.fadeTime, false)
    this.currentAction = next
    this.keepRushAnim = true
  }

  /** 開始發光（按下衝刺取消的瞬間，頓幀期間也維持發光） */
  startGlow() {
    this.glowFrame = Math.round(this.rush.glowTime * FPS)
    this._applyGlow(this.rush.glowStrength)
  }

  /** 衝刺取消的發光：疊加自發光，最後 1/3 的時間淡出 */
  _updateGlow() {
    if (this.glowFrame <= 0) return
    this.glowFrame--
    const total = Math.round(this.rush.glowTime * FPS)
    const fade = Math.max(1, total / 3)
    this._applyGlow(Math.min(1, this.glowFrame / fade) * this.rush.glowStrength)
  }

  _applyGlow(k) {
    const glow = new THREE.Color(this.rush.glowColor)
    this.materials.forEach(({ material, emissive }) => {
      if (!emissive) return
      material.emissive.copy(emissive).lerp(glow, k)
    })
  }

  /**
   * 受擊紅光：壓低材質顏色的綠、藍讓貼圖偏紅，再疊一點紅色自發光，線性淡出
   * 自發光不能太強：深色貼圖（如 Erika）會被紅色蓋過，整個人變紅
   */
  _updateFlash() {
    if (this.flashFrame <= 0) return
    this.flashFrame--
    this._applyFlash(this.flashFrame / this.flashFrames)
  }

  /** amount 0~1：貼圖偏紅 + 淡淡的紅色自發光（衝刺取消發光中就不蓋過它） */
  _applyFlash(amount) {
    const k = amount * this.flashStrength
    const red = new THREE.Color(0xff2020)
    this.materials.forEach(({ material, color, emissive }) => {
      material.color.setRGB(color.r, color.g * (1 - k), color.b * (1 - k))
      if (emissive && this.glowFrame <= 0) material.emissive.copy(emissive).lerp(red, amount * this.flashGlow)
    })
  }
}
