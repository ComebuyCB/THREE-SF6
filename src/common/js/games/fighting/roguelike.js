/**
 * Roguelike：關卡制 + 每關結束在升級樹選 1 個節點（試做）
 * - P2 血量歸 0、倒地後（見 Combat hooks.onKO）打開升級樹，LINES 每條線各往下一級，選 1 條升級，套用到 P1
 * - 升級等級記在 state.levels；換人物（新的 Fighter）時由 applyFighter 重新套用，量條類直接改 P1 的 Gauge（重新開始時還原）
 * - 絕招一開始就全部可以用（方向指令 + 攻擊鍵，SG 不足不能出）
 *
 * 新增升級線：在 LINES 加一筆 { id, title, node, max, desc(run, level) }
 *   node = 每個節點的簡短文字；max = 最多幾級（沒填 = 無上限）；desc 的 level = 選了之後的等級
 *   效果寫在 applyFighter / _applyGauge / getStageReward（用 this.getLevel(id)）
 */

const REGEN_RATE = 0.5 // 量條線：每級 SG / DG 回復速度加原本的幾成
const REGEN_BARS = 1 // 量條線：每級在關卡開始時 SG / DG 各多補幾格
const HP_ADD = 2000 // 體力線：每級 HP 上限加多少
const HEAL_RATE = 0.1 // 體力線：每級過關時多回復最大血量的幾成
const ATTACK_RATE = 0.2 // 攻擊線：每級傷害加原本的幾成
const WINDOW = 5 // 無上限的線：畫面上一次顯示幾個節點

const LINES = [
  {
    id: 'dodge',
    title: run => run.getMoveName('dodge_step'),
    node: '+1 次',
    desc: (run, level) => `打中時多穿越 1 次，加在最後一擊（2000）之前，共多 ${level} 次；多出來的每一次傷害 -50，最多 -300`,
  },
  {
    id: 'regen',
    title: () => 'SG & DG',
    node: '+50%',
    max: 4,
    desc: (run, level) => `SG、DG 回復速度 ×${1 + REGEN_RATE * level}；每次關卡開始時 SG、DG 各多補 ${REGEN_BARS * level} 格`,
  },
  {
    id: 'vital',
    title: () => '體力',
    node: `+${HP_ADD}`,
    max: 5,
    desc: (run, level) => `HP 上限 +${HP_ADD * level}；每次過關回復最大血量的 ${Math.round((run.getBaseReward().hpRate + HEAL_RATE * level) * 100)}%`,
  },
  {
    id: 'attack',
    title: () => '攻擊力',
    node: '+20%',
    desc: (run, level) => `所有招式傷害 ×${(1 + ATTACK_RATE * level).toFixed(1)}`,
  },
]

// 敵人（P2 AI）的難度：第幾層（含）以下 → ai.js AI_LEVELS 的 key
const ENEMY_LEVELS = [
  { maxStage: 3, level: 'easy' },
  { maxStage: 6, level: 'normal' },
  { maxStage: 9, level: 'hard' },
  { maxStage: Infinity, level: 'expert' },
]

// P1 被打倒時的評價：止步在第幾層（含）以下 → 評語
const RANKS = [
  { maxStage: 2, text: '破綻百出' },
  { maxStage: 4, text: '尚欠火候' },
  { maxStage: 6, text: '差強人意' },
  { maxStage: 8, text: '頗具造詣' },
  { maxStage: 10, text: '爐火純青' },
  { maxStage: Infinity, text: '登峰造極！' },
]

export class Roguelike {
  constructor(options) {
    const def = {
      el: '#cardPick',
      enemyHpPerStage: 500, // 敵人每往上一層 HP 上限多多少
      getContext: () => null, // () => { fighter, gauge }：P1 目前的 Fighter 與 Gauge
      getBaseReward: () => ({ hpRate: 0, dgBars: 0, sgBars: 0 }), // () => 過關補給的基本值（main.js stageReward）
      onPicked: null, // (line) => 選完升級（main.js 開始下一關）
      gameOverEl: '#gameOver', // P1 被打倒的結算視窗
      onRestart: null, // () => 按「重新開始」（main.js 雙方回到開場）
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
    this.rootEl = document.querySelector(this.el)
    this.titleEl = this.rootEl?.querySelector('.js-cards-title')
    this.listEl = this.rootEl?.querySelector('.js-cards-list')
    this.overEl = document.querySelector(this.gameOverEl)
    this.overStageEl = this.overEl?.querySelector('.js-over-stage')
    this.overRankEl = this.overEl?.querySelector('.js-over-rank')
    this.restartBtn = this.overEl?.querySelector('.js-over-restart')

    // 4. setup runtime state
    this.stage = 1
    this.isChoosing = false
    this.isGameOver = false
    this.gaugeBase = null // 第一次升級量條前的原始數值，重新開始時還原
    this.state = this._newState()

    // 5. init
    this.init()
  }

  init() {
    this.listEl?.addEventListener('click', e => {
      const btn = e.target.closest('[data-index]')
      if (btn) this.choose(Number(btn.dataset.index))
    })
    this.restartBtn?.addEventListener('click', () => this.restart())
  }

  // public

  /** 升級樹或結算視窗開著：遊戲停住、遊戲按鍵不理 */
  get isMenuOpen() {
    return this.isChoosing || this.isGameOver
  }

  /** P1 被打倒：顯示止步的層數與評價，按「重新開始」從第 1 層重來 */
  gameOver() {
    if (this.isMenuOpen || !this.overEl) return
    if (this.overStageEl) this.overStageEl.textContent = `止步第 ${this.stage} 層`
    if (this.overRankEl) this.overRankEl.textContent = this.getRank(this.stage)
    this.isGameOver = true
    this.overEl.hidden = false
    this.restartBtn?.focus()
  }

  /** 重新開始：回到第 1 層，升級全部清掉（量條回復速度還原），之後由 onRestart 讓雙方回到開場 */
  restart() {
    if (!this.isGameOver) return
    this.reset()
  }

  /** 不管有沒有結算都從第 1 層重來（主選單「重新開始」）；選升級中不處理 */
  reset() {
    if (this.isChoosing) return
    const ctx = this.getContext()
    if (ctx?.gauge && this.gaugeBase) Object.assign(ctx.gauge, this.gaugeBase)
    this.gaugeBase = null
    this.state = this._newState()
    this.stage = 1
    this.applyFighter(ctx?.fighter)
    this.isGameOver = false
    if (this.overEl) this.overEl.hidden = true
    this.onRestart?.()
  }

  /** 止步層數 → 評語 */
  getRank(stage) {
    return RANKS.find(rank => stage <= rank.maxStage).text
  }

  /** 這一層敵人的 AI 難度（AI_LEVELS 的 key） */
  getEnemyLevel(stage = this.stage) {
    return ENEMY_LEVELS.find(e => stage <= e.maxStage).level
  }

  /** 這一層敵人的 HP 上限：基本值 + 每層 enemyHpPerStage */
  getEnemyMaxHp(baseHp, stage = this.stage) {
    return baseHp + this.enemyHpPerStage * (stage - 1)
  }

  /** P2 被打倒：打開升級樹（已經開著就不理） */
  open() {
    if (this.isMenuOpen || !this.getContext()?.fighter || !this.rootEl) return
    this._render()
    this.isChoosing = true
    this.rootEl.hidden = false
  }

  /** 選第 index 條線（0 起算；按鍵 1 ~ 4 或點擊）；已經滿級的線不能選 */
  choose(index) {
    const line = LINES[index]
    const ctx = this.getContext()
    if (!this.isChoosing || !line || !ctx || this._isMax(line)) return
    this.gaugeBase ??= { maxHp: ctx.gauge.maxHp, dgRegen: ctx.gauge.dgRegen, sgRegen: ctx.gauge.sgRegen }
    this.state.levels[line.id]++
    this._applyGauge(ctx.gauge)
    this.applyFighter(ctx.fighter)
    this.isChoosing = false
    this.rootEl.hidden = true
    this.stage++
    this.onPicked?.(line)
  }

  /** 這條線目前幾級 */
  getLevel(id) {
    return this.state.levels[id]
  }

  /** 過關補給：基本值 + 升級（體力線多回血、量條線多補 SG / DG） */
  getStageReward() {
    const base = this.getBaseReward()
    const bars = REGEN_BARS * this.getLevel('regen')
    return {
      hpRate: base.hpRate + HEAL_RATE * this.getLevel('vital'),
      dgBars: base.dgBars + bars,
      sgBars: base.sgBars + bars,
    }
  }

  /** 把 fighter 類的升級套到 P1（新建 Fighter 後也要呼叫）：攻擊力、閃身步次數 */
  applyFighter(fighter) {
    if (!fighter) return
    fighter.damageRate = 1 + ATTACK_RATE * this.getLevel('attack')
    const dodge = fighter.moves.dodge_step?.repeatOnHit
    if (dodge) {
      fighter.runBase ??= { dodgeTimes: dodge.times }
      dodge.times = fighter.runBase.dodgeTimes + this.getLevel('dodge')
    }
  }

  getMoveName(key) {
    return this.getContext()?.fighter?.moves[key]?.name || key
  }

  // internal

  _newState() {
    return { levels: Object.fromEntries(LINES.map(line => [line.id, 0])) }
  }

  _isMax(line) {
    return this.getLevel(line.id) >= (line.max ?? Infinity)
  }

  /** 量條類的升級：從升級前的數值（gaugeBase）重新算 */
  _applyGauge(gauge) {
    const base = this.gaugeBase
    const rate = 1 + REGEN_RATE * this.getLevel('regen')
    gauge.dgRegen = base.dgRegen * rate
    gauge.sgRegen = base.sgRegen * rate
    gauge.maxHp = base.maxHp + HP_ADD * this.getLevel('vital')
  }

  /** 升級樹：每條線一欄，節點由上往下；已升級 is_on、下一級 is_next；整欄都可以點 */
  _render() {
    if (this.titleEl) this.titleEl.textContent = `第 ${this.stage} 層突破！選擇 1 項升級`
    this.listEl.innerHTML = ''
    LINES.forEach((line, i) => {
      const level = this.getLevel(line.id)
      const isMax = this._isMax(line)
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'index_tree-line'
      btn.dataset.index = i
      btn.disabled = isMax
      btn.innerHTML = '<span class="_head"><span class="_key"></span><strong class="_title"></strong><span class="_level"></span></span><span class="_nodes"></span><span class="_desc"></span>'
      btn.querySelector('._key').textContent = i + 1
      btn.querySelector('._title').textContent = line.title(this)
      btn.querySelector('._level').textContent = `${level} / ${line.max ?? '∞'}`
      btn.querySelector('._desc').textContent = isMax ? '已達上限' : line.desc(this, level + 1)
      // 有上限的線顯示全部節點；無上限的線顯示目前附近的 WINDOW 個，最後接 ∞
      const first = line.max ? 1 : Math.max(1, level - 1)
      const count = line.max ?? WINDOW
      const nodes = Array.from({ length: count }, (_, n) => first + n).map(n => {
        const el = document.createElement('span')
        el.className = `_node${n <= level ? ' is_on' : ''}${n === level + 1 ? ' is_next' : ''}`
        el.textContent = `${n}. ${line.node}`
        return el
      })
      if (!line.max) {
        const more = document.createElement('span')
        more.className = '_node is_more'
        more.textContent = '∞'
        nodes.push(more)
      }
      btn.querySelector('._nodes').append(...nodes)
      this.listEl.append(btn)
    })
  }
}
