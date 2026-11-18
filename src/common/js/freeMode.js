import * as THREE from 'three'
import { MeshBVH, acceleratedRaycast } from 'three-mesh-bvh'

const DOWN = new THREE.Vector3(0, -1, 0)

/**
 * FreeMode：自由模式，人物在 3D 場景裡前後左右自由跑動；打架用跟格鬥模式同一套戰鬥流程（combat.js）
 *
 * 移動（自由狀態，由這裡控制）：
 * - 方向以鏡頭為準：P1 W / A / S / D、P2 ↑ / ← / ↓ / →；人物轉向移動方向，播跑步動畫（run）
 * - 碰撞只擋牆：往移動方向發射線，碰到場景就沿著牆滑開；地面維持 y = 0（不跟地形高低）
 * - 留在場景內：腳下（往前一點）往下沒有場景模型 = 場景邊緣，擋住不能走出去；沒有場景時限制在 |x|、|z| ≤ bounds 的方框內
 * - 推擠框跟著人物走：兩人重疊時各退一半
 *
 * 戰鬥（交給 Combat，空間規則是本檔的 PlaneSpace）：
 * - Fighter 的格鬥邏輯只看 x：每個人有自己的方向 dir（格鬥邏輯的 +x），x 的變化換成沿著 dir 移動，也會被牆擋住
 * - 出招、衝刺取消（0）、跳躍（P1 空白鍵）、衝刺、受擊 / 防禦硬直期間由格鬥邏輯控制，能自由行動且沒有要做的事就交還給自由移動
 * - 出招朝自己面向；被打中的人轉向攻擊方，擊退 / 擊飛沿著攻擊方的方向；被擊飛撞到場景物體就反彈（launch.wallBounce）
 * - 防禦：不用另外按，攻擊打中的那一幀如果正往離開對手的方向移動（跟「朝對手」的夾角 90° 以上）就擋住（防禦動畫、防禦硬直）
 *   平常照常跑，不會因為要防禦而被卡住；GUI「P2 木樁防禦」打開時 P2 原地防禦
 * - 衝刺：同一個方向鍵 dashTapWindow 毫秒內連按兩下（往那個方向）、或 0 鍵（往移動方向，沒在移動就往面向）
 *   動作換成 dashStyle.anim（FastRun），位移是格鬥模式的 dashStyle.speedRate 倍；衝刺快結束前再連按可以接著衝（換方向也行）
 * - 絕招沒有鏡頭演出：從動畫開頭直接播，原本演出凍結的幀數另一名角色凍結不動（Combat.freeze）
 * - 招式有 aimOpponent（例如風擺柳碎布）：放招時朝向對手；穿越（閃身步）每次穿越開始時對準對手
 *
 * AI：離對手 aiFight.engageDistance 內用格鬥模式的 AI（ai.js，對手換算到自己的方向上），遠的時候隨意走動，
 *     每段有 chaseRate 的機率追對手，撞到東西換方向
 *
 * 鏡頭：跟著 P1（C 切換 P1 / P2，注視點平滑移過去），距離與角度不變，滑鼠照常轉動 / 縮放
 *   進入時平滑轉成俯角 enterPitch 度、距離拉遠成 enterZoom 倍；V 鎖定對手（滑鼠左鍵拖曳時解除）
 *
 * 場景模型很大，射線用 three-mesh-bvh 加速（第一次進自由模式時替場景網格建 BVH，之後沿用）
 */
export class FreeMode {
  constructor(options) {
    const def = {
      camera: null,
      controls: null,
      combat: null, // 共用的戰鬥流程（combat.js）
      aiThink: null, // (slot, self, opponentInLine) → 格鬥模式 AI 的輸入（main.js 的 FighterAI）
      isStandGuard: null, // (slot) → 一直原地防禦（GUI「P2 木樁防禦」）
      runSpeed: 4, // 跑步速度（公尺 / 秒）
      turnSpeed: 12, // 轉向速度：越大轉越快
      radius: 0.3, // 人物擋牆半徑（公尺）
      rayHeights: [0.4, 1.2], // 擋牆射線的高度（公尺）：膝蓋、胸口
      groundRay: { from: 3, length: 6 }, // 場景邊緣偵測：從多高（公尺）往下找地面、找多遠
      followHeight: 1, // 鏡頭注視點在人物腳底上方多高（公尺）
      switchTime: 0.6, // C 切換跟隨的人：注視點移過去的秒數
      enterPitch: 30, // 進入自由模式時的鏡頭俯角（度）
      enterZoom: 2, // 進入自由模式時鏡頭距離 × 這個倍率（稍微拉遠）
      enterTime: 0.6, // 進入自由模式時鏡頭轉過去的秒數
      lockOnTurnSpeed: 6, // 鎖定對手時鏡頭轉過去的速度：越大越快
      fps: 60, // 格鬥邏輯的幀率（同 fighter.js）
      overheadRate: 0.8, // 高度差超過身高的這個比例就不推擠（越過頭頂）
      dashTapWindow: 250, // 連按兩下方向鍵的間隔（毫秒）內算衝刺
      dashStyle: { anim: 'fastRun', speedRate: 2 }, // 自由模式的衝刺：動作、位移倍率（相對格鬥模式）
      jumpSpeedRate: 2, // 自由模式斜跳的水平速度倍率（相對格鬥模式；跳的高度、滯空時間不變）
      // AI 隨意走動：每段跑多久、停多久（秒，範圍內隨機）
      wander: { moveTime: [1, 3], idleTime: [0.5, 2] },
      // AI 打架：遠的時候每段移動有 chaseRate 的機率追對手；離對手 engageDistance 公尺內改用格鬥模式的 AI
      aiFight: { chaseRate: 0.1, engageDistance: 5 },
      keys: {
        p1: { forward: 'KeyW', back: 'KeyS', left: 'KeyA', right: 'KeyD', jump: 'Space' },
        p2: { forward: 'ArrowUp', back: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight' },
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

    // 4. setup runtime state
    this.isActive = false
    this.fighters = {} // { p1, p2 }
    // slot → { dir（格鬥邏輯的 +x 方向）, localRot（格鬥邏輯裡的轉向）, isEngine（由格鬥邏輯控制）, isJumpHeld,
    //          lastTap（連按判斷）, tapDash（這幀連按出的衝刺方向）, queuedDashDir（衝刺中預約的下一段方向）, wander }
    this.states = {}
    this.accumulator = 0 // 尚未消化的時間，累積滿 1 幀推進格鬥邏輯
    this.env = null // 場景模型（沒有場景 = 用 bounds 方框）
    this.bounds = null // 沒有場景時的範圍：|x|、|z| ≤ bounds（公尺）；null = 不限制
    this.followSlot = 'p1' // 鏡頭跟著誰
    this.followBlend = null // 切換跟隨中：{ from（注視點起點）, t（0 ~ 1） }
    this.offsetBlend = null // 進入時的鏡頭轉向：{ from, to（鏡頭相對注視點的位置）, t }
    this.isLockOn = false // V：鏡頭鎖定對手
    this.interpolated = [] // 這個畫面做了補間的人（渲染後還原）
    this.raycaster = new THREE.Raycaster()
    this.raycaster.firstHitOnly = true
    this.forward = new THREE.Vector3()
    this.right = new THREE.Vector3()
    this.input = new THREE.Vector3()
    this.step = new THREE.Vector3()
    this.origin = new THREE.Vector3()
    this.normal = new THREE.Vector3()
    this.space = new PlaneSpace(this) // 給 Combat 用的空間規則
  }

  // public

  /** 進入自由模式：env = 目前的 3D 場景模型（可為 null） */
  enter(fighters, env) {
    this.isActive = true
    this.fighters = fighters
    this.states = Object.fromEntries(Object.entries(fighters).map(([slot, f]) => [slot, {
      dir: this._getFacingDir(f),
      localRot: Math.PI / 2,
      isEngine: false,
      isJumpHeld: false,
      lastTap: { code: '', time: 0 },
      tapDash: null,
      queuedDashDir: null,
      wander: { dir: new THREE.Vector3(), time: 0, isMoving: false, isChasing: false },
    }]))
    this.accumulator = 0
    this.setEnv(env)
    Object.values(fighters).forEach(f => {
      f.isFreeFacing = true
      f.isGuarding = false
      f.dashStyle = this.dashStyle
      f.jumpSpeedRate = this.jumpSpeedRate
      f.playLoop('idle')
    })

    // 鏡頭：注視點平滑移到 P1，角度轉成俯角 enterPitch、距離拉遠成 enterZoom 倍（水平方向不變）
    this.followSlot = 'p1'
    this.followBlend = { from: this.controls.target.clone(), t: 0 }
    const offset = this.camera.position.clone().sub(this.controls.target)
    const dist = offset.length() * this.enterZoom
    const flat = offset.clone().setY(0)
    if (flat.lengthSq() < 1e-6) flat.set(0, 0, 1)
    flat.normalize()
    const pitch = THREE.MathUtils.degToRad(this.enterPitch)
    const to = flat.multiplyScalar(dist * Math.cos(pitch)).setY(dist * Math.sin(pitch))
    this.offsetBlend = { from: offset, to, t: 0 }
  }

  exit() {
    Object.values(this.fighters).forEach(f => {
      f.isFreeFacing = false
      f.dashStyle = null
      f.jumpSpeedRate = 1
    })
    this.isActive = false
    this.isLockOn = false
    this.fighters = {}
    this.states = {}
    this.env = null
  }

  /** 換擋牆用的場景（自由模式中切換場景時） */
  setEnv(env) {
    this.env = env
    if (env) this._buildBVH(env)
  }

  /** V：鏡頭鎖定對手（再按一次解除）：鏡頭水平轉到跟隨的人背後，畫面朝向對手 */
  toggleLockOn() {
    this.setLockOn(!this.isLockOn)
  }

  /** 鎖定 / 解除鎖定對手（滑鼠左鍵拖曳轉鏡頭時由 main.js 解除） */
  setLockOn(isOn) {
    if (!this.isActive || this.isLockOn === isOn) return
    this.isLockOn = isOn
    this.offsetBlend = null
  }

  /** C：鏡頭改跟另一個人（注視點平滑移過去，距離、角度不變） */
  switchFollow() {
    if (!this.isActive) return
    this.followSlot = this.followSlot === 'p1' ? 'p2' : 'p1'
    this.followBlend = { from: this.controls.target.clone(), t: 0 }
  }

  /** 方向鍵按下（main.js 轉來）：同一個鍵 dashTapWindow 毫秒內連按兩下 = 往那個方向衝刺 */
  onKeyDown(code, time) {
    if (!this.isActive) return
    Object.entries(this.keys).forEach(([slot, keys]) => {
      if (![keys.forward, keys.back, keys.left, keys.right].includes(code)) return
      const st = this.states[slot]
      if (!st) return
      if (st.lastTap.code === code && time - st.lastTap.time <= this.dashTapWindow) {
        st.tapDash = code
        st.lastTap = { code: '', time: 0 }
      } else {
        st.lastTap = { code, time }
      }
    })
  }

  /** Esc：立刻取消所有出拳、招式、吸附、凍結；位置與面向保留，回到站立、交還給自由移動 */
  cancelAll() {
    if (!this.isActive) return
    this.combat.reset()
    Object.entries(this.fighters).forEach(([slot, fighter]) => {
      const model = fighter.model
      const pos = model.position.clone().setY(0)
      const rot = model.rotation.y
      fighter.resetToIdle() // 會把 y、z 歸零、轉回左右：之後還原
      model.position.copy(pos)
      model.rotation.y = rot
      model.scale.x = Math.abs(model.scale.x)
      Object.assign(this.states[slot], { isEngine: false, tapDash: null, queuedDashDir: null })
    })
    this.accumulator = 0
  }

  /**
   * 每個畫面更新：決定誰由格鬥邏輯控制、自由移動、推進格鬥邏輯、推擠，鏡頭跟著人物
   * @param {number} delta 遊戲時間（秒，含遊戲速度、暫停）
   * @param {Set<string>} pressed 按著的鍵（e.code）
   * @param {{ p1: boolean, p2: boolean }} ai 由 AI 操作的人物
   * @param {number} realDelta 真實時間（秒）：鏡頭移動用，暫停時照常
   */
  update(delta, pressed, ai, realDelta = delta) {
    this.camera.getWorldDirection(this.forward).setY(0).normalize()
    this.right.set(-this.forward.z, 0, this.forward.x)

    // 這個畫面的輸入（鍵盤；AI 的在每一幀格鬥邏輯推進前才想）
    const raws = {}
    Object.entries(this.fighters).forEach(([slot, fighter]) => {
      if (this.combat.isFrozenOther(fighter)) return // 對手放絕招的凍結期間：完全不動
      const st = this.states[slot]
      raws[slot] = ai[slot] ? this._prepareAI(fighter, st) : this._preparePlayer(slot, fighter, st, pressed)
      if (!st.isEngine) this._updateFree(slot, fighter, st, pressed, ai, delta)
    })

    // 格鬥邏輯：固定每秒 fps 幀
    const step = 1 / this.fps
    this.accumulator += delta
    while (this.accumulator >= step) {
      this.accumulator -= step
      Object.entries(this.fighters).forEach(([slot, fighter]) => {
        const st = this.states[slot]
        if (ai[slot] && st.isEngine && !this.combat.isFrozenOther(fighter)) raws[slot] = this._thinkAI(slot, fighter, st)
        this._applyQueuedDash(fighter, st)
      })
      const active = Object.keys(this.fighters).filter(slot => this.states[slot].isEngine)
      if (active.length) {
        this.combat.step(raws, active)
        active.forEach(slot => this.fighters[slot].captureFrame()) // 畫面補間：記下這一幀
      }
      // 按一下的輸入只送一次（方向、防禦是按著的，繼續送）
      Object.keys(raws).forEach(slot => {
        if (raws[slot]) raws[slot] = { ...raws[slot], jump: false, dash: 0, attack: null, rush: false }
      })
    }
    this.space.resolvePush(Object.values(this.fighters), {})

    // 推擠框跟著人物（腳底橢圓、除錯顯示也用它）
    Object.values(this.fighters).forEach(f => {
      f.model.updateMatrixWorld(true)
      f.updateBoxes()
    })

    this._updateCamera(realDelta)
  }

  /** 渲染前：格鬥邏輯控制中的人在前後兩幀之間內插（自由移動的人每個畫面直接移動，不用） */
  applyInterpolation(isPaused) {
    const alpha = isPaused ? 1 : this.accumulator * this.fps
    this.interpolated = Object.entries(this.fighters).filter(([slot]) => this.states[slot].isEngine).map(([, f]) => f)
    this.interpolated.forEach(f => f.applyInterpolation(alpha))
  }

  /** 渲染後：還原成邏輯幀的姿勢 */
  restoreFrames() {
    this.interpolated.forEach(f => f.restoreFrame())
    this.interpolated = []
  }

  // internal

  /**
   * 玩家這個畫面的輸入，順便決定要不要交給格鬥邏輯（出招、衝刺、跳、防禦、還不能自由行動）
   * 從自由移動切過去時把方向對好：衝刺 → 連按的方向；跳 / 0 / 出招 → 移動方向（沒在移動就是面向）；木樁防禦 → 對手
   * 防禦：正往離開對手的方向移動（夾角 90° 以上）時 isGuarding = true，打中的那一幀由 Combat 判斷成防禦
   */
  _preparePlayer(slot, fighter, st, pressed) {
    const keys = this.keys[slot]
    const pending = this.combat.input[slot]
    const moveDir = this._getInputDir(keys, pressed)
    const other = this._getOpponent(fighter)
    const toOther = other.model.position.clone().sub(fighter.model.position).setY(0)

    const raw = { move: 0 }
    const isJump = !!keys.jump && pressed.has(keys.jump)
    raw.jump = isJump && !st.isJumpHeld
    st.isJumpHeld = isJump
    const tapDir = st.tapDash ? this._getKeyDir(keys, st.tapDash) : null
    st.tapDash = null
    if (tapDir) raw.dash = 1
    const isStandGuard = !!this.isStandGuard?.(slot)
    const isAway = !!moveDir && moveDir.dot(toOther) <= 0
    // 防禦姿勢只有木樁防禦（原地）；往後跑的防禦是被打中那一幀才判斷，不改變移動
    raw.guard = isStandGuard || isAway
    raw.standGuard = isStandGuard
    const isAction = !!pending.pendingAttack || pending.rushLife > 0
    const needEngine = !fighter.canAct || isAction || raw.jump || !!tapDir || isStandGuard

    if (needEngine && fighter.canAct) {
      if (isStandGuard) this._aim(fighter, st, toOther)
      else if (tapDir) this._aim(fighter, st, tapDir)
      else if (!st.isEngine) this._aim(fighter, st, moveDir ?? this._getFacingDir(fighter))
      if (raw.jump && moveDir) raw.move = 1 // 跑步中跳 = 往前跳
    }
    // 衝刺中連按：記住方向，這段衝刺最後一幀轉過去接著衝（見 _applyQueuedDash）
    if (tapDir && fighter.state === 'dash' && !fighter.isRush) st.queuedDashDir = tapDir
    this._setEngine(fighter, st, needEngine)
    // 自由移動中：防禦狀態直接設定（格鬥邏輯控制中的人由 raw.guard 在推進時設定）
    if (!st.isEngine) fighter.isGuarding = raw.guard
    return raw
  }

  /** AI：離對手 engageDistance 內交給格鬥邏輯（輸入在每一幀推進前由 _thinkAI 決定），遠的時候隨意走動 */
  _prepareAI(fighter, st) {
    const other = this._getOpponent(fighter)
    const dist = other.model.position.clone().sub(fighter.model.position).setY(0).length()
    this._setEngine(fighter, st, !fighter.canAct || dist <= this.aiFight.engageDistance)
    return { move: 0 }
  }

  /** 格鬥模式的 AI：能自由行動時先轉向對手，對手換算到自己的方向上（x = 在自己 +x 上的距離） */
  _thinkAI(slot, fighter, st) {
    const other = this._getOpponent(fighter)
    if (fighter.canAct) {
      const toOther = other.model.position.clone().sub(fighter.model.position).setY(0)
      if (toOther.lengthSq() > 1e-6) this._aim(fighter, st, toOther)
    }
    const localX = this.space.localX(fighter, other)
    const opponentInLine = new Proxy(other, {
      get: (target, prop) => {
        if (prop === 'x') return localX
        const value = Reflect.get(target, prop, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    return this.aiThink?.(slot, fighter, opponentInLine) || { move: 0 }
  }

  /** 切換控制：自由移動 → 格鬥邏輯時補間從現在開始；格鬥邏輯 → 自由移動時清掉防禦、鏡像 */
  _setEngine(fighter, st, isEngine) {
    if (isEngine === st.isEngine) return
    st.isEngine = isEngine
    if (isEngine) {
      fighter.captureFrame()
      fighter.captureFrame()
      return
    }
    fighter.isGuarding = false
    fighter.model.scale.x = Math.abs(fighter.model.scale.x)
  }

  /** 衝刺中預約的下一段：這段的最後一幀轉向新方向（格鬥邏輯的預約會在這一幀接著衝） */
  _applyQueuedDash(fighter, st) {
    if (!st.queuedDashDir) return
    if (fighter.state !== 'dash' || fighter.isRush) {
      st.queuedDashDir = null
      return
    }
    if (fighter.framesUntilFree > 1) return
    this._aim(fighter, st, st.queuedDashDir)
    st.queuedDashDir = null
  }

  /** 自由狀態：跑、轉向、播動畫；AI 隨意走動 */
  _updateFree(slot, fighter, st, pressed, ai, delta) {
    const dir = ai[slot] ? this._getWanderDir(fighter, st.wander, delta) : this._getInputDir(this.keys[slot], pressed)
    const isMoved = dir ? this._move(fighter, dir, delta) : false
    if (ai[slot] && dir && !isMoved) this._turnAway(st.wander) // AI 撞到東西：馬上換個方向繼續走
    fighter.playLoop(dir ? this._getRunKey(fighter) : 'idle')
    fighter.mixer.update(delta)
  }

  /** 人物目前面向（世界方向） */
  _getFacingDir(fighter, target = new THREE.Vector3()) {
    const rot = fighter.model.rotation.y
    return target.set(Math.sin(rot), 0, Math.cos(rot))
  }

  /** 把格鬥邏輯的 +x 對準 dir，人物面向 +x */
  _aim(fighter, st, dir) {
    st.dir.copy(dir).setY(0).normalize()
    this._runLocal(fighter, st, () => {
      fighter.faceRight = true
      fighter.refreshFacing()
    }, false)
  }

  /**
   * 在格鬥邏輯的座標裡執行 fn：人物的轉向先換回格鬥邏輯裡的值（+x = st.dir）
   * 執行完把 x 的變化量換成沿著 st.dir 移動（isCollide：會被牆擋住），轉向換成世界方向
   * @returns {boolean} 這次移動有沒有被牆擋住
   */
  _runLocal(fighter, st, fn, isCollide = true) {
    const model = fighter.model
    const x0 = model.position.x
    model.rotation.y = st.localRot
    fn()
    st.localRot = model.rotation.y
    const dx = model.position.x - x0
    model.position.x = x0
    model.rotation.y = Math.atan2(st.dir.x, st.dir.z) + st.localRot - Math.PI / 2
    if (!dx) return false

    const step = st.dir.clone().multiplyScalar(dx)
    const length = step.length()
    if (isCollide) this._collide(model.position, step)
    model.position.add(step)
    return step.length() < length - 1e-6
  }

  /**
   * 鏡頭：注視點 = 跟隨的人腳底上方 followHeight（跳躍不跟著上下），鏡頭保持相對注視點的位置（滑鼠轉動 / 縮放照常）
   * 切換跟隨、剛進入時平滑過渡；鎖定對手時水平轉到跟隨的人背後
   */
  _updateCamera(delta) {
    const smooth = t => t * t * (3 - 2 * t)
    const fighter = this.fighters[this.followSlot]
    const aim = fighter.model.position.clone().setY(this.followHeight)
    let offset = this.camera.position.clone().sub(this.controls.target)

    const ob = this.offsetBlend
    if (ob) {
      ob.t = Math.min(1, ob.t + delta / this.enterTime)
      const k = smooth(ob.t)
      const length = THREE.MathUtils.lerp(ob.from.length(), ob.to.length(), k)
      offset = ob.from.clone().lerp(ob.to, k).setLength(length)
      if (ob.t >= 1) this.offsetBlend = null
    } else if (this.isLockOn) {
      offset = this._getLockOnOffset(fighter, offset, delta)
    }

    const fb = this.followBlend
    if (fb) {
      fb.t = Math.min(1, fb.t + delta / this.switchTime)
      aim.lerpVectors(fb.from, aim, smooth(fb.t))
      if (fb.t >= 1) this.followBlend = null
    }
    this.controls.target.copy(aim)
    this.camera.position.copy(aim).add(offset)
  }

  /**
   * 鎖定對手的鏡頭位置：只轉水平方向，轉到跟隨的人背後（對手 → 自己的方向）
   * 高度（俯角）與距離維持目前的值，滑鼠上下轉動、縮放照常；從目前方向慢慢轉過去，兩人重疊時不轉
   */
  _getLockOnOffset(fighter, offset, delta) {
    const other = this._getOpponent(fighter)
    const back = fighter.model.position.clone().sub(other.model.position).setY(0)
    const flat = Math.hypot(offset.x, offset.z)
    if (back.lengthSq() < 1e-4 || flat < 1e-4) return offset
    const from = Math.atan2(offset.x, offset.z)
    const goal = Math.atan2(back.x, back.z)
    const diff = Math.atan2(Math.sin(goal - from), Math.cos(goal - from))
    const angle = from + diff * Math.min(1, delta * this.lockOnTurnSpeed)
    return new THREE.Vector3(Math.sin(angle) * flat, offset.y, Math.cos(angle) * flat)
  }

  _getOpponent(fighter) {
    return Object.values(this.fighters).find(f => f !== fighter)
  }

  _getState(fighter) {
    const slot = Object.keys(this.fighters).find(k => this.fighters[k] === fighter)
    return this.states[slot]
  }

  /** 按鍵方向（以鏡頭為準）；沒按 = null */
  _getInputDir(keys, pressed) {
    const input = this.input.set(0, 0, 0)
    if (pressed.has(keys.forward)) input.add(this.forward)
    if (pressed.has(keys.back)) input.sub(this.forward)
    if (pressed.has(keys.right)) input.add(this.right)
    if (pressed.has(keys.left)) input.sub(this.right)
    return input.lengthSq() ? input.clone().normalize() : null
  }

  /** 單一方向鍵的方向（以鏡頭為準） */
  _getKeyDir(keys, code) {
    if (code === keys.forward) return this.forward.clone()
    if (code === keys.back) return this.forward.clone().negate()
    if (code === keys.right) return this.right.clone()
    return this.right.clone().negate()
  }

  /**
   * AI 走動：跑一段、停一段，輪流；停 = null
   * 每段開始時決定方向：chaseRate 機率追對手（一直朝對手當下的位置跑），其餘隨機
   */
  _getWanderDir(fighter, wander, delta) {
    const toOther = this._getOpponent(fighter).model.position.clone().sub(fighter.model.position).setY(0)
    wander.time -= delta
    if (wander.time <= 0) {
      wander.isMoving = !wander.isMoving
      const [min, max] = wander.isMoving ? this.wander.moveTime : this.wander.idleTime
      wander.time = THREE.MathUtils.randFloat(min, max)
      wander.isChasing = wander.isMoving && Math.random() < this.aiFight.chaseRate
      if (wander.isMoving && !wander.isChasing) {
        const angle = Math.random() * Math.PI * 2
        wander.dir.set(Math.sin(angle), 0, Math.cos(angle))
      }
    }
    if (!wander.isMoving) return null
    if (wander.isChasing && toOther.lengthSq() > 1e-6) wander.dir.copy(toOther).normalize()
    return wander.dir
  }

  /** AI 撞到東西：轉 90° ~ 270° 換個方向繼續跑（追對手被擋住時也改成隨機走） */
  _turnAway(wander) {
    const angle = Math.atan2(wander.dir.x, wander.dir.z) + THREE.MathUtils.randFloat(Math.PI / 2, Math.PI * 1.5)
    wander.dir.set(Math.sin(angle), 0, Math.cos(angle))
    wander.isChasing = false
    wander.isMoving = true
    wander.time = THREE.MathUtils.randFloat(...this.wander.moveTime)
  }

  /** 沒有跑步動畫的人物用走路代替 */
  _getRunKey(fighter) {
    return fighter.actions.run ? 'run' : 'walk'
  }

  /** 轉向並往 dir 跑一步；回傳是否有移動（整個被牆擋住 = false） */
  _move(fighter, dir, delta) {
    // 轉向移動方向（Mixamo 人物預設面向 +Z）：最短角度慢慢轉過去
    const model = fighter.model
    const goal = Math.atan2(dir.x, dir.z)
    const diff = Math.atan2(Math.sin(goal - model.rotation.y), Math.cos(goal - model.rotation.y))
    model.rotation.y += diff * Math.min(1, delta * this.turnSpeed)
    model.scale.x = Math.abs(model.scale.x)

    const step = this._collide(model.position, this.step.copy(dir).multiplyScalar(this.runSpeed * delta))
    model.position.add(step)
    return step.lengthSq() > 0
  }

  /**
   * 碰到牆：去掉朝牆的分量（沿牆滑開）；滑開後還是撞到就停住
   * 走到場景邊緣（前方沒有地面）：只保留 x 或 z 其中一個方向（沿著邊緣滑），都不行就停住
   * 會直接改 step 並回傳
   */
  _collide(pos, step) {
    this._slideWall(pos, step)
    if (this._hasGround(pos, step)) return step
    const alongX = new THREE.Vector3(step.x, 0, 0)
    const alongZ = new THREE.Vector3(0, 0, step.z)
    if (this._hasGround(pos, alongX) && !this._castWall(pos, alongX)) return step.copy(alongX)
    if (this._hasGround(pos, alongZ) && !this._castWall(pos, alongZ)) return step.copy(alongZ)
    return step.set(0, 0, 0)
  }

  /** 撞牆：去掉朝牆的分量；滑開後還是撞到就停住 */
  _slideWall(pos, step) {
    const hit = this._castWall(pos, step)
    if (!hit) return step
    this.normal.copy(hit.face.normal).transformDirection(hit.object.matrixWorld).setY(0)
    if (this.normal.lengthSq() < 1e-6) return step.set(0, 0, 0)
    this.normal.normalize()
    const into = step.dot(this.normal)
    if (into < 0) step.addScaledVector(this.normal, -into)
    return this._castWall(pos, step) ? step.set(0, 0, 0) : step
  }

  /** 走完這一步（再往前擋牆半徑）的位置，往下找得到場景模型 = 還在場景內；沒有場景時看是否在 bounds 方框內 */
  _hasGround(pos, step) {
    const length = step.length()
    if (length === 0) return true
    const at = pos.clone().add(step).addScaledVector(step, this.radius / length)
    if (!this.env) return this.bounds == null || (Math.abs(at.x) <= this.bounds && Math.abs(at.z) <= this.bounds)
    const { from, length: far } = this.groundRay
    this.raycaster.far = far
    this.raycaster.set(this.origin.set(at.x, from, at.z), DOWN)
    return this.raycaster.intersectObject(this.env, true).some(item => item.object.visible)
  }

  /** 從人物各個高度往移動方向發射線，距離 = 這一步 + 擋牆半徑；回傳最近的命中 */
  _castWall(pos, step) {
    const length = step.length()
    if (!this.env || length === 0) return null
    const dir = step.clone().divideScalar(length)
    this.raycaster.far = length + this.radius
    let nearest = null
    this.rayHeights.forEach(h => {
      this.raycaster.set(this.origin.set(pos.x, h, pos.z), dir)
      const hit = this.raycaster.intersectObject(this.env, true).find(item => item.object.visible && item.face)
      if (hit && (!nearest || hit.distance < nearest.distance)) nearest = hit
    })
    return nearest
  }

  /** 場景網格建 BVH 加速射線（已建過的跳過） */
  _buildBVH(env) {
    env.updateMatrixWorld(true)
    env.traverse(obj => {
      if (!obj.isMesh || obj.isSkinnedMesh || obj.geometry.boundsTree) return
      obj.geometry.boundsTree = new MeshBVH(obj.geometry)
      obj.raycast = acceleratedRaycast
    })
  }
}

/**
 * PlaneSpace：自由模式給 Combat 用的空間規則（介面見 combat.js）
 * 每個人的格鬥邏輯 +x = FreeMode 的 state.dir；位置在 x、z 平面上，擋牆、留在場景內都照 FreeMode 的碰撞
 */
class PlaneSpace {
  constructor(freeMode) {
    this.fm = freeMode
    this.noWall = Infinity
  }

  run(fighter, fn, isCollide = true) {
    return this.fm._runLocal(fighter, this.fm._getState(fighter), fn, isCollide)
  }

  forward(fighter) {
    return this.fm._getState(fighter).dir.clone().multiplyScalar(fighter.faceRight ? 1 : -1)
  }

  /** other 在 fighter 格鬥邏輯座標裡的 x：投影到 fighter 的 +x（dir）上 */
  localX(fighter, other) {
    const dir = this.fm._getState(fighter).dir
    return fighter.x + other.model.position.clone().sub(fighter.model.position).dot(dir)
  }

  /** 被打 / 被抓：交給格鬥邏輯，+x 對準攻擊方（面向攻擊方），擊退往 -x = 沿著攻擊方的正前方 */
  prepareTarget(target, attacker) {
    const st = this.fm._getState(target)
    this.fm._setEngine(target, st, true)
    this.fm._aim(target, st, this.forward(attacker).negate())
  }

  aimAt(fighter, other) {
    const to = other.model.position.clone().sub(fighter.model.position).setY(0)
    if (to.lengthSq() > 1e-6) this.fm._aim(fighter, this.fm._getState(fighter), to)
  }

  moveBy(fighter, step) {
    fighter.model.position.add(this.fm._collide(fighter.model.position, step))
  }

  clampPassEnd() {}

  /** 絕招：招式有 aimOpponent 時朝向對手，其餘維持自己的方向 */
  faceForSuper(fighter, opponent, key) {
    if (fighter.moves[key]?.aimOpponent) this.aimAt(fighter, opponent)
  }

  faceOpponents() {
    return false
  }

  /** 絕招凍結期間：放招的人推進碰到對手就停在對手外面（對手不動） */
  stopAtOpponent(fighter, opp) {
    this._push(fighter, opp, 1)
  }

  /** 推擠：推擠框（圓）重疊時各退一半；對手放絕招凍結中由放招的人全退；穿越中、吸附中、越過頭頂不推 */
  resolvePush([a, b]) {
    if (!a || !b || this.fm.combat.lock) return
    const combat = this.fm.combat
    const rateA = combat.isFrozenOther(a) ? 0 : combat.isFrozenOther(b) ? 1 : 0.5
    this._push(a, b, rateA)
  }

  checkWallBounce() {}

  cornerPush() {}

  /** a、b 重疊時分開：a 退 rateA、b 退其餘（都會擋牆） */
  _push(a, b, rateA) {
    if (a.isPassing || b.isPassing) return
    if (Math.abs(a.y - b.y) > a.characterHeight * this.fm.overheadRate) return
    const delta = b.model.position.clone().sub(a.model.position).setY(0)
    const dist = delta.length()
    const min = a.pushHalfWidth + b.pushHalfWidth
    if (dist >= min) return
    const normal = dist > 1e-4 ? delta.divideScalar(dist) : this.fm._getFacingDir(a)
    const overlap = min - dist
    a.model.position.add(this.fm._collide(a.model.position, normal.clone().multiplyScalar(-overlap * rateA)))
    b.model.position.add(this.fm._collide(b.model.position, normal.clone().multiplyScalar(overlap * (1 - rateA))))
  }
}
