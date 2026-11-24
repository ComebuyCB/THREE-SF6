/**
 * Gauge：一名玩家的血量（HP）、動力槽（DG）、絕招量條（SG）、虛血（WL），數值單位都是「點」
 * - DG / SG 每 barSize 點 = 1 格，上限 DG dgMaxBars 格、SG maxBars 格；每幀自然回復
 * - DG 扣到 0 之後要過 dgEmptyDelay 幀才開始回復；防禦住攻擊 blockDgDelay、衝刺取消 rushDgDelay、WL 增加（扣白血）wlDgDelay 幀停止回復（取較長的）
 * - 衝刺取消消耗 rushBars 格 DG；DG 不夠照樣能用：DG 歸 0、WL + emptyRushWL
 * - 防禦時 DG 被扣到 0 以下：DG 顯示 0，扣不下去的部分每 overflowPerWL 點 DG = 1 WL
 * - WL：疊在血量上的白色部分，每幀慢慢減少；被擊中時先扣掉等於 WL 的血量，WL 歸 0
 * - WL 增加後超過血量：多出來的直接扣血，WL 變成跟扣完的血量一樣（例：500 WL / 500 HP，+100 WL → 400 WL / 400 HP）
 * - SA 消耗招式的 sgCost 格 SG，不足不能用
 * - 血量扣到 0 就不再扣，照樣可以連段；被打倒起身時血量回滿（見 Combat._checkGetUp）
 */
export class Gauge {
  constructor(options) {
    const def = {
      maxHp: 10000,
      barSize: 6000, // DG / SG 每格點數
      maxBars: 5, // SG 上限格數
      dgMaxBars: 6, // DG 上限格數
      rushBars: 3, // 衝刺取消消耗幾格 DG
      startDgBars: 6,
      startSgBars: 1,
      fps: 60,
      dgRegen: 3000, // 每秒（60 幀）回復
      sgRegen: 300,
      wlDecay: 200, // 每秒（60 幀）減少
      emptyRushWL: 1000, // DG 不足 rushBars 格時衝刺取消：WL 增加
      overflowPerWL: 10, // 防禦時 DG 扣到 0 以下：每溢出幾點 DG = 1 WL
      dgEmptyDelay: 300, // DG 扣到 0 後，過幾幀才開始回復
      blockDgDelay: 60, // 防禦住攻擊後，DG 停止回復幾幀
      rushDgDelay: 120, // 衝刺取消開始後，DG 停止回復幾幀
      costDgDelay: 60, // 出招消耗 DG（dgCost，動力衝擊）後，DG 停止回復幾幀
      wlDgDelay: 60, // 扣白血（WL 增加）的當下，DG 停止回復幾幀
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

  /** SG 上限點數 */
  get maxPoints() {
    return this.barSize * this.maxBars
  }

  /** DG 上限點數 */
  get dgMaxPoints() {
    return this.barSize * this.dgMaxBars
  }

  /** SG 夠不夠 cost 格 */
  canSuper(cost = 1) {
    return this.sg >= this.barSize * cost
  }

  reset() {
    this.hp = this.maxHp
    this.dg = this.barSize * this.startDgBars
    this.sg = this.barSize * this.startSgBars
    this.wl = 0
    this.dgWait = 0 // DG 扣到 0 後，還要等幾幀才開始回復
    this.dgLocked = false // 被絕招打中後到絕招最後一下前：DG 完全不回復（Combat 控制）
  }

  /** 推進 1 幀：DG / SG 回復、WL 減少 */
  tick() {
    if (this.dgWait > 0) this.dgWait--
    else if (!this.dgLocked) this.dg = Math.min(this.dgMaxPoints, this.dg + this.dgRegen / this.fps)
    this.sg = Math.min(this.maxPoints, this.sg + this.sgRegen / this.fps)
    this.wl = Math.max(0, this.wl - this.wlDecay / this.fps)
  }

  /** DG 增減；扣到 0 以下時，扣不下去的部分換算成 WL */
  addDg(amount) {
    const next = this.dg + amount
    this._setDg(Math.min(this.dgMaxPoints, Math.max(0, next)))
    if (next < 0) this._addWl(-next / this.overflowPerWL)
  }

  addSg(amount) {
    this.sg = Math.min(this.maxPoints, Math.max(0, this.sg + amount))
  }

  /** 被擊中：先扣掉等於 WL 的血量（WL 歸 0），再扣傷害；血量最少到 0 */
  takeHit(damage) {
    this.hp = Math.max(0, this.hp - this.wl - damage)
    this.wl = 0
  }

  /** 霸體擋下攻擊：傷害不扣血，變成 WL（虛血） */
  absorbHit(damage) {
    this._addWl(damage)
  }

  /**
   * 衝刺取消：消耗 rushBars 格 DG；不夠時 DG 歸 0、WL 增加
   * @returns {boolean} DG 不夠、改扣 WL（例如播提示音效）
   */
  useRush() {
    const cost = this.barSize * this.rushBars
    if (this.dg >= cost) {
      this._setDg(this.dg - cost)
      return false
    }
    this._setDg(0)
    this._addWl(this.emptyRushWL)
    return true
  }

  /** SA：消耗 cost 格 SG（呼叫前先用 canSuper 判斷） */
  useSuper(cost = 1) {
    this.sg = Math.max(0, this.sg - this.barSize * cost)
  }

  /**
   * 閒置回復（自由模式）：seconds 秒內 HP 回 rates.hp、WL 減 rates.hp、DG 回 rates.dg、SG 回 rates.sg（點 / 秒），都到上限為止
   * 不受 DG 的回復等待影響（dgWait 清掉）
   */
  recover(seconds, rates) {
    this.hp = Math.min(this.maxHp, this.hp + rates.hp * seconds)
    this.wl = Math.max(0, this.wl - rates.hp * seconds)
    this.dg = Math.min(this.dgMaxPoints, this.dg + rates.dg * seconds)
    this.sg = Math.min(this.maxPoints, this.sg + rates.sg * seconds)
    this.dgWait = 0
  }

  /** 被打倒起身：血量 0 的人回滿血 */
  onGetUp() {
    if (this.hp <= 0) this.hp = this.maxHp
  }

  // internal

  /** DG 停止回復 frames 幀（已經在等更久時不縮短） */
  pauseDgRegen(frames) {
    this.dgWait = Math.max(this.dgWait, frames)
  }

  /** 設定 DG；從有剩變成 0 的那一刻開始等 dgEmptyDelay 幀才回復 */
  _setDg(value) {
    if (value <= 0 && this.dg > 0) this.dgWait = this.dgEmptyDelay
    this.dg = value
  }

  /** WL 增加（扣白血）；超過血量時多出來的直接扣血，WL 跟扣完的血量一樣；DG 停止回復 wlDgDelay 幀 */
  _addWl(amount) {
    this.pauseDgRegen(this.wlDgDelay)
    this.wl += amount
    if (this.wl <= this.hp) return
    this.hp = Math.max(0, this.hp - (this.wl - this.hp))
    this.wl = this.hp
  }
}
