/**
 * Roguelike：關卡制 + 每關結束選 1 張升級牌（試做）
 * - P2 血量歸 0、倒地後（起身動畫前 1 幀，見 Combat hooks.onKO）出現 choices 張牌，選 1 張套用到 P1
 * - 初始只有 startSupers 的絕招，其他絕招要靠「習得」牌解鎖，依序放進絕招欄位（數字鍵盤 4 / 5 / 6），欄位滿了就不再出「習得」
 * - 每次出 3 張牌，三類各 1 張（GROUPS）：絕招 / 攻擊與體力 / 量條回復；某類沒有可以出的牌時改從其他類補
 * - 升級分兩種：
 *   fighter 類（攻擊力、招式變化、解鎖）：記在 state，換人物（新的 Fighter）時由 applyFighter 重新套用
 *   gauge 類（HP 上限、動力槽 / 絕招量條回復）：選到時直接改 P1 的 Gauge（Gauge 不會因換人物重建；重新開始時還原）
 *
 * 新增升級牌：在 CARDS 加一筆 { id, group, title, desc(run), isAvailable(run), apply(run, ctx) }
 *   ctx = { fighter, gauge }（P1）；desc / isAvailable 可省略
 */

// 牌的分類（出牌時每類各抽 1 張，照這個順序排）
const GROUPS = [
  { id: 'super', name: '絕招' },
  { id: 'power', name: '攻擊 / 體力' },
  { id: 'gauge', name: '量條回復' },
]

const CARDS = [
  // ---------- 絕招 ----------
  {
    id: 'unlock',
    group: 'super',
    // 抽牌時決定要解鎖哪一招（payload），每張「習得」牌各自不同
    makePayload: run => pick(run.getLockedSupers()),
    // 還有沒學的絕招、而且絕招欄位還有空格
    isAvailable: run => run.getLockedSupers().length > 0 && run.state.slots.length < run.slotLabels.length,
    title: (run, key) => `習得：${run.getMoveName(key)}`,
    desc: (run, key) => `解鎖絕招「${run.getMoveName(key)}」，放進絕招欄位（數字鍵盤 ${run.slotLabels[run.state.slots.length]}）`,
    apply: (run, ctx, key) => {
      run.state.slots.push(key)
      run.applyFighter(ctx.fighter)
    },
  },
  {
    id: 'dodgeStep',
    group: 'super',
    isAvailable: run => run.state.slots.includes('dodge_step'),
    title: run => `${run.getMoveName('dodge_step')} +1 次`,
    desc: run => `打中時多穿越 1 次，加在最後一擊（2000）之前（目前多 ${run.state.dodgeStep} 次）；多出來的每一次傷害 -50，最多 -300`,
    apply: (run, ctx) => {
      run.state.dodgeStep++
      run.applyFighter(ctx.fighter)
    },
  },

  // ---------- 攻擊 / 體力 ----------
  {
    id: 'attack',
    group: 'power',
    title: () => '攻擊力 +20%',
    desc: run => `所有招式傷害 ×${(1 + 0.2 * (run.state.attack + 1)).toFixed(1)}（目前 ×${(1 + 0.2 * run.state.attack).toFixed(1)}）`,
    apply: (run, ctx) => {
      run.state.attack++
      run.applyFighter(ctx.fighter)
    },
  },
  {
    id: 'maxHp',
    group: 'power',
    title: () => 'HP 上限 +1000',
    desc: (run, _, ctx) => `HP 上限 ${ctx.gauge.maxHp} → ${ctx.gauge.maxHp + 1000}，並立刻回復 1000 HP`,
    apply: (run, ctx) => {
      ctx.gauge.maxHp += 1000
      ctx.gauge.hp = Math.min(ctx.gauge.maxHp, ctx.gauge.hp + 1000)
    },
  },

  // ---------- 量條回復 ----------
  {
    id: 'dgRegen',
    group: 'gauge',
    title: () => '動力槽回復 +50%',
    desc: (run, _, ctx) => `動力槽每秒回復 ${Math.round(ctx.gauge.dgRegen)} → ${Math.round(ctx.gauge.dgRegen * 1.5)}`,
    apply: (run, ctx) => { ctx.gauge.dgRegen *= 1.5 },
  },
  {
    id: 'sgRegen',
    group: 'gauge',
    title: () => '絕招量條回復 +50%',
    desc: (run, _, ctx) => `絕招量條每秒回復 ${Math.round(ctx.gauge.sgRegen)} → ${Math.round(ctx.gauge.sgRegen * 1.5)}`,
    apply: (run, ctx) => { ctx.gauge.sgRegen *= 1.5 },
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

function pick(list) {
  return list[Math.floor(Math.random() * list.length)]
}

function shuffle(list) {
  const a = [...list]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

export class Roguelike {
  constructor(options) {
    const def = {
      el: '#cardPick',
      choices: 3, // 每次出幾張牌
      startSupers: ['dodge_step'], // 一開始就會的絕招（依序放進絕招欄位）
      slotLabels: ['4', '5', '6'], // 絕招欄位的按鍵顯示文字；欄位數 = 最多能學幾招
      enemyHpPerStage: 500, // 敵人每往上一層 HP 上限多多少
      getContext: () => null, // () => { fighter, gauge }：P1 目前的 Fighter 與 Gauge
      onPicked: null, // (card) => 選完牌（main.js 開始下一關）
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
    this.offer = [] // 目前出的牌：[{ card, payload }]
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

  /** 選牌或結算視窗開著：遊戲停住、遊戲按鍵不理 */
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
    const ctx = this.getContext()
    if (ctx?.gauge && this.gaugeBase) Object.assign(ctx.gauge, this.gaugeBase)
    this.gaugeBase = null
    this.state = this._newState()
    this.stage = 1
    this.applyFighter(ctx?.fighter)
    this.isGameOver = false
    this.overEl.hidden = true
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

  /** P2 被打倒：出牌（已經在選就不理） */
  open() {
    const ctx = this.getContext()
    if (this.isMenuOpen || !ctx?.fighter || !this.rootEl) return
    // 每類各抽 1 張；某類沒有可以出的牌，就從其他類剩下的牌補
    const available = shuffle(CARDS.filter(card => !card.isAvailable || card.isAvailable(this)))
    const picked = GROUPS.map(group => available.find(card => card.group === group.id)).filter(Boolean)
    const rest = available.filter(card => !picked.includes(card))
    while (picked.length < this.choices && rest.length) picked.push(rest.shift())
    this.offer = picked.slice(0, this.choices).map(card => ({ card, payload: card.makePayload?.(this) }))
    this._render(ctx)
    this.isChoosing = true
    this.rootEl.hidden = false
  }

  /** 選第 index 張（0 起算；按鍵 1 / 2 / 3 或點牌） */
  choose(index) {
    const chosen = this.offer[index]
    const ctx = this.getContext()
    if (!this.isChoosing || !chosen || !ctx) return
    this.gaugeBase ??= { maxHp: ctx.gauge.maxHp, dgRegen: ctx.gauge.dgRegen, sgRegen: ctx.gauge.sgRegen }
    chosen.card.apply(this, ctx, chosen.payload)
    this.isChoosing = false
    this.rootEl.hidden = true
    this.stage++
    this.onPicked?.(chosen)
  }

  /** 把 fighter 類的升級套到 P1（新建 Fighter 後也要呼叫）：招式鎖定、攻擊力、招式變化 */
  applyFighter(fighter) {
    if (!fighter) return
    fighter.lockedMoves = new Set(this._getSuperKeys(fighter).filter(key => !this.state.slots.includes(key)))
    fighter.damageRate = 1 + 0.2 * this.state.attack
    const dodge = fighter.moves.dodge_step?.repeatOnHit
    if (dodge) {
      fighter.runBase ??= { dodgeTimes: dodge.times }
      dodge.times = fighter.runBase.dodgeTimes + this.state.dodgeStep
    }
  }

  /** 還沒解鎖的絕招 key */
  getLockedSupers() {
    const fighter = this.getContext()?.fighter
    return fighter ? this._getSuperKeys(fighter).filter(key => !this.state.slots.includes(key)) : []
  }

  getMoveName(key) {
    return this.getContext()?.fighter?.moves[key]?.name || key
  }

  // internal

  /** slots：絕招欄位依序放的招式 key（沒放進欄位的絕招都鎖住） */
  _newState() {
    return { slots: [...this.startSupers], attack: 0, dodgeStep: 0 }
  }

  _getSuperKeys(fighter) {
    return Object.keys(fighter.moves).filter(key => fighter.moves[key].category === 'super')
  }

  _render(ctx) {
    if (this.titleEl) this.titleEl.textContent = `第 ${this.stage} 層突破！選擇 1 張升級`
    this.listEl.innerHTML = ''
    this.offer.forEach(({ card, payload }, i) => {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'index_cards-card'
      btn.dataset.index = i
      btn.innerHTML = '<span class="_head"><span class="_key"></span><span class="_group"></span></span><strong class="_title"></strong><span class="_desc"></span>'
      btn.querySelector('._key').textContent = i + 1
      btn.querySelector('._group').textContent = GROUPS.find(g => g.id === card.group)?.name || ''
      btn.querySelector('._title').textContent = card.title(this, payload, ctx)
      btn.querySelector('._desc').textContent = card.desc?.(this, payload, ctx) || ''
      this.listEl.append(btn)
    })
  }
}
