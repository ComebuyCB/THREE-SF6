const BUTTON_LABELS = { light: '輕', medium: '中', heavy: '重', rush: 'X', DI: 'DI' }

// 按鍵對照（兩種模式的鍵不同）：[按鍵 key, 格鬥模式, 自由模式]
const LEGEND = [
  ['light', '7', '滑鼠左鍵'],
  ['medium', '8', '滑鼠左右鍵'],
  ['heavy', '9', '滑鼠右鍵'],
  ['rush', '0', 'Shift'],
  ['DI', '6', 'R'],
]

const escapeHtml = text => String(text).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
const button = key => `<span class="_btn is_${key}">${BUTTON_LABELS[key]}</span>`
const dir = arrow => `<span class="_dir">${arrow}</span>`
const plus = '<span class="_sep">+</span>'
const next = '<span class="_sep">▸</span>'

/**
 * MoveList：招式表（主選單 → 招式表）
 * 內容照人物的招式表（moveSets.js）產生：指令、名稱、說明（desc）、特性、幀數、消耗；打開時重新產生
 */
export class MoveList {
  constructor(options) {
    const def = {
      el: '#moveList',
      getFighter: () => null, // () => 要顯示招式的 Fighter（P1）
      getGauge: () => null, // () => 他的 Gauge（每格點數，換算消耗幾格用）
      isFree: () => false, // () => 是不是自由模式（按鍵對照不同）
      onClose: null, // () => 按「返回」
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
    this.nameEl = this.rootEl?.querySelector('.js-moves-name')
    this.legendEl = this.rootEl?.querySelector('.js-moves-legend')
    this.bodyEl = this.rootEl?.querySelector('.js-moves-body')

    // 5. init
    this.init()
  }

  init() {
    this.rootEl?.querySelector('.js-moves-close')?.addEventListener('click', () => this.onClose?.())
  }

  // public

  get isOpen() {
    return !!this.rootEl && !this.rootEl.hidden
  }

  open() {
    const fighter = this.getFighter()
    if (!this.rootEl || !fighter) return
    this._render(fighter)
    this.rootEl.hidden = false
    this.bodyEl.scrollTop = 0
  }

  close() {
    if (this.rootEl) this.rootEl.hidden = true
  }

  /** 上下捲動（W / S） */
  scroll(sign) {
    this.bodyEl?.scrollBy({ top: sign * 120, behavior: 'smooth' })
  }

  // internal

  _render(fighter) {
    const isFree = this.isFree()
    this.nameEl.textContent = fighter.name
    this.legendEl.innerHTML = LEGEND.map(([key, fight, free]) => `<li>${button(key)}<span>${isFree ? free : fight}</span></li>`).join('')
      + `<li>${dir('→')}<span>${isFree ? 'D' : '面向的方向'}</span></li><li>${dir('←')}<span>${isFree ? 'A' : '背後的方向'}</span></li><li>${dir('↓')}<span>S</span></li>`

    const { moves } = fighter
    const keys = category => Object.keys(moves).filter(key => moves[key].category === category)
    const supers = keys('super').sort((a, b) => this._getCost(moves[a]) - this._getCost(moves[b]) || this._getDirOrder(moves[a]) - this._getDirOrder(moves[b]))
    const costs = [...new Set(supers.map(key => this._getCost(moves[key])))]

    const left = this._section('普通攻擊', '', keys('normal').map(key => this._row(fighter, key, button(key))).join('')
      + keys('air').map(key => this._row(fighter, key, dir('空中') + plus + button(moves[key].replaces ?? key))).join(''))
      + this._section('連擊', 'TARGET COMBO', keys('tc').map(key => this._row(fighter, key, this._getChain(moves, key))).join(''))
      + this._section('動力系統', 'DRIVE', keys('drive').map(key => this._row(fighter, key, button('DI'))).join('') + this._rushRow(fighter))
    const right = this._section('超必殺', 'SUPER ART', costs.map(cost => `<li class="index_moves-cost">${this._cells(cost)}<span>消耗 ${cost} 格 SG</span></li>`
      + supers.filter(key => this._getCost(moves[key]) === cost).map(key => this._row(fighter, key, this._getCommand(moves[key]), true)).join('')).join(''), 'is_super')
    this.bodyEl.innerHTML = `<div class="_col">${left}</div><div class="_col">${right}</div>`
  }

  _section(title, sub, rows, className = '') {
    if (!rows) return ''
    return `<section class="index_moves-section ${className}"><h3 class="_title">${title}<small>${sub}</small></h3><ul class="_list">${rows}</ul></section>`
  }

  _row(fighter, key, command, isSuper = false) {
    const move = fighter.moves[key]
    const tags = this._getTags(move)
    const frames = isSuper ? '' : this._getFrames(fighter, key)
    return `<li class="index_moves-row">
      <span class="_cmd">${command}</span>
      <span class="_info"><strong class="_name">${escapeHtml(move.name || key)}</strong>${tags.map(tag => `<em class="_tag is_${tag.type}">${tag.text}</em>`).join('')}
        ${move.desc ? `<span class="_desc">${escapeHtml(move.desc)}</span>` : ''}${frames ? `<span class="_frames">${frames}</span>` : ''}</span>
    </li>`
  }

  _rushRow(fighter) {
    const bars = this.getGauge()?.rushBars ?? 3
    const names = fighter.rush.moves.map(key => fighter.moves[key]).filter(move => move?.category === 'normal').map(move => move.name.replace('攻擊', ''))
    return `<li class="index_moves-row">
      <span class="_cmd">${button('rush')}</span>
      <span class="_info"><strong class="_name">衝刺取消</strong><em class="_tag is_cost">DG ${bars} 格</em>
        <span class="_desc">${names.join('、')}打中或被防禦後按，往前衝刺，可以再接招式；平常按前 + X 也可以。DG 不足時改扣白血</span></span>
    </li>`
  }

  _getCost(move) {
    return move.sgCost ?? 1
  }

  _getDirOrder(move) {
    return move.command?.dir === 'back' ? 1 : 0
  }

  /** 絕招的指令：↓ ↘ → + 攻擊鍵（往後 = ↓ ↙ ←） */
  _getCommand({ command }) {
    if (!command) return ''
    const arrows = command.dir === 'back' ? ['↓', '↙', '←'] : ['↓', '↘', '→']
    return arrows.map(dir).join('') + plus + button(command.button)
  }

  /** TC 從第一招一路接到這招要按的鍵 */
  _getChain(moves, key) {
    const path = []
    for (let k = key; moves[k]; k = moves[k].from?.[0]) {
      path.unshift(moves[k].by?.[0] ?? k)
      if (moves[k].category !== 'tc') break
    }
    return path.map(button).join(next)
  }

  _getTags(move) {
    const barSize = this.getGauge()?.barSize ?? 6000
    const isLaunch = !!move.launch || !!move.onTarget?.stand?.launch
    return [
      move.dgCost && { type: 'cost', text: `DG ${+(move.dgCost / barSize).toFixed(1)} 格` },
      move.on && { type: 'cond', text: move.on === 'hit' ? '打中後' : '打中 / 被防禦後' },
      move.armor && { type: 'armor', text: `霸體 ×${move.armor.hits}` },
      move.cancelAttack && { type: 'cond', text: '可取消攻擊' },
      (move.invincible || move.invincibleFrames) && { type: 'inv', text: '無敵' },
      move.grab && { type: 'grab', text: '抓技' },
      isLaunch && { type: 'launch', text: '擊飛' },
    ].filter(Boolean)
  }

  /** 發生 / 持續 / 收招 */
  _getFrames(fighter, key) {
    const move = fighter.moves[key]
    if (move.hits || move.startup == null) return ''
    const total = Math.min(fighter.getClipLength(key) || Infinity, move.length ?? Infinity)
    const active = move.activeFrames ?? total - move.startup - move.recovery
    const recovery = move.holdUntilLand ? '到落地' : `${move.recovery}F`
    return `發生 ${move.startup + 1}F<i></i>持續 ${Number.isFinite(active) ? active : '--'}F<i></i>收招 ${recovery}`
  }

  /** SG 格子：cost 格亮、其餘暗 */
  _cells(cost) {
    const max = this.getGauge()?.maxBars ?? 5
    return `<span class="_cells">${Array.from({ length: max }, (_, i) => `<i class="${i < cost ? 'is_on' : ''}"></i>`).join('')}</span>`
  }
}
