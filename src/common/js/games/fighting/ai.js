/**
 * FighterAI：電腦操作的玩家，每幀看雙方狀態回傳按鍵（跟鍵盤輸入同格式，交給 main.js 同一套預約 / 衝刺取消流程）
 * - 走位：遠了走近 / 衝刺 / 偶爾跳入，近了保持距離、偶爾後退；不會長時間站著不動
 * - 攻擊：只在打得到的距離出拳（依距離選輕 / 中 / 重），對手收招破綻時反擊，偶爾直接放絕招
 * - 防禦：對手出招時，經過反應時間後有一定機率防禦
 * - 連段：拳打中（不是被防禦）後照 combos 的路線接下去：拳 → 拳（攻擊取消）→ 0（衝刺取消）→ … → 絕招
 * - 難度：setLevel('easy' | 'normal' | 'hard' | 'expert')，見 AI_LEVELS
 */

// 連段路線：第一招打中後依第一招選路線；'rush' = 按 0 衝刺取消、'super' = 絕招
const COMBOS = [
  ['heavy', 'rush', 'heavy', 'medium', 'rush', 'medium', 'light', 'rush', 'light', 'light', 'light', 'super'],
  ['medium', 'medium', 'rush', 'medium', 'medium', 'rush', 'heavy', 'medium', 'super'],
  ['light', 'light', 'light', 'rush', 'light', 'light', 'light', 'super'],
  ['light', 'light', 'rush', 'light', 'medium', 'rush', 'medium', 'heavy', 'super'],
]

/**
 * 難度（setLevel）：覆蓋下面 def 的同名設定
 *   comboDropRate：連段每往下一步，有多少機率直接中斷
 *   attackWindows：出拳距離區間 { 招式: [最近, 最遠] }（兩人中心距離，公尺）；有填就照區間選招、不在區間內會走位調整距離
 *   whiffPunish：對手揮空（沒碰到人）收招時一定反擊，用當下距離打得到的拳
 *   dodgeGrab：看到抓技（招式有 grab）要抓過來時跳起來躲
 *   punishSuper：防禦住對手的絕招後，走到重拳距離用重拳起手打連段
 *   reaction：看到對手出招到開始防禦的反應時間 [最快, 最慢]（幀）
 *   antiAir：對空，每次對手跳躍只出手一次：airToAirRate 機率自己也跳起來空中迎擊，其餘站著等，
 *     算好對手落地的時間讓輕 / 中拳剛好在落地時打到；太近就先退開
 *   blockSafety：自己的攻擊被防禦後不硬上，先防禦一小段時間（避免被反擊）
 *   gaugeAware：看量條做事：動力槽不夠就不衝刺取消（免得產生虛血）；對手血量低、絕招量條夠時連段改接絕招收尾；
 *     抓到對手收招破綻時有機會直接用絕招反擊
 *   meaty：對手起身時壓起身：走到輕拳距離，算好時間讓輕拳在對手剛能動的那一幀打到
 *   footsies：牽制：在對手出拳距離外一點點來回晃，騙對手揮空（搭配 whiffPunish 反擊）
 *   adaptive：短時間內被打中 2 次以上，就提高防禦機率（學乖了）
 *   cornerEscape：被逼到牆邊、對手貼近時，有機會往前跳過對手逃出牆角
 *   counterPoke：截擊。對手出慢的拳（例如重拳）時，算對手還有幾幀出判定；自己更快的拳（輕 / 中）來得及先打到、距離也夠，就直接出拳打斷
 *   whiffSuper：對手揮空時，算收招還剩幾幀；whiffSuperMove（閃身步）從按下到打到來得及，就用它反擊
 *   reversal：被壓制（短時間內連續防禦 pressureBlocks 次）時用無敵絕招 reversalMove（狗熊哆嗦毛）反打：
 *     - 看準時機（reversalRate）：對手下一招的攻擊判定會落在無敵時間內才放
 *     - 無條件（reversalRandomRate）：連防到第 pressureBlocks 次、一能動就直接放，不管時機（可能被擋 / 揮空）
 */
const WINDOWS = { light: [0, 1.4], medium: [1.4, 1.6], heavy: [1.6, 1.8] }
export const AI_LEVELS = {
  easy: {
    name: '簡單',
    comboDropRate: 0.25,
    guardRate: 0.5,
    reaction: [10, 18]
  },
  normal: { name: '中等' },
  hard: {
    name: '進階',
    guardRate: 0.8,
    reaction: [6, 12],
    attackWindows: WINDOWS,
    antiAir: true,
    blockSafety: true,
    gaugeAware: true,
  },
  expert: {
    name: '困難',
    guardRate: 0.95,
    reaction: [4, 8],
    attackWindows: WINDOWS,
    whiffPunish: true,
    dodgeGrab: true,
    punishSuper: true,
    antiAir: true,
    blockSafety: true,
    gaugeAware: true,
    meaty: true,
    footsies: true,
    adaptive: true,
    cornerEscape: true,
    counterPoke: true,
    whiffSuper: true,
    reversal: true,
  },
}

const rand = (min, max) => min + Math.random() * (max - min)
const randInt = (min, max) => Math.floor(rand(min, max + 1))
const pick = list => list[Math.floor(Math.random() * list.length)]

export class FighterAI {
  constructor(options) {
    const def = {
      // 出拳距離（兩人中心距離，公尺）：超過就不出這招；實際打不打得到看動畫，揮空太多可以調小
      ranges: { light: 0.95, medium: 1.05, heavy: 1.15 },
      reaction: [8, 16], // 看到對手出招到開始防禦的反應時間（幀）
      guardRate: 0.6, // 對手出招時會防禦的機率
      punishRate: 0.5, // 對手收招有破綻時反擊的機率
      comboRate: 0.9, // 打中後接連段的機率
      attackRate: 0.35, // 在出拳距離內、每次做決定時出拳的機率
      rawSuperRate: 0.03, // 在出拳距離內直接放絕招的機率
      jumpInRate: 0.08, // 中距離跳入的機率
      supers: ['dog_bear', 'shake_head', 'kick_ball', 'dodge_step'], // 連段 / 直接放用的絕招（kick_ball 是抓取，不放進連段）
      canSuper: () => true, // 現在能不能放絕招（SG 滿 1 格；main.js 提供）
      getGauges: () => null, // () => { self, opp }：雙方的 Gauge（gaugeAware 用；main.js 提供）
      killHp: 2500, // gaugeAware：對手血量低於這個值，連段改接絕招收尾
      getSuperStartup: () => Infinity, // (fighter, key) → 絕招從按下到出判定、對手實際經過的幀數（含演出凍結；main.js 提供）
      whiffSuperMove: 'dodge_step', // whiffSuper 用的絕招
      whiffSuperRange: 3, // whiffSuper：距離多遠以內才用（閃身步會衝過去）
      reversalMove: 'dog_bear', // reversal 用的無敵絕招
      pressureBlocks: 3, // reversal：最近 pressureFrames 幀內防禦幾次算被壓制
      pressureFrames: 150,
      reversalRate: 0.3, // reversal：被壓制時，看準對手前搖用無敵絕招反打的機率（每次對手出招判斷一次）
      reversalRandomRate: 0.3, // reversal：連續防禦到第 pressureBlocks 次、一能動就不管時機直接放的機率
      airToAirRate: 0.35, // antiAir：對手跳過來時，自己也跳起來空中迎擊的機率（其餘在地面等落地出拳）
      // 以下是難度相關（見 AI_LEVELS），預設 = 中等
      comboDropRate: 0,
      attackWindows: null,
      whiffPunish: false,
      dodgeGrab: false,
      punishSuper: false,
      antiAir: false,
      blockSafety: false,
      gaugeAware: false,
      meaty: false,
      footsies: false,
      adaptive: false,
      cornerEscape: false,
      counterPoke: false,
      whiffSuper: false,
      reversal: false,
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
    this.baseConfig = { ...def } // 難度沒寫到的設定回到這裡
    this.level = 'normal'

    // 4. setup runtime state
    this.reset()
  }

  // public

  /** 切換難度（AI_LEVELS 的 key）：先回到預設值，再套上該難度的設定 */
  setLevel(level) {
    const preset = AI_LEVELS[level]
    if (!preset) return
    const { name, ...config } = preset
    Object.keys(AI_LEVELS.expert).concat('comboDropRate').forEach(k => { if (k !== 'name') this[k] = this.baseConfig[k] })
    Object.assign(this, config)
    this.level = level
  }

  /** 狀態全部清掉（Esc 重置、切換 AI 時用） */
  reset() {
    this.superPunish = null // 防禦住絕招後的反擊計畫：{ until }
    this.forceRoute = null // 下一次重拳打中時一定走這條連段路線（punishSuper）
    this.safeUntil = 0 // blockSafety：自己被防禦後，到這一幀前先防禦
    this.blockedFrom = null // 已經處理過「被防禦」的那次出招
    this.hitTimes = [] // adaptive：最近被打中的幀
    this.blockTimes = [] // reversal：最近開始防禦的幀
    this.pressureRolled = false // reversal：這一輪壓制已經骰過「無條件施放」
    this.oppJump = null // antiAir：對手這次跳躍的應對 { mode: 'air' | 'ground', done }
    this.counteredMove = null // counterPoke / reversal：已經處理過的那次對手出招（開始幀）
    this.stageHalfWidth = 6
    this.frame = 0
    this.plan = null // 走位計畫：{ move: -1 / 0 / 1（相對對手：1 = 靠近）, until }
    this.combo = null // 連段中：{ route, step, pressedStep, idle }
    this.guard = null // 對手這一招的防禦決定：{ at, will }
    this.punish = null // 對手這一招收招時是否反擊
    this.prev = { self: null, opp: null } // 上一幀的狀態，判斷「剛開始出招」用
    this.comboFrom = null // 已經判斷過要不要連段的那次出招（同一下命中只判斷一次）
  }

  /**
   * 這一幀要按的鍵
   * @returns {{ move: number, attack: string | null, rush: boolean, dash: number, jump: boolean, guard: boolean }}
   *   move / dash 是世界座標方向
   */
  think(self, opp, stageHalfWidth = 6) {
    this.frame++
    const out = { move: 0, attack: null, rush: false, dash: 0, jump: false, guard: false }
    const toward = Math.sign(opp.x - self.x) || self.facingSign
    const dist = Math.abs(opp.x - self.x)
    this.stageHalfWidth = stageHalfWidth

    const prevSelfState = this.prev.self?.state
    const selfStarted = this._isNewMove(self, 'self')
    const oppStarted = this._isNewMove(opp, 'opp')

    // adaptive：記下被打中的時間，最近 5 秒內被打 2 次以上就提高防禦率
    if (self.state === 'hit' && prevSelfState !== 'hit') this.hitTimes.push(this.frame)
    this.hitTimes = this.hitTimes.filter(f => this.frame - f < 300)
    // reversal：記下開始防禦的時間（連續防禦也算，每次對手出招都會重新進入防禦硬直）
    if (self.state === 'block' && (prevSelfState !== 'block' || self.stateFrame === 0)) this.blockTimes.push(this.frame)
    this.blockTimes = this.blockTimes.filter(f => this.frame - f < this.pressureFrames)
    const guardRate = this.adaptive && this.hitTimes.length >= 2 ? Math.min(0.98, this.guardRate + 0.15) : this.guardRate

    // blockSafety：自己的攻擊被防禦（碰到但沒打中）→ 之後先防禦一小段時間
    const moveStart = this.frame - self.stateFrame // 這次出招的開始幀：同一招只處理一次
    if (this.blockSafety && self.state === 'attack' && self.connected && !self.hitConfirmed && this.blockedFrom !== moveStart) {
      this.blockedFrom = moveStart
      this.safeUntil = this.frame + randInt(15, 25)
    }

    // 對手剛出招：決定要不要防禦（反應時間後才開始擋）、收招時要不要反擊
    if (oppStarted) {
      const move = opp.getCurrentMove()
      const isThreat = dist < 2.4 || move?.isSuper
      this.guard = isThreat ? { at: this.frame + randInt(...this.reaction), will: Math.random() < guardRate } : null
      this.punish = Math.random() < this.punishRate
    }

    // 1. 連段
    if (this._updateCombo(self, opp, selfStarted, out)) return out

    // 1.5 抓技（dodgeGrab）：對手的抓取判定快到了、在抓取範圍附近 → 原地跳起來躲（抓技無視防禦）
    const oppMove = opp.getCurrentMove()
    if (this.dodgeGrab && oppMove?.grab && self.canAct) {
      const { from, to, range } = oppMove.grab
      if (opp.moveFrame >= from - 6 && opp.moveFrame <= to && dist < range + 0.6) {
        out.jump = true
        return out
      }
    }

    // 防禦住絕招（punishSuper）：之後走到重拳距離，用重拳起手打連段
    if (this.punishSuper && self.state === 'block' && oppMove?.isSuper) this.superPunish = { until: this.frame + 150 }

    // 1.55 reversal（無條件）：連續防禦到第 pressureBlocks 次、一能動就有 reversalRandomRate 機率直接放無敵絕招（不管時機，可能被擋 / 揮空）
    const revMove = self.moves[this.reversalMove]
    const isPressured = this.blockTimes.length >= this.pressureBlocks
    if (!isPressured) this.pressureRolled = false
    if (this.reversal && isPressured && !this.pressureRolled && self.canAct && revMove && this.canSuper()) {
      this.pressureRolled = true // 這一輪壓制只骰一次
      if (Math.random() < this.reversalRandomRate) {
        this.blockTimes = []
        out.attack = this.reversalMove
        return out
      }
    }

    // 1.6 對手出拳的前搖中（每次出招只判斷一次）：無敵絕招反打 / 更快的拳截擊
    const oppMoveStart = this.frame - opp.stateFrame
    const toActive = opp.getFramesToActive?.()
    if (self.canAct && oppMove && !oppMove.isSuper && toActive && this.counteredMove !== oppMoveStart) {
      const reaction = this.reaction[0]
      // reversal（看準時機）：被壓制中、對手的判定會落在無敵時間內 → reversalRate 機率用無敵絕招反打
      // 絕招從出招到第一次攻擊判定都無敵（invincibleFrames 更長時照它）；演出凍結時對手也不動，無敵從遊戲恢復後算
      const invincible = Math.max(revMove?.invincibleFrames ?? 0, this.getSuperStartup(self, this.reversalMove))
      if (this.reversal && isPressured && revMove && this.canSuper() && toActive <= invincible - 2 && toActive > 1) {
        this.counteredMove = oppMoveStart // 不管有沒有放，這一招只判斷一次
        if (Math.random() < this.reversalRate) {
          this.blockTimes = []
          out.attack = this.reversalMove
          return out
        }
      }
      // counterPoke：自己的拳能比對手先出判定（按下的下一幀開始算前搖），距離也打得到 → 截擊；看到之後要反應時間
      if (this.counterPoke && opp.stateFrame >= reaction) {
        const key = ['light', 'medium']
          .filter(k => self.moves[k] && self.moves[k].startup + 2 < toActive)
          .find(k => {
            const [near, far] = this._getWindow(k)
            return dist >= near && dist <= far
          })
        if (key && Math.random() < 0.85) {
          this.counteredMove = oppMoveStart
          out.attack = key
          return out
        }
      }
    }

    // 2. 防禦：對手出招中（還沒收招）、或已經在防禦硬直中就繼續擋
    const oppThreat = opp.state === 'attack' && opp.getFrameType() !== 'recovery'
    if (self.state === 'block' || (oppThreat && this.guard?.will && this.frame >= this.guard.at)) {
      out.guard = true
      return out
    }

    // 3. 空中：下降時接近對手就出空中重攻擊；對手也在空中（空中迎擊）就早一點出
    if (self.state === 'air') {
      const minFrame = self.jump.air * (opp.isAirborne ? 0.15 : 0.4)
      if (!self.hasAirAttacked && dist < 1.4 && self.airFrame >= minFrame) out.attack = 'heavy'
      return out
    }

    if (!self.canAct) return out

    // 3.1 blockSafety：剛被防禦，對手還在附近就先擋著，不硬上
    if (this.frame < this.safeUntil && dist < 2.2) {
      out.guard = true
      return out
    }

    // 3.2 antiAir：對手跳過來（每次跳躍只出手一次，不會原地一直揮空）
    if (this._antiAir(self, opp, dist, toward, out)) return out

    // 3.3 cornerEscape：背貼牆、對手貼近 → 有機會往前跳過對手逃出牆角
    const isCornered = Math.abs(self.x) > this.stageHalfWidth - 0.8 && Math.sign(self.x) === -toward
    if (this.cornerEscape && isCornered && dist < 1.3 && opp.canAct && Math.random() < 0.03) {
      out.jump = true
      out.move = toward
      return out
    }

    // 3.5 防禦住絕招後的反擊：對手絕招結束後，調整到重拳距離再出重拳（之後照重拳起手的路線連段）
    if (this.superPunish) {
      if (this.frame > this.superPunish.until) {
        this.superPunish = null
      } else if (!(opp.state === 'attack' && opp.getFrameType() !== 'recovery')) {
        const [near, far] = this._getWindow('heavy')
        if (dist >= near && dist <= far) {
          this.superPunish = null
          this.forceRoute = COMBOS.find(c => c[0] === 'heavy')
          out.attack = 'heavy'
        } else {
          out.move = dist < near ? -toward : toward
        }
        return out
      }
    }

    // 4. 對手收招有破綻、距離夠近：反擊（出手快的優先）；whiffPunish：對手揮空（沒碰到人）一定反擊
    const isWhiff = this.whiffPunish && !opp.connected
    if (opp.state === 'attack' && opp.getFrameType() === 'recovery' && (this.punish || isWhiff)) {
      const recoveryLeft = opp.stateLength - opp.stateFrame
      // whiffSuper：對手揮空、收招剩下的幀數夠閃身步從按下打到 → 用閃身步反擊
      if (this.whiffSuper && isWhiff && this.canSuper() && dist <= this.whiffSuperRange && self.moves[this.whiffSuperMove]
        && this.getSuperStartup(self, this.whiffSuperMove) + 2 < recoveryLeft) {
        this.punish = false
        out.attack = this.whiffSuperMove
        return out
      }
      // gaugeAware：收招破綻夠長（還有 20 幀以上）、絕招量條夠 → 一半機率直接用絕招反擊
      if (this.gaugeAware && this.canSuper() && recoveryLeft > 20 && dist < 2 && Math.random() < 0.5) {
        const superKey = this._pickSuper(self)
        if (superKey) {
          this.punish = false
          out.attack = superKey
          return out
        }
      }
      const key = this._pickAttack(dist, isWhiff ? ['light', 'medium', 'heavy'] : ['light', 'medium'])
      if (key) {
        this.punish = false
        out.attack = key
        return out
      }
    }

    // 5. 對手倒地起身中（無敵）：不出手，保持中距離等他起來
    //    meaty：走到輕拳距離，算好時間讓輕拳的攻擊判定在對手剛能動時出現（壓起身）
    const oppDown = opp.state === 'down' && !opp.isLaunched && !opp.isDying
    if (oppDown) {
      if (this.meaty) {
        const left = opp.stateLength - opp.stateFrame // 還有幾幀起身完
        const startup = self.moves.light?.startup ?? 10
        const [, lightFar] = this._getWindow('light')
        const target = Math.min(lightFar, 1.2) - 0.1
        if (left <= startup + 1 && left >= startup - 1 && dist <= lightFar) out.attack = 'light'
        else out.move = dist > target ? toward : dist < 0.8 ? -toward : 0
        return out
      }
      out.move = dist < 1.6 ? -toward : dist > 2.2 ? toward : 0
      return out
    }

    // 6. 中立：照計畫走位，在出拳距離內有機率出手
    if (!this.plan || this.frame >= this.plan.until) this._makePlan(self, opp, dist, out, toward)
    if (out.attack || out.jump || out.dash) return out
    out.move = this.plan.move * toward
    // 別一直退到牆邊（離邊界 1 公尺內就不再後退）
    if (this.plan.move < 0 && Math.abs(self.x) > stageHalfWidth - 1) out.move = 0
    return out
  }

  // internal

  /** 剛開始一個新招式：上一幀不是出招，或換了招式，或同一招從頭開始（連打） */
  _isNewMove(fighter, who) {
    const prev = this.prev[who]
    const now = { state: fighter.state, move: fighter.currentMove, frame: fighter.stateFrame }
    this.prev[who] = now
    if (fighter.state !== 'attack') return false
    return !prev || prev.state !== 'attack' || prev.move !== now.move || now.frame < prev.frame
  }

  /** 中立狀態的下一個決定：出拳 / 衝刺 / 跳 / 走位，計畫維持一小段時間 */
  _makePlan(self, opp, dist, out, toward) {
    const hold = (move, min, max) => {
      this.plan = { move, until: this.frame + randInt(min, max) }
    }
    const r = Math.random()

    // 出拳距離內
    const attack = this._pickAttack(dist)
    if (attack) {
      // gaugeAware：中立時不亂放絕招（被擋會吃大破綻），留給連段收尾、抓破綻用
      if (!this.gaugeAware && r < this.rawSuperRate && this.canSuper()) {
        const key = this._pickSuper(self)
        if (key) {
          out.attack = key
          return hold(0, 20, 30)
        }
      }
      if (r < this.attackRate) {
        out.attack = attack
        return hold(0, 6, 14)
      }
      if (r < this.attackRate + 0.25) return hold(-1, 8, 18) // 往後拉開一點
      if (r < this.attackRate + 0.4) return hold(0, 5, 10) // 停一下觀察
      return hold(1, 4, 8) // 再貼近一點
    }

    // footsies：剛好在出拳距離外（打不到、也很難被打到）來回晃，騙對手出拳揮空，再由 whiffPunish 反擊
    const [, reach] = this._getWindow('heavy')
    if (this.footsies && dist > reach && dist < reach + 0.5 && r < 0.75) {
      if (r < 0.35) return hold(0, 8, 16) // 停在原地等
      if (r < 0.55) return hold(-1, 5, 9) // 退一點
      return hold(1, 4, 7) // 往前探一點（引誘出拳）
    }

    // 遠距離：走近 / 衝刺 / 偶爾跳
    if (dist > 2.6) {
      if (r < 0.2) {
        out.dash = toward
        return hold(1, 15, 25)
      }
      if (r < 0.25 && dist < 3.2) {
        out.jump = true
        out.move = toward
        return hold(1, 50, 55)
      }
      return hold(1, 15, 35)
    }

    // 中距離：走近為主，偶爾跳入 / 衝刺 / 後退 / 停一下
    if (r < this.jumpInRate && dist > 1.8) {
      out.jump = true
      out.move = toward
      return hold(1, 50, 55)
    }
    if (r < 0.2) {
      out.dash = toward
      return hold(1, 10, 20)
    }
    if (r < 0.32) return hold(-1, 10, 20)
    if (r < 0.42) return hold(0, 6, 12)
    return hold(1, 10, 25)
  }

  /**
   * 對空：對手起跳時決定這次怎麼應對（每次跳躍只決定一次、只出手一次）
   * - 'air'（airToAirRate 機率）：對手還沒開始往下掉、距離夠近 → 自己也跳起來，空中用拳腳迎擊（空中出招見 think 的 3.）
   * - 'ground'：站在原地等，算對手還有幾幀落地，等到輕拳的前搖剛好接上落地時才出拳（中拳距離就用中拳）
   * 太近（快被跳過頭）就先退開；其餘時間不亂揮
   * @returns {boolean} 這一幀由對空接手
   */
  _antiAir(self, opp, dist, toward, out) {
    const isJumping = opp.isAirborne && !opp.isLaunched && opp.state !== 'hit' && opp.state !== 'down'
    if (!isJumping) {
      this.oppJump = null
      return false
    }
    if (!this.antiAir) return false
    this.oppJump ??= { mode: Math.random() < this.airToAirRate ? 'air' : 'ground', done: false }
    const plan = this.oppJump
    if (dist > 2.2) return false
    if (plan.done) {
      out.move = 0 // 這次跳躍已經出過手：等他落地，不再對空中亂揮
      return true
    }

    // 還有幾幀落地：跳躍拋物線照跳躍總幀數算；自由落下（空中被打過、空中衝刺後）用高度估
    const apex = (opp.jump.apexRate ?? 0.5) * opp.jump.air
    const isFalling = opp.isJumpArc ? opp.airFrame > apex : (opp.vy ?? 0) <= 0
    const toLand = opp.isJumpArc ? opp.jump.air - opp.airFrame : Math.ceil(opp.y / 0.06)

    if (plan.mode === 'air') {
      // 對手還在往上或剛到頂點、距離夠近：跳起來迎擊；已經在往下掉就改成地面對空
      if (!isFalling && dist < 1.8) {
        plan.done = true
        out.jump = true
        out.move = dist > 1.2 ? toward : 0
        return true
      }
      if (isFalling) plan.mode = 'ground'
      return false
    }

    // 地面對空：等對手快落地，讓拳的攻擊判定剛好在落地時出來
    const key = ['light', 'medium'].find(k => {
      const [near, far] = this._getWindow(k)
      return self.moves[k] && dist >= near && dist <= far
    })
    if (key && isFalling && toLand <= self.moves[key].startup + 1) {
      plan.done = true
      out.attack = key
      return true
    }
    if (dist < 0.6) {
      out.move = -toward // 快被跳過頭：先退開
      return true
    }
    out.move = 0 // 站著等，不亂揮
    return true
  }

  /** 招式的出拳距離區間 [最近, 最遠]：有 attackWindows 照它，否則 0 ~ ranges */
  _getWindow(key) {
    return this.attackWindows?.[key] || [0, this.ranges[key]]
  }

  /** 這個距離打得到的拳腳（隨機選一個）；都打不到回傳 null */
  _pickAttack(dist, keys = ['light', 'medium', 'heavy']) {
    const weights = { light: 0.45, medium: 0.35, heavy: 0.2 }
    const inRange = keys.filter(k => {
      const [near, far] = this._getWindow(k)
      return dist >= near && dist <= far
    })
    if (!inRange.length) return null
    const total = inRange.reduce((sum, k) => sum + weights[k], 0)
    let r = Math.random() * total
    return inRange.find(k => (r -= weights[k]) <= 0) || inRange[inRange.length - 1]
  }

  /** 隨機挑一個這個人物有動作的絕招 */
  _pickSuper(self) {
    const list = this.supers.filter(k => self.actions[k] && self.moves[k] && !self.lockedMoves?.has(k)) // 還沒解鎖的不放
    return list.length ? pick(list) : null
  }

  /**
   * 連段：拳打中後開始，照路線一步一步按；被打、被防禦、揮空、斷掉太久就放棄
   * @returns {boolean} 這一幀由連段接手（不做其他決定）
   */
  _updateCombo(self, opp, selfStarted, out) {
    // 開始：拳打中（不是被防禦）的第一幀
    if (!this.combo && self.state === 'attack' && self.hitConfirmed && this.comboFrom !== self) {
      // 防禦絕招後的重拳反擊（forceRoute）：一定接連段、走指定路線
      const forced = this.forceRoute?.[0] === self.currentMove ? this.forceRoute : null
      const route = forced ? [forced] : COMBOS.filter(c => c[0] === self.currentMove)
      if (route.length && (forced || Math.random() < this.comboRate)) {
        this.combo = { route: pick(route), step: 1, pressedStep: 0, idle: 0, superKey: this._pickSuper(self) }
      }
      this.forceRoute = null
      this.comboFrom = self // 同一下命中只判斷一次（回到非出招狀態時清掉）
    }
    if (self.state !== 'attack') this.comboFrom = null
    const combo = this.combo
    if (!combo) return false

    // 前進到下一步：衝刺取消開始了、或下一招開始了
    const item = combo.route[combo.step]
    const key = item === 'super' ? combo.superKey : item
    const prevStep = combo.step
    if (item === 'rush' && self.isRushing) combo.step++
    else if (item !== 'rush' && selfStarted && self.currentMove === key) combo.step++
    // 簡單難度：每往下一步有 comboDropRate 機率直接放棄連段
    if (combo.step !== prevStep && Math.random() < this.comboDropRate) {
      this.combo = null
      return false
    }

    // 放棄：被打、被防禦、路線走完、或回到自由狀態一陣子
    const isBroken = ['hit', 'block', 'down'].includes(self.state)
      || (self.state === 'attack' && self.connected && !self.hitConfirmed)
      || combo.step >= combo.route.length
      || !key
    combo.idle = self.canAct ? combo.idle + 1 : 0
    if (isBroken || combo.idle > 4) {
      this.combo = null
      return false
    }

    if (combo.pressedStep === combo.step) return true // 這一步已經按過了，等它開始

    // gaugeAware：對手血量低、絕招量條夠 → 下一步直接接絕招收尾（衝刺取消那一步不能直接接，跳過）
    const gauges = this.getGauges()
    if (this.gaugeAware && gauges && combo.superKey && combo.route[combo.step] !== 'super' && combo.route[combo.step] !== 'rush'
      && gauges.opp.hp <= this.killHp && this.canSuper()) {
      combo.route = [...combo.route.slice(0, combo.step), 'super']
    }
    // gaugeAware：動力槽不夠衝刺取消（會產生虛血、扣血）→ 連段停在這裡
    if (this.gaugeAware && gauges && combo.route[combo.step] === 'rush' && gauges.self.dg < gauges.self.barSize * gauges.self.rushBars) {
      this.combo = null
      return false
    }

    const next = combo.route[combo.step]
    const nextKey = next === 'super' ? combo.superKey : next

    // SG 不滿 1 格：連段停在 SA 前
    if (next === 'super' && !this.canSuper()) {
      this.combo = null
      return false
    }

    if (next === 'rush') {
      // 衝刺取消：打中後、招式還沒結束
      if (self.canRush && self.hitConfirmed) {
        out.rush = true
        combo.pressedStep = combo.step
      }
    } else if (self.isRushing) {
      // 衝刺取消中：直接按（前幾幀不能出招時 Fighter 會先記住）
      out.attack = nextKey
      combo.pressedStep = combo.step
    } else if (self.state === 'attack' && self.hitConfirmed) {
      // 攻擊取消：打中後馬上按下一招（命中當下還在預約時段內；過了的話由收招預約在招式結束時接上）
      out.attack = nextKey
      combo.pressedStep = combo.step
    }
    return true
  }
}
