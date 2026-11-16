/**
 * FighterAI：電腦操作的玩家，每幀看雙方狀態回傳按鍵（跟鍵盤輸入同格式，交給 main.js 同一套預約 / 衝刺取消流程）
 * - 走位：遠了走近 / 衝刺 / 偶爾跳入，近了保持距離、偶爾後退；不會長時間站著不動
 * - 攻擊：只在打得到的距離出拳（依距離選輕 / 中 / 重），對手收招破綻時反擊，偶爾直接放絕招
 * - 防禦：對手出招時，經過反應時間後有一定機率防禦
 * - 連段：拳打中（不是被防禦）後照 combos 的路線接下去：拳 → 拳（攻擊取消）→ 0（衝刺取消）→ … → 絕招
 */

// 連段路線：第一招打中後依第一招選路線；'rush' = 按 0 衝刺取消、'super' = 絕招
const COMBOS = [
  ['heavy', 'rush', 'heavy', 'medium', 'rush', 'medium', 'light', 'rush', 'light', 'light', 'light', 'super'],
  ['medium', 'medium', 'rush', 'medium', 'medium', 'rush', 'heavy', 'medium', 'super'],
  ['light', 'light', 'light', 'rush', 'light', 'light', 'light', 'super'],
  ['light', 'light', 'rush', 'light', 'medium', 'rush', 'medium', 'heavy', 'rush', 'medium', 'light', 'super'],
]

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
    this.reset()
  }

  // public

  /** 狀態全部清掉（Esc 重置、切換 AI 時用） */
  reset() {
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
  think(self, opp) {
    this.frame++
    const out = { move: 0, attack: null, rush: false, dash: 0, jump: false, guard: false }
    const toward = Math.sign(opp.x - self.x) || self.facingSign
    const dist = Math.abs(opp.x - self.x)

    const selfStarted = this._isNewMove(self, 'self')
    const oppStarted = this._isNewMove(opp, 'opp')

    // 對手剛出招：決定要不要防禦（反應時間後才開始擋）、收招時要不要反擊
    if (oppStarted) {
      const move = opp.getCurrentMove()
      const isThreat = dist < 2.4 || move?.isSuper
      this.guard = isThreat ? { at: this.frame + randInt(...this.reaction), will: Math.random() < this.guardRate } : null
      this.punish = Math.random() < this.punishRate
    }

    // 1. 連段
    if (this._updateCombo(self, opp, selfStarted, out)) return out

    // 2. 防禦：對手出招中（還沒收招）、或已經在防禦硬直中就繼續擋
    const oppThreat = opp.state === 'attack' && opp.getFrameType() !== 'recovery'
    if (self.state === 'block' || (oppThreat && this.guard?.will && this.frame >= this.guard.at)) {
      out.guard = true
      return out
    }

    // 3. 空中：下降時接近對手就出空中重攻擊
    if (self.state === 'air') {
      if (!self.hasAirAttacked && dist < 1.4 && self.airFrame >= self.jump.air * 0.4) out.attack = 'heavy'
      return out
    }

    if (!self.canAct) return out

    // 4. 對手收招有破綻、距離夠近：反擊（出手快的優先）
    if (opp.state === 'attack' && opp.getFrameType() === 'recovery' && this.punish) {
      const key = this._pickAttack(dist, ['light', 'medium'])
      if (key) {
        this.punish = false
        out.attack = key
        return out
      }
    }

    // 5. 對手倒地起身中（無敵）：不出手，保持中距離等他起來
    const oppDown = opp.state === 'down' && !opp.isLaunched
    if (oppDown) {
      out.move = dist < 1.6 ? -toward : dist > 2.2 ? toward : 0
      return out
    }

    // 6. 中立：照計畫走位，在出拳距離內有機率出手
    if (!this.plan || this.frame >= this.plan.until) this._makePlan(self, opp, dist, out, toward)
    if (out.attack || out.jump || out.dash) return out
    out.move = this.plan.move * toward
    // 別一直退到牆邊
    if (this.plan.move < 0 && Math.abs(self.x) > 5) out.move = 0
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
      if (r < this.rawSuperRate) {
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

  /** 這個距離打得到的拳腳（隨機選一個）；都打不到回傳 null */
  _pickAttack(dist, keys = ['light', 'medium', 'heavy']) {
    const weights = { light: 0.45, medium: 0.35, heavy: 0.2 }
    const inRange = keys.filter(k => dist <= this.ranges[k])
    if (!inRange.length) return null
    const total = inRange.reduce((sum, k) => sum + weights[k], 0)
    let r = Math.random() * total
    return inRange.find(k => (r -= weights[k]) <= 0) || inRange[inRange.length - 1]
  }

  /** 隨機挑一個這個人物有動作的絕招 */
  _pickSuper(self) {
    const list = this.supers.filter(k => self.actions[k] && self.moves[k])
    return list.length ? pick(list) : null
  }

  /**
   * 連段：拳打中後開始，照路線一步一步按；被打、被防禦、揮空、斷掉太久就放棄
   * @returns {boolean} 這一幀由連段接手（不做其他決定）
   */
  _updateCombo(self, opp, selfStarted, out) {
    // 開始：拳打中（不是被防禦）的第一幀
    if (!this.combo && self.state === 'attack' && self.hitConfirmed && this.comboFrom !== self) {
      const route = COMBOS.filter(c => c[0] === self.currentMove)
      if (route.length && Math.random() < this.comboRate) {
        this.combo = { route: pick(route), step: 1, pressedStep: 0, idle: 0, superKey: this._pickSuper(self) }
      }
      this.comboFrom = self // 同一下命中只判斷一次（回到非出招狀態時清掉）
    }
    if (self.state !== 'attack') this.comboFrom = null
    const combo = this.combo
    if (!combo) return false

    // 前進到下一步：衝刺取消開始了、或下一招開始了
    const item = combo.route[combo.step]
    const key = item === 'super' ? combo.superKey : item
    if (item === 'rush' && self.state === 'dash' && self.isRush) combo.step++
    else if (item !== 'rush' && selfStarted && self.currentMove === key) combo.step++

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

    const next = combo.route[combo.step]
    const nextKey = next === 'super' ? combo.superKey : next
    if (combo.pressedStep === combo.step) return true // 這一步已經按過了，等它開始

    if (next === 'rush') {
      // 衝刺取消：打中後、招式還沒結束
      if (self.canRush && self.hitConfirmed) {
        out.rush = true
        combo.pressedStep = combo.step
      }
    } else if (self.state === 'dash' && self.isRush) {
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
