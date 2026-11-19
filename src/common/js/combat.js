import * as THREE from 'three'
import { Gauge } from './gauge.js'

/**
 * Combat：格鬥模式與自由模式共用的戰鬥流程（每秒 60 幀推進一幀）
 *   輸入預約 → 衝刺取消停頓 → 絕招開始 → 人物推進 → 穿越 → 抓取 → 吸附 → 推擠 → 撞牆反彈 → 轉身 → 命中 → 幀數表 → 音效
 *
 * 兩種模式只差在「空間規則」（space），由 space 處理位置相關的事：
 *   - LineSpace（格鬥模式，本檔）：位置只有 x、前方 = 左右面向、有場地邊界與最遠距離，每幀自動面向對手
 *   - FreeMode 的 PlaneSpace（自由模式，freeMode.js）：位置是 x、z，每個人有自己的方向（dir），撞到場景物體就停 / 反彈
 * Fighter 的格鬥邏輯永遠只看 x：space.run 讓它在「自己的方向」上跑，再把 x 的變化換成世界座標的移動
 *
 * space 介面：
 *   run(fighter, fn, isCollide = true) → boolean（這次移動有沒有被擋住）
 *   forward(fighter) → THREE.Vector3（世界座標的正前方，水平單位向量）
 *   localX(fighter, other) → number（other 在 fighter 格鬥邏輯座標裡的 x）
 *   prepareTarget(target, attacker)：被打 / 被抓的人轉向攻擊方
 *   aimAt(fighter, other)：穿越開始時對準對手（LineSpace 不需要）
 *   moveBy(fighter, step)：直接移動（穿越用），會擋牆 / 不出場地
 *   clampPassEnd(fighter, end)：穿越的終點限制在場地內
 *   resolvePush(fighters, { frozenOwner, prevPos })、checkWallBounce(fighters)、cornerPush(attacker, target)
 *   faceOpponents(p1, p2) → boolean（有人轉身）
 *   faceForSuper(fighter, opponent, key, isFromNeutral)
 *   stopAtOpponent(fighter, opponent, prevPos)：絕招凍結期間不推對手
 *   noWall：沒有牆的距離（AI 用）
 */
export class Combat {
  constructor(options) {
    const def = {
      space: null,
      sound: null,
      hitEffect: null,
      frameMeter: null,
      hitstopFrames: 3,
      bufferFrames: 8, // 任何動作結束前幾幀內按攻擊 / 絕招鍵會記住
      dashBufferFrames: 5, // 前前 / 後後的最後幾幀內按會記住
      rushInputFrames: 8, // 衝刺取消鍵按下後記住幾幀
      knockdownSoundFrame: 30, // 被打飛後第幾幀播倒地音效
      // 命中 / 被防禦時的血量與量條變化（點）：普通拳 × strength 倍率；SA 每個擊中判定只扣 superDamage 血
      gaugeRules: {
        strength: { light: 1, medium: 1.5, heavy: 2, airHeavy: 2 },
        hit: { damage: 100, dg: 600, oppDg: 0, sg: 300, oppSg: 100 },
        block: { damage: 0, dg: 300, oppDg: -1200, sg: 150, oppSg: 100 },
        superDamage: 500,
      },
      // 空中命中（被打的人在空中、不是打飛）：下墜速度倍率，維持到各自落地
      airHitFallRate: { attacker: 0.5, target: 0.25 },
      // 跟模式有關的處理（main.js 提供）
      hooks: {
        onHit: null, // (attacker, target, { move, isLaunch, isBlock, hitstop }) → 鏡頭晃動、命中鏡頭、受擊搖晃
        onCombo: null, // (slot, count)
        onSuperStart: null, // (fighter, key) → 對手要凍結的幀數（自由模式）；格鬥模式開始演出、回傳 0
        isWaiting: null, // (fighter) → 絕招等鏡頭中，這幀不推進
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
    this.fighters = {} // { p1, p2 }
    // 每個玩家的輸入預約：
    //   pendingAttack：按下的那一幀才算出招，下一幀遊戲邏輯取走
    //   rushLife：衝刺取消鍵按下後還記住幾幀；被用掉就清 0
    //   bufferedAttack / bufferedDash：收招前按的招式 / 前前後後最後幾幀連按的方向
    this.input = { p1: this.newInputState(), p2: this.newInputState() }
    this.hitstop = 0 // 剩餘頓幀數
    this.rushFreeze = null // 衝刺取消停頓中：{ fighter, frame }
    this.isRushFrozen = false
    this.freeze = null // 自由模式的絕招凍結：{ fighter（放招的人）, frames }，另一名角色不動
    this.lock = null // 吸附 / 抓取中：{ attacker, target, offset, isGrab, lift, juggleHits, seg }
    this.combos = { p1: 0, p2: 0 }
    this.gauges = { p1: new Gauge(), p2: new Gauge() } // 血量、動力槽、絕招量條、虛血
    this.wasDown = { p1: false, p2: false } // 上一幀倒地中（起身時回血用）
    this.prevPos = new Map() // 這幀推進前的位置（最遠距離判斷誰往外移動）
  }

  // public

  setFighters(fighters) {
    this.fighters = fighters
  }

  newInputState() {
    return { pendingAttack: null, rushLife: 0, bufferedAttack: null, bufferedDash: null }
  }

  /** 重置：頓幀、停頓、吸附、凍結、輸入預約、連段（人物狀態由呼叫端重置） */
  reset() {
    this.hitstop = 0
    this.rushFreeze = null
    this.isRushFrozen = false
    this.freeze = null
    this.lock = null
    this.input = { p1: this.newInputState(), p2: this.newInputState() }
    this.wasDown = { p1: false, p2: false }
    Object.keys(this.combos).forEach(slot => {
      this.combos[slot] = 0
      this.hooks.onCombo?.(slot, 0)
    })
  }

  /** 血量與量條回到初始值（重新開始、換人物時由 main.js 呼叫） */
  resetGauges() {
    Object.values(this.gauges).forEach(gauge => gauge.reset())
  }

  /** 對手放絕招（自由模式）的凍結期間 */
  isFrozenOther(fighter) {
    return !!this.freeze && this.freeze.fighter !== fighter
  }

  /**
   * 推進 1 幀
   * @param {{ p1?: object, p2?: object }} raws 這一幀的原始輸入（{ move, dash, jump, guard, standGuard, attack?, rush? }；attack / rush 是 AI 按的）
   * @param {string[]} active 由格鬥邏輯控制的人（自由模式自由跑動中的人不推進，但照常會被打、被推）
   * 推進完由呼叫端記錄畫面補間的這一幀（captureFrame）
   */
  step(raws, active = ['p1', 'p2']) {
    // AI 按的出招 / 衝刺取消鍵先記住：頓幀、絕招凍結時這一幀會提早結束，不記的話會被丟掉（AI 連段就是在命中頓幀中按下一招）
    active.forEach(slot => this._keepRaw(slot, raws[slot]))

    // 頓幀：雙方動畫、移動與幀數表都暫停
    if (this.hitstop > 0) {
      this.hitstop--
      this._updateRushFreeze()
      return
    }
    this.rushFreeze = null

    // 自由模式的絕招凍結：只有放招的人推進
    if (this.freeze) {
      this.stepFrozen(this.freeze.fighter)
      if (--this.freeze.frames <= 0) this.freeze = null
      return
    }

    const f = this.fighters
    const inputs = {}
    active.forEach(slot => { inputs[slot] = this._getInput(slot, raws[slot] || {}) })
    // SG 不滿 1 格：SA 鍵無效
    active.forEach(slot => {
      if (f[slot].moves[inputs[slot].attack]?.isSuper && !this.gauges[slot].canSuper) inputs[slot].attack = null
    })

    // 衝刺取消：按下的瞬間（或預約後碰到對手時）發光並頓幀，頓幀結束的下一幀才開始衝刺
    if (!this.isRushFrozen) {
      const slot = active.find(k => (inputs[k].rush || f[k].rushQueued) && f[k].canRush)
      if (slot) {
        const fighter = f[slot]
        fighter.startGlow()
        this.hitstop = fighter.rush.freezeFrames
        this.rushFreeze = { fighter, frame: 0 }
        this._keepInputs(inputs) // 同一幀按的招式留到停頓結束再交給 Fighter 記住
        this.input[slot].rushLife = 1 // 頓幀結束後的下一幀交給 Fighter 開始衝刺
        this.isRushFrozen = true
        return
      }
    }
    this.isRushFrozen = false

    // 絕招：格鬥模式進入演出（main.js），自由模式直接播、對手凍結
    for (const slot of active) {
      const fighter = f[slot]
      const start = this._getSuperStart(fighter, inputs[slot])
      if (!start) continue
      const otherSlot = slot === 'p1' ? 'p2' : 'p1'
      fighter.rushAttack = null
      this.input[slot].bufferedAttack = null
      fighter.startedMove = false
      this.space.faceForSuper(fighter, f[otherSlot], start.key, start.isFromNeutral)
      this._keepInputs({ [otherSlot]: inputs[otherSlot] })
      this._startSuper(fighter, start.key)
      return
    }

    Object.values(this.gauges).forEach(gauge => gauge.tick())

    this.prevPos = new Map(Object.values(f).map(fighter => [fighter, fighter.model.position.clone()]))
    active.forEach(slot => {
      const fighter = f[slot]
      if (this.hooks.isWaiting?.(fighter)) return // 絕招等鏡頭拉遠：停在第 1 幀
      const isBlocked = this.space.run(fighter, () => fighter.update(inputs[slot]))
      // 被擊飛撞到場景物體（自由模式）：反彈（招式有 launch.wallBounce 時）
      if (isBlocked && fighter.isLaunched) this.space.run(fighter, () => fighter.bounceFly(), false)
    })
    active.forEach(slot => {
      const fighter = f[slot]
      const st = this.input[slot]
      // 衝刺取消開始（打中後、前 + 0、空中）：扣 1 格 DG
      if (fighter.startedRush) {
        this.gauges[slot].useRush()
        fighter.startedRush = false
      }
      if (fighter.usedRush) {
        st.rushLife = 0
        fighter.usedRush = false
      }
      // 收招預約：開始出招就用掉；已經能動卻沒出招（例如在空中）就丟掉
      if (fighter.startedMove || fighter.canAct) st.bufferedAttack = null
      fighter.startedMove = false
    })

    const list = Object.values(f)
    this._updateDashThrough()
    this._checkGrabs()
    this._updateLock()
    this.space.resolvePush(list, { prevPos: this.prevPos })
    this.space.checkWallBounce(list)

    // 轉身以雙方身體受擊框為準：先算判定框，有人轉身再重算一次
    this._updateBoxes()
    if (this.space.faceOpponents(f.p1, f.p2)) this._updateBoxes()
    this._checkHits()
    this._checkGetUp()
    this.frameMeter?.record([f.p1.getFrameType(), f.p2.getFrameType()])

    this._playStepSounds(active.map(slot => f[slot]))
    // 倒地音效：被打飛後第 knockdownSoundFrame 幀（launch.slow 放慢時跟著往後）
    list.forEach(fighter => {
      if (fighter.state === 'down' && fighter.stateFrame === Math.round(this.knockdownSoundFrame * fighter.flySlow)) this.sound.play('knockdown')
    })
  }

  /**
   * 絕招凍結期間推進放招的人 1 幀：只跑招式本身（動畫、前進、音效），對手不動、不做命中 / 抓取判定
   * 格鬥模式由演出（main.js _updateCinematic）呼叫；幀數表記成 frozen
   */
  stepFrozen(fighter) {
    const other = this._getOpponent(fighter)
    const prev = fighter.model.position.clone()
    fighter.isFrozenStep = true // advance.afterFreeze 的招式凍結期間不移動
    this.space.run(fighter, () => fighter.update({ move: 0, attack: null, jump: false, guard: false, dash: 0 }))
    fighter.isFrozenStep = false
    this.space.stopAtOpponent(fighter, other, prev)
    this._updateBoxes()
    this.frameMeter?.record([this.fighters.p1, this.fighters.p2].map(f => (f === fighter ? 'frozen' : f.getFrameType())))
    this._playStepSounds([fighter])
    fighter.captureFrame()
  }

  /** 播放招式在第 frame 幀的音效；音效歸到出招的人那一組，招式被中斷時可以只停他的 */
  playMoveSounds(move, frame, fighter) {
    move.sounds?.forEach(s => {
      if ((s.frame ?? 1) === frame) this.sound.play(s.name, s.delay, fighter)
    })
  }

  /**
   * lock.juggle 的高度：跟著對手飛走動畫的幀數走
   * 每一下（第 1 下從動畫第 0 幀、之後從 animRestart 幀）從當下高度出發：到 maxFrame 升到 maxHeight → 到 minFrame 落到 minHeight → 停住
   * 起點已經過了 maxFrame 時只往下落
   */
  getJuggleHeight(lock) {
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

  // internal

  _getOpponent(fighter) {
    return fighter === this.fighters.p1 ? this.fighters.p2 : this.fighters.p1
  }

  _getSlot(fighter) {
    return fighter === this.fighters.p1 ? 'p1' : 'p2'
  }

  _updateBoxes() {
    Object.values(this.fighters).forEach(f => {
      f.model.updateMatrixWorld(true)
      f.updateBoxes()
    })
  }

  /** 原始輸入裡按一下的鍵（AI 的出招、衝刺取消）存進輸入狀態，等真的推進時由 _getInput 取用 */
  _keepRaw(slot, raw) {
    const st = this.input[slot]
    if (raw?.attack) st.pendingAttack = raw.attack
    if (raw?.rush) st.rushLife = this.rushInputFrames
  }

  /**
   * 一個玩家這一幀的輸入（格式見 Fighter.update）
   * AI 按的招式 / 衝刺取消鍵、鍵盤按的（main.js 寫進 this.input）都經過同一套預約 / 記憶流程
   */
  _getInput(slot, raw) {
    const fighter = this.fighters[slot]
    const st = this.input[slot]
    const attack = this._bufferAttack(fighter, st.pendingAttack, st)
    const rush = st.rushLife > 0
    if (st.rushLife > 0) st.rushLife--
    st.pendingAttack = null
    // 這一幀要出招就不送預約的衝刺（出招優先）
    const bufferedDash = this._bufferDash(fighter, raw.dash || 0, st)
    return { move: raw.move || 0, attack, dash: attack ? raw.dash || 0 : bufferedDash, rush, jump: !!raw.jump, guard: !!raw.guard, standGuard: !!raw.standGuard }
  }

  /**
   * 輸入預約：動作結束前 bufferFrames 幀內按的招式先記住，能動的第一幀才送出
   * 衝刺取消中、連打等本來就能接受輸入的時機照常送出，交給 Fighter 判斷
   */
  _bufferAttack(fighter, pressed, st) {
    // 連打預約的絕招（保險：正常會在 step 的最後一幀就接上）
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
    // 動作的最後一幀就送出：Fighter 這一幀結束動作後馬上出招，幀數表不會多一格空白；真的開始出招才清
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

  /** 提早結束這一幀（衝刺取消停頓、絕招開始）時，已經讀走的出招鍵放回去，下一次讀輸入時還在 */
  _keepInputs(inputs) {
    Object.entries(inputs).forEach(([slot, input]) => {
      const st = this.input[slot]
      if (input?.attack && !st.pendingAttack) st.pendingAttack = input.attack
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

  /** 絕招開始：停在招式第 0 幀、第 1 幀音效；之後交給模式（演出 / 凍結對手） */
  _startSuper(fighter, key) {
    const move = fighter.moves[key]
    this.gauges[this._getSlot(fighter)].useSuper()
    this.space.run(fighter, () => fighter.startMove(key), false)
    this.playMoveSounds(move, 1, fighter) // 第 1 幀音效：按下絕招的瞬間
    // cutSounds：記住這招，被中斷時停掉它的音效（見 _checkSoundCut）
    fighter.soundMove = move.cutSounds ? { key, frame: 0, left: Infinity } : null
    this._updateBoxes()
    const frames = this.hooks.onSuperStart?.(fighter, key) ?? 0
    this.freeze = frames > 0 ? { fighter, frames } : null
  }

  /** 衝刺取消的停頓：第 animStartFrame 幀起，衝刺的人先播衝刺動畫（其他一切仍停住） */
  _updateRushFreeze() {
    const rf = this.rushFreeze
    if (!rf) return
    rf.frame++
    const { fighter } = rf
    if (rf.frame === fighter.rush.animStartFrame) fighter.startRushAnim()
    if (rf.frame >= fighter.rush.animStartFrame) fighter.mixer.update(1 / 60)
  }

  /**
   * 吸附：lock 招式命中後，對手固定在攻擊方正前方 offset 公尺，直到被打飛或招式結束
   * 防禦住的不吸附（在 _checkHits 判斷）
   */
  _updateLock() {
    const lock = this.lock
    if (!lock) return
    const { attacker, target } = lock
    if (attacker.state !== 'attack' || target.state !== 'hit') {
      this.space.run(target, () => {
        target.release() // 被抓住的對手：招式結束沒被打飛就放開
        // lock.juggle：飛走動畫恢復正常播放；沒打飛就結束時從空中直接落下
        if (lock.lift) target.setJuggle(null)
        if (lock.lift && target.y > 0 && !target.isAirborne) {
          target.isAirborne = true
          target.vy = 0
        }
      }, false)
      this.lock = null
      return
    }
    const fwd = this.space.forward(attacker)
    const pos = target.model.position
    const a = attacker.model.position
    pos.x = a.x + fwd.x * lock.offset
    pos.z = a.z + fwd.z * lock.offset
    if (lock.lift) target.y = this.getJuggleHeight(lock)
  }

  /**
   * 抓取：招式有 grab 時，第 from ~ to 幀對手在地面、在正前方 range 公尺內就吸過來（無視防禦）
   * 之後對手跟著攻擊方移動、維持受擊硬直；攻擊判定照判定球判斷，打中擊飛，沒打中就到招式結束才放開
   */
  _checkGrabs() {
    if (this.lock) return
    this._pairs().forEach(([attacker, target]) => {
      const grab = attacker.getCurrentMove()?.grab
      if (!grab || this.lock) return
      const frame = attacker.moveFrame
      if (frame < grab.from || frame > grab.to) return
      // 跳躍中（包含起跳前還在地上的那幾幀）抓不到
      if (attacker.isAirborne || target.isJumping || target.isLaunched || target.isInvincible) return
      const toTarget = target.model.position.clone().sub(attacker.model.position).setY(0)
      if (toTarget.length() > grab.range || toTarget.dot(this.space.forward(attacker)) <= 0) return

      this.space.prepareTarget(target, attacker)
      this.space.run(target, () => target.grab(grab.stunFrame), false)
      this.lock = { attacker, target, offset: grab.distance, isGrab: true }
    })
  }

  /**
   * 穿越（dashThrough）：每次穿越的第 1 幀決定終點（對手身後 gap 公尺、不出場地），之後每幀平均移動過去
   * 最後一次：lastNoPass 停在對手面前、lastDistance 往前衝固定距離
   */
  _updateDashThrough() {
    this._pairs().forEach(([f, other]) => {
      const d = f.getCurrentMove()?.dashThrough
      if (!d || !f.isDashing) return
      const pos = f.model.position
      if (!f.passPlan) {
        this.space.aimAt(f, other)
        const fwd = this.space.forward(f)
        let end
        if (f.isLastPassStop) end = other.model.position.clone().addScaledVector(fwd, -(f.pushHalfWidth + other.pushHalfWidth))
        else if (f.isLastPass && d.lastDistance) end = pos.clone().addScaledVector(fwd, d.lastDistance)
        else end = other.model.position.clone().addScaledVector(fwd, d.gap)
        end.y = pos.y
        this.space.clampPassEnd(f, end)
        f.passPlan = { start: pos.clone(), end }
      }
      const t = Math.min(1, (f.moveFrame - d.from + 1) / (d.to - d.from + 1))
      const next = f.passPlan.start.clone().lerp(f.passPlan.end, t)
      this.space.moveBy(f, next.sub(pos).setY(0))
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
   * 攻擊方的攻擊判定碰到對手受擊框就算命中；每段只算一下，launch 招式最後一段把對手打飛
   * 吸附中（lock 招式命中後）：之後每一段進入判定幀就必定命中，不看判定框
   * 抓取中（grab）：仍照判定球判斷，打中才擊飛；沒打中就抓到招式結束才放開
   */
  _checkHits() {
    this._pairs().forEach(([attacker, target]) => {
      const isLocked = this.lock?.attacker === attacker && this.lock.target === target && !this.lock.isGrab
      if (!(isLocked ? attacker.isHitActive() : attacker.checkHit(target))) return

      const move = this._getStunMove(attacker, target)
      // 打擊特效：命中點、往被打的方向噴
      const hitPoint = attacker.getHitPoint(target)
      const fwd = this.space.forward(attacker)
      const hitDir = Math.sign(fwd.x) || 1

      // 防禦：不扣血、不吸附、不打飛、不算連段，只有防禦硬直
      if (target.canBlock) {
        this.hitEffect.spawn(hitPoint, { type: 'block', dir: hitDir })
        attacker.registerHit()
        this.space.prepareTarget(target, attacker)
        this.space.run(target, () => target.takeBlock(this.space.localX(target, attacker), move), false)
        this.sound.play('block')
        this.space.cornerPush(attacker, target)
        this._applyGauges(attacker, target, true)
        this.hitstop = move.hitstop ?? this.hitstopFrames
        this.hooks.onHit?.(attacker, target, { move, isLaunch: false, isBlock: true, hitstop: this.hitstop })
        return
      }

      const isCombo = target.state === 'hit' || target.isLaunched // 對手還在硬直中（含被打飛的飛走中）被打到 = 連段
      const isLaunch = attacker.registerHit()
      const isAirHit = target.isAirborne && !isLaunch && !target.isLaunched // 空中被普通攻擊打中：播飛走動畫、距離 = 擊退距離，雙方下墜變慢
      this.hitEffect.spawn(hitPoint, { type: move.isSuper || move.heavyHitEffect ? 'heavy' : 'hit', dir: hitDir })
      this.space.prepareTarget(target, attacker)
      this.space.run(target, () => target.takeHit(this.space.localX(target, attacker), move, isLaunch), false)
      attacker.onHitConfirm() // 衝刺取消、收招縮短、下一拳鏡像：防禦住的不算
      if (isAirHit) {
        target.slowFall(this.airHitFallRate.target)
        attacker.slowFall(this.airHitFallRate.attacker)
      }
      this._applyGauges(attacker, target, false)
      if (!isLaunch) this.space.cornerPush(attacker, target)
      this.sound.play(move.isSuper ? 'superHit' : 'hit') // 受擊確認：受擊硬直第一幀
      // 絕招命中不頓幀，改成晃鏡頭
      this.hitstop = move.isSuper ? 0 : move.hitstop ?? this.hitstopFrames
      this.hooks.onHit?.(attacker, target, { move, isLaunch, isBlock: false, hitstop: this.hitstop })

      if (move.lock && !isLaunch && !this.lock) {
        const gap = attacker.pushHalfWidth + target.pushHalfWidth
        this.lock = { attacker, target, offset: Math.max(gap, move.lock.distance ?? gap), lift: null, juggleHits: -1 } // 吸附到攻擊方正前方
      }

      // lock.juggle：吸附中打到第 fromHit 段（1 起算）時開始浮空挨打
      const juggle = attacker.getCurrentMove()?.lock?.juggle
      const lock = this.lock
      if (juggle && !isLaunch && lock?.attacker === attacker && lock.target === target && !lock.lift && attacker.hitWindow + 1 >= (juggle.fromHit ?? 1)) {
        lock.lift = juggle
        this.space.run(target, () => target.setJuggle({ hold: juggle.animHold ?? 14, restart: juggle.animRestart ?? 8 }), false)
      }

      const slot = this._getSlot(attacker)
      this.combos[slot] = isCombo ? this.combos[slot] + 1 : 1
      this.hooks.onCombo?.(slot, this.combos[slot])
    })

    // 對手恢復自由 = 連段結束
    Object.keys(this.combos).forEach(slot => {
      if (this.combos[slot] && this._getOpponent(this.fighters[slot]).canAct) {
        this.combos[slot] = 0
        this.hooks.onCombo?.(slot, 0)
      }
    })
  }

  /**
   * 命中 / 被防禦時的血量與量條變化（gaugeRules）
   * 普通拳依 strength 倍率；SA 只有擊中時扣 superDamage 血；被擊中一律先結算虛血
   */
  _applyGauges(attacker, target, isBlock) {
    const self = this.gauges[this._getSlot(attacker)]
    const opp = this.gauges[this._getSlot(target)]
    const key = attacker.currentMove
    const rules = this.gaugeRules
    if (attacker.moves[key]?.isSuper) {
      if (!isBlock) opp.takeHit(rules.superDamage)
      return
    }
    const rate = rules.strength[key] ?? 0
    const r = isBlock ? rules.block : rules.hit
    if (!isBlock) opp.takeHit(r.damage * rate)
    self.addDg(r.dg * rate)
    opp.addDg(r.oppDg * rate)
    self.addSg(r.sg * rate)
    opp.addSg(r.oppSg * rate)
  }

  /** 被打倒後起身（倒地狀態結束）：血量 0 的人回滿血 */
  _checkGetUp() {
    Object.entries(this.fighters).forEach(([slot, fighter]) => {
      const isDown = fighter.state === 'down'
      if (this.wasDown[slot] && !isDown) this.gauges[slot].onGetUp()
      this.wasDown[slot] = isDown
    })
  }

  _pairs() {
    const { p1, p2 } = this.fighters
    return [[p1, p2], [p2, p1]]
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

  /** 招式音效：第 2 幀以後在這裡播（第 1 幀在出招時播，避免定格那幀重複） */
  _playStepSounds(fighters) {
    fighters.forEach(f => {
      this._checkSoundCut(f)
      const move = f.getCurrentMove()
      const frame = f.moveFrame
      if (move?.sounds && frame > 1 && f.soundFrame !== frame) {
        f.soundFrame = frame
        this.playMoveSounds(move, frame, f)
      }
      if (!move) f.soundFrame = 0
    })
  }
}

/**
 * LineSpace：格鬥模式的空間規則（位置只有 x）
 * - 場地邊界 ±halfWidth、兩人最遠距離 maxDistance；邊界牆 / 最遠距離反彈；角落推擠
 * - 每幀自動面向對手
 */
export class LineSpace {
  constructor(options) {
    const def = {
      getHalfWidth: () => 7.5, // 場地半寬（會隨 GUI、場景改變，用函式取）
      maxDistance: 5,
      overheadHeight: 1.4, // 高度差超過這個（公尺）就不推擠（越過頭頂）
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
    this.noWall = undefined
  }

  // public

  run(fighter, fn) {
    fn()
    return false
  }

  forward(fighter) {
    return new THREE.Vector3(fighter.facingSign, 0, 0)
  }

  localX(fighter, other) {
    return other.x
  }

  prepareTarget() {}

  aimAt() {}

  moveBy(fighter, step) {
    fighter.x += step.x
  }

  clampPassEnd(fighter, end) {
    const limit = this.getHalfWidth() - fighter.pushHalfWidth
    end.x = THREE.MathUtils.clamp(end.x, -limit, limit)
  }

  faceForSuper(fighter, opponent, key, isFromNeutral) {
    if (isFromNeutral) fighter.faceTo(opponent, true)
  }

  faceOpponents(p1, p2) {
    const turned1 = p1.faceTo(p2)
    const turned2 = p2.faceTo(p1)
    return turned1 || turned2
  }

  /**
   * 凍結期間對手不能被推：放招的人往前移動（advance 等）碰到對手就停在對手面前，不推對手、也不穿過去
   * 越過頭頂（高度差大）或穿越中（dashThrough）照常通過；也不超出場地邊界
   */
  stopAtOpponent(fighter, opp, prevPos) {
    const isOverhead = Math.abs(fighter.y - opp.y) > this.overheadHeight
    if (!isOverhead && !fighter.isPassing) {
      const minGap = fighter.pushHalfWidth + opp.pushHalfWidth
      fighter.x = prevPos.x <= opp.x ? Math.min(fighter.x, opp.x - minGap) : Math.max(fighter.x, opp.x + minGap)
    }
    const limit = this.getHalfWidth() - fighter.pushHalfWidth
    fighter.x = Math.max(-limit, Math.min(limit, fighter.x))
  }

  /** 推擠：兩人推擠框重疊時各退一半；有一方卡在邊界時由另一方全退；超過最遠距離時拉回 */
  resolvePush([p1, p2], { prevPos }) {
    const limit = this.getHalfWidth()

    // 兩人座標完全相同時，以 P1 在左為準
    const left = p1.x <= p2.x ? p1 : p2
    const right = left === p1 ? p2 : p1
    const minGap = left.pushHalfWidth + right.pushHalfWidth
    const overlap = minGap - (right.x - left.x)
    // 高度差超過大半個身高（跳過對手頭頂）時不推擠，可以越過去換邊
    const isOverhead = Math.abs(p1.y - p2.y) > this.overheadHeight
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
      const leftOut = Math.max(0, (prevPos.get(left)?.x ?? left.x) - left.x)
      const rightOut = Math.max(0, right.x - (prevPos.get(right)?.x ?? right.x))
      const total = leftOut + rightOut
      const leftShare = total > 0 ? leftOut / total : 0.5
      left.x += excess * leftShare
      right.x -= excess * (1 - leftShare)
    }
  }

  /**
   * 打飛撞牆反彈：飛走中碰到邊界牆、或離對手達到最遠距離（maxDistance）就反彈
   * 反彈後剩下的飛行距離 × 招式的 launch.wallBounce 往回飛
   */
  checkWallBounce([p1, p2]) {
    ;[[p1, p2], [p2, p1]].forEach(([f, other]) => {
      if (!f.flyBounce || f.isFlyBounced || !f.isLaunched) return
      const eps = 1e-4
      const atWall = f.x * f.flyDir >= this.getHalfWidth() - f.pushHalfWidth - eps
      const atMaxDistance = (f.x - other.x) * f.flyDir >= this.maxDistance - eps
      if (atWall || atMaxDistance) f.bounceFly()
    })
  }

  /**
   * 邊界推擠：對手的擊退距離超過到邊界的空間時，超出的部分改成攻擊方往後退
   * 擊退速度每秒衰減 e^-8，總距離約 = 初速 / 8
   */
  cornerPush(attacker, target) {
    const v = target.knockVelocity
    if (!v) return
    const dir = Math.sign(v)
    const wall = dir * (this.getHalfWidth() - target.pushHalfWidth)
    const room = Math.max(0, (wall - target.x) * dir)
    const distance = Math.abs(v) / 8
    if (distance <= room) return
    attacker.pushVelocity = -dir * (distance - room) * 8
  }
}
