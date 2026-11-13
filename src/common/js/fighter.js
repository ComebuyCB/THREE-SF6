import * as THREE from 'three'
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js'

// 遊戲邏輯固定 30 幀 / 秒，幀數表與招式數據都以此為單位
export const FPS = 30
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
 * update() 每呼叫一次 = 1 幀（1/30 秒）
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
      moveSpeed: 1.5, // 公尺 / 秒
      backSpeedRate: 0.8, // 後退速度比例
      pushHalfWidth: 0.25, // 推擠範圍半寬（公尺）
      fadeTime: 0.1,
      /**
       * 招式數據（幀）：總幀數 = 動畫長度；前搖 startup、收招 recovery，中間全部是攻擊判定
       * hitStun：命中後對手的硬直幀數
       * knockback：擊退初速（公尺 / 秒，約退 knockback / 8 公尺）
       * hitInterval：多段攻擊，每幾幀算一段，每段最多命中一次；沒填 = 整段只命中一次
       * rootMotion：攻擊判定期間套用動畫本身的前後位移
       * launch：最後一段命中時把對手打飛（飛走 → 起身）
       * isSuper：絕招，出招時有鏡頭演出；GUI「招式選取」只列出絕招
       * lockTarget：命中後把對手吸附在面前，直到被打飛或招式結束
       * hitBones：攻擊判定掛在哪些骨頭，沒填用預設的雙手
       * key 要和 main.js anims 的 key 相同（動畫長度 = 總幀數）
       */
      moves: {
        // startup = 發生幀 - 1（快打的「發生 10F」= 第 10 幀第一次有攻擊判定）
        light: { name: '輕攻擊', startup: 9, recovery: 20, hitStun: 20, knockback: 1.5 },
        heavy: { name: '重攻擊', startup: 14, recovery: 20, hitStun: 25, knockback: 2.5 },
        dog_bear: { name: 'dog_bear', isSuper: true, startup: 19, recovery: 40, hitStun: 30, knockback: 0, hitInterval: 20, rootMotion: true, launch: true, lockTarget: true },
        // 以下絕招數據先用預設值，之後再依動畫調整
        kick_ball: { name: 'kick_ball', isSuper: true, startup: 19, recovery: 40, hitStun: 30, knockback: 2, rootMotion: true, launch: true, hitBones: ['LeftFoot', 'RightFoot'] },
        monkey_turn: { name: 'monkey_turn', isSuper: true, startup: 19, recovery: 40, hitStun: 30, knockback: 2, rootMotion: true, launch: true },
        shake_head: { name: 'shake_head', isSuper: true, startup: 19, recovery: 40, hitStun: 30, knockback: 2, rootMotion: true, launch: true },
        dodge_step: { name: 'dodge_step', isSuper: true, startup: 19, recovery: 40, hitStun: 30, knockback: 2, rootMotion: true, launch: true },
      },
      hitBones: ['LeftHand', 'RightHand'], // 預設攻擊判定骨頭
      /**
       * 跳躍（幀）：起跳前 prejump → 滯空 air → 落地硬直 landing
       * 高度 = heightRate × 身高（腳底離地），用拋物線計算
       * animTakeoff / animLand：Jumping 動畫裡雙腳離地、落地的幀，用來把動畫對到上面三段
       */
      jump: {
        prejump: 4,
        air: 45,
        landing: 5,
        heightRate: 1.5,
        forwardSpeed: 1.6, // 斜跳水平速度（公尺 / 秒）
        backSpeed: 1.4,
        animTakeoff: 11,
        animLand: 31,
      },
      // 衝刺：前前 / 後後，固定 frames 幀內移動 distance 公尺，期間不能出招、不能防禦
      dash: {
        frames: 15,
        forwardDistance: 1.2,
        backDistance: 1,
        animSpeed: 2, // 沒有衝刺動畫，走路動畫加速播放
      },
      blockStun: 5, // 防禦硬直（幀）
      blockPush: 1.5, // 防禦時往後滑的初速（公尺 / 秒）
      hitRadius: 0.1,
      flashStrength: 0.3, // 受擊偏紅程度（0~1）：綠、藍色最多壓掉多少比例，刻意調淡
      flashFrames: 6,
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
    this.flashFrame = 0
    this.materials = [] // { material, color }：clone 過的材質與原本的顏色
    this.hurtboxParts = [] // { box, bones, pad, helper }
    this.hitParts = [] // { name, sphere, bone, helper }：所有招式用到的骨頭，出招時只啟用該招的部分
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

  /** 倒地（飛走 + 起身）期間無敵 */
  get isInvincible() {
    return this.state === 'down'
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

    const canAirAttack = this.state === 'air' && !this.hasAirAttacked && input.attack && this.actions[input.attack] && !this.moves[input.attack]?.isSuper

    if (this.state === 'dash') {
      this._dashStep()
    } else if (this.state === 'hit' || this.state === 'block') {
      this.x += this.knockVelocity * STEP
      this.knockVelocity *= Math.exp(-8 * STEP)
    } else if (canAirAttack) {
      // 空中攻擊：先沿用地面的輕 / 重攻擊動畫，一次跳躍只能出一招
      this.hasAirAttacked = true
      this.currentMove = input.attack
      this._setState('attack')
    } else if (this.canAct) {
      if (input.attack && this.actions[input.attack]) {
        this.startMove(input.attack)
        this.isStateHeld = false
      } else if (input.dash) {
        this.dashDir = input.dash
        this._setState('dash')
        this._dashStep() // 進入衝刺的這一幀也要移動，15 幀才會剛好走完全程
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

    const action = this.currentAction
    const prevTime = action.time
    this.mixer.update(STEP)
    this._applyRootMotion(action, prevTime)
    this._updateFlash()
  }

  /** 出招；停在第 0 幀，下一次 update 才開始算（絕招演出時先呼叫這個再凍結畫面） */
  startMove(key) {
    this.currentMove = key
    this._setState('attack')
    this.isStateHeld = true
    this.mixer.update(0) // 讓姿勢立刻變成招式第 0 幀
  }

  /** 防禦住攻擊：播防禦動作、往後滑一點，硬直固定 blockStun 幀 */
  takeBlock(fromX) {
    const away = this.x >= fromX ? 1 : -1
    this.knockVelocity = away * this.blockPush
    this._setState('block', true)
  }

  /** 目前招式的數據（出招中才有） */
  getCurrentMove() {
    return this.state === 'attack' ? this.moves[this.currentMove] : null
  }

  /**
   * 幀數表用的目前幀類型
   * @returns {'startup' | 'active' | 'recovery' | 'stun' | 'block' | 'dash' | 'down' | null} null 代表可自由行動（跳躍中也算）
   */
  getFrameType() {
    if (this.state === 'hit') return 'stun'
    if (this.state === 'block') return 'block'
    if (this.state === 'land') return 'recovery'
    if (this.state === 'dash') return 'dash'
    if (this.state === 'down') return 'down'
    if (this.state !== 'attack') return null

    const { startup, recovery } = this.moves[this.currentMove]
    if (this.stateFrame < startup) return 'startup'
    if (this.stateFrame >= this.stateLength - recovery) return 'recovery'
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
    this.hitParts.forEach(part => {
      part.bone.getWorldPosition(part.sphere.center)
      part.helper.position.copy(part.sphere.center)
      part.helper.visible = isHitActive && activeBones.includes(part.name)
    })

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
    return this.hitParts
      .filter(hit => activeBones.includes(hit.name))
      .some(hit => target.hurtboxParts.some(hurt => hurt.box.intersectsSphere(hit.sphere)))
  }

  /**
   * 記錄這一段已命中
   * @returns {boolean} 是否要把對手打飛（launch 招式的最後一段）
   */
  registerHit() {
    const { index, count } = this._getHitWindow()
    this.hitWindow = index
    return !!this.moves[this.currentMove].launch && index === count - 1
  }

  /**
   * 被打中：中斷目前動作、擊退或打飛、閃紅光
   * @param {number} fromX 攻擊方位置，決定擊退方向
   * @param {{ hitStun: number, knockback: number }} move 攻擊方的招式數據
   * @param {boolean} isLaunch 打飛：播飛走 + 起身，期間無敵（空中被打到也一律打飛）
   */
  takeHit(fromX, move, isLaunch = false) {
    this.flashFrame = this.flashFrames
    this.knockVelocity = 0

    if ((isLaunch || this.isAirborne) && this.actions.fly) {
      if (this.isJumpArc) {
        // 從跳躍拋物線切到自由落下，延續當下的垂直速度
        const { speed, gravity } = this._getJumpPhysics()
        this.vy = speed - gravity * (this.airFrame / FPS)
        this.isJumpArc = false
      }
      this.vx = 0
      this._setState('down', true)
      return
    }

    const away = this.x >= fromX ? 1 : -1
    this.knockVelocity = away * move.knockback
    this.hitStunFrames = move.hitStun
    this._setState('hit', true)
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
        if (copy.color) this.materials.push({ material: copy, color: copy.color.clone() })
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
    }
    this.hasWalkBackClip = !!clips.walkBack

    Object.entries(map).forEach(([key, clip]) => {
      if (clip) this.actions[key] = this.mixer.clipAction(clip)
    })

    Object.entries(this.moves).forEach(([key, { startup, recovery }]) => {
      const length = this.getClipLength(key)
      if (length && length <= startup + recovery) {
        console.warn(`[${this.name}] ${key} 動畫只有 ${length} 幀，扣掉前搖 ${startup} 與收招 ${recovery} 後沒有攻擊判定`)
      }
    })
  }

  _setupBoxes() {
    const getBone = name => this.model.getObjectByName(`${BONE_PREFIX}${name}`)

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
    } else if (this.stateFrame >= this.stateLength) {
      // 空中出招結束還沒落地：回到滯空姿勢
      this._setState(this.isAirborne && this.state === 'attack' ? 'air' : 'idle')
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
   * 段數 = 攻擊判定幀數 / hitInterval（無條件捨去），餘數併入最後一段，避免最後一段只剩 1、2 幀
   */
  _getHitWindow() {
    const move = this.moves[this.currentMove]
    if (!move?.hitInterval) return { index: 0, count: 1 }

    const activeLength = this.stateLength - move.startup - move.recovery
    const count = Math.max(1, Math.floor(activeLength / move.hitInterval))
    const index = Math.min(count - 1, Math.floor((this.stateFrame - move.startup) / move.hitInterval))
    return { index, count }
  }

  /** 跳躍拋物線：最高點 h、滯空 T 秒 → 重力 8h/T²、起跳速度 4h/T */
  _getJumpPhysics() {
    const h = this.jump.heightRate * this.characterHeight
    const T = this.jump.air / FPS
    return { gravity: (8 * h) / T ** 2, speed: (4 * h) / T }
  }

  /** 衝刺 1 幀的位移：全程平均分到每一幀 */
  _dashStep() {
    const { frames, forwardDistance, backDistance } = this.dash
    const distance = this.dashDir === this.facingSign ? forwardDistance : backDistance
    this.x += this.dashDir * (distance / frames)
  }

  _takeOff() {
    const { forwardSpeed, backSpeed } = this.jump
    const dir = this.jumpDir
    this.isAirborne = true
    this.hasAirAttacked = false
    this.airFrame = 0
    this.isJumpArc = true
    this.vy = this._getJumpPhysics().speed
    this.vx = dir * (dir === this.facingSign ? forwardSpeed : backSpeed)
    this._setState('air')
  }

  /** 空中物理：拋物線、水平速度；腳底碰地就落地（被打飛也一樣會落下） */
  _updateAirborne() {
    if (!this.isAirborne) return
    this.airFrame++
    this.x += this.vx * STEP

    if (this.isJumpArc) {
      // 跳躍用公式算高度，最高點剛好 = 目標高度、第 air 幀剛好落地（逐幀累加速度會有誤差）
      const p = this.airFrame / this.jump.air
      this.y = this.jump.heightRate * this.characterHeight * 4 * p * (1 - p)
    } else {
      // 空中被打飛：從當下的速度自由落下
      this.y += this.vy * STEP
      this.vy -= this._getJumpPhysics().gravity * STEP
    }
    if (this.y > 0) return

    this.y = 0
    this.vx = 0
    this.vy = 0
    this.isAirborne = false
    this.isJumpArc = false
    // 被打飛時讓飛走動畫繼續播；跳躍或空中出招則進入落地硬直
    if (this.state === 'air' || this.state === 'attack') this._setState('land')
  }

  /** 跳躍動畫不照時間播，而是依「起跳前 / 滯空 / 落地」的進度對到動畫裡相對的位置 */
  _syncJumpAnimation() {
    if (!['jumpStart', 'air', 'land'].includes(this.state)) return
    const action = this.actions.jump
    const { prejump, air, landing, animTakeoff, animLand } = this.jump
    const end = this.getClipLength('jump')
    const lerp = (from, to, r) => from + (to - from) * Math.min(1, r)

    let frame = lerp(animLand, end, this.stateFrame / landing)
    if (this.state === 'jumpStart') frame = lerp(0, animTakeoff, this.stateFrame / prejump)
    else if (this.state === 'air') frame = lerp(animTakeoff, animLand, this.airFrame / air)
    // 動畫速度設為 0（見 _setState），mixer.update 不會再推進時間
    action.time = frame / FPS
  }

  /** root motion：把動畫臀部的前後位移轉成人物座標（動畫本身已改成原地播放） */
  _applyRootMotion(action, prevTime) {
    const curve = action.getClip().rootMotion
    if (!curve) return

    const isOn = this.state === 'down'
      ? action === this.actions.fly
      : this.state === 'attack' && this.moves[this.currentMove].rootMotion && this.getFrameType() === 'active'
    if (!isOn) return

    const delta = sampleCurve(curve, action.time) - sampleCurve(curve, prevTime)
    // 動畫的前方是模型的 +Z，轉成世界座標的面向方向
    this.x += delta * this.model.scale.x * this.facingSign
  }

  /** 切換狀態並播放對應動作 */
  _setState(state, isRestart = false) {
    if (this.state === state && !isRestart) return
    this.state = state
    this.stateFrame = 0

    let actionKey = state
    if (state === 'attack') {
      this.hitWindow = -1
      this.stateLength = this.getClipLength(this.currentMove)
      actionKey = this.currentMove
    } else if (state === 'hit') {
      this.stateLength = this.hitStunFrames
      if (!this.actions.hit) actionKey = 'idle'
    } else if (state === 'block') {
      this.stateLength = this.blockStun
      if (!this.actions.block) actionKey = 'idle'
    } else if (state === 'dash') {
      this.stateLength = this.dash.frames
      actionKey = this.dashDir === this.facingSign ? 'walk' : 'walkBack'
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

    const isOnce = ['attack', 'hit', 'down', 'block'].includes(state)
    this._play(actionKey, isOnce, isRestart || state === 'attack' || state === 'dash')
  }

  _play(key, isOnce, isRestart) {
    const next = this.actions[key]
    if (!next) return

    const prev = this.currentAction
    if (prev === next && !isRestart) return

    // 沒有後退動作時，walking 以 -1 倍速倒著播（LoopRepeat 會自動從結尾繞回）
    let timeScale = key === 'walkBack' && !this.hasWalkBackClip ? -1 : 1
    if (key === 'jump') timeScale = 0 // 跳躍動畫的時間由 _syncJumpAnimation 控制
    if (this.state === 'dash') timeScale *= this.dash.animSpeed

    next.reset()
    next.setEffectiveTimeScale(timeScale)
    next.setEffectiveWeight(1)
    next.setLoop(isOnce ? THREE.LoopOnce : THREE.LoopRepeat, Infinity)
    next.clampWhenFinished = true
    next.play()

    if (prev && prev !== next) prev.crossFadeTo(next, this.fadeTime, false)
    this.currentAction = next
  }

  _applyFacing() {
    // Mixamo 人物預設面向 +Z，轉 ±90° 變成面向左右
    this.model.rotation.y = this.faceRight ? Math.PI / 2 : -Math.PI / 2
  }

  /**
   * 受擊紅光：壓低材質顏色的綠、藍讓貼圖偏紅，線性淡出
   * 不用 emissive 疊紅色：深色貼圖（如 Erika）會被固定的紅色蓋過，整個人變紅
   */
  _updateFlash() {
    if (this.flashFrame <= 0) return
    this.flashFrame--
    const k = (this.flashFrame / this.flashFrames) * this.flashStrength

    this.materials.forEach(({ material, color }) => {
      material.color.setRGB(color.r, color.g * (1 - k), color.b * (1 - k))
    })
  }
}
