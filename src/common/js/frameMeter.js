const TYPES = ['startup', 'active', 'recovery', 'stun', 'block', 'dash', 'down']
const RULER_STEP = 10 // 刻度每幾格標一次幀數

/**
 * FrameMeter：仿快打旋風 6 的幀數表
 * 任一方進入非自由狀態（出招 / 硬直 / 倒地）時開始記錄，雙方都恢復自由後停止並結算數據；
 * 下一次有人行動時清空重來。頓幀與絕招演出期間不記錄（由呼叫端控制）。
 *
 * 容器滿了的處理（環狀）：寫到倒數第 clearAhead 格時，先清掉前面 length - clearAhead 格，
 * 寫滿後繞回第 1 格繼續覆蓋；上方刻度與滑鼠提示顯示實際幀數。
 */
export class FrameMeter {
  constructor(options) {
    const def = {
      el: '#frameMeter',
      rows: ['#frameMeterP1', '#frameMeterP2'],
      ruler: '#frameMeterRuler',
      info: '#frameMeterInfo',
      length: 120, // 容器格數，需為 RULER_STEP 的倍數
      clearAhead: 10,
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
    this.rowEls = this.rows.map(selector => document.querySelector(selector))
    this.rulerEl = document.querySelector(this.ruler)
    this.infoEl = document.querySelector(this.info)
    this.cells = [] // [row][position] → HTMLElement
    this.marks = [] // 刻度，每 RULER_STEP 格一個

    // 4. setup runtime state
    this.isRecording = false
    this.index = 0 // 這次記錄的第幾幀（0 起算，不受繞回影響）
    this.stats = []

    // 5. init
    this.init()
  }

  init() {
    this.cells = this.rowEls.map(rowEl => {
      rowEl.innerHTML = '<i class="index_frameMeter-cell"></i>'.repeat(this.length)
      return [...rowEl.children]
    })

    this.rulerEl.innerHTML = '<span class="_mark"></span>'.repeat(this.length / RULER_STEP)
    this.marks = [...this.rulerEl.children]
  }

  // public

  /**
   * 記錄 1 幀
   * @param {Array<'startup' | 'active' | 'recovery' | 'stun' | 'block' | 'dash' | 'down' | null>} types 依 rows 順序（P1、P2）
   */
  record(types) {
    const isBusy = types.some(Boolean)

    if (!isBusy) {
      if (this.isRecording) {
        this.isRecording = false
        this._renderInfo()
      }
      return
    }

    if (!this.isRecording) {
      this._clearRange(0, this.length)
      this.index = 0
      this.stats = this.rows.map(() => ({ firstActive: -1, activeCount: 0, attackFrames: 0, lastBusy: -1 }))
      this.isRecording = true
    }

    const pos = this.index % this.length
    const frame = this.index + 1

    // 快寫滿時先清掉前面，繞回第 1 格時才有空位
    if (pos === this.length - this.clearAhead) this._clearRange(0, pos)

    types.forEach((type, row) => {
      this._track(row, type)
      const cell = this.cells[row][pos]
      cell.classList.remove(...TYPES.map(t => `is_${t}`))
      if (type) cell.classList.add(`is_${type}`)
      cell.title = `${frame}F`
    })

    if (pos % RULER_STEP === 0) this.marks[pos / RULER_STEP].textContent = frame

    this.infoEl.textContent = `記錄中…　第 ${frame}F`
    this.index++
  }

  // internal

  /** 清掉 [start, end) 格與其刻度 */
  _clearRange(start, end) {
    this.cells.forEach(row => {
      for (let i = start; i < end; i++) {
        row[i].classList.remove(...TYPES.map(t => `is_${t}`))
        row[i].removeAttribute('title')
      }
    })
    for (let i = Math.ceil(start / RULER_STEP); i * RULER_STEP < end; i++) this.marks[i].textContent = ''
  }

  _track(row, type) {
    const stat = this.stats[row]
    if (!type) return

    stat.lastBusy = this.index
    if (type === 'stun' || type === 'block' || type === 'dash' || type === 'down') return

    stat.attackFrames++
    if (type === 'active') {
      if (stat.firstActive < 0) stat.firstActive = this.index
      stat.activeCount++
    }
  }

  /** 結算：發生 / 持續 / 全體 / 硬直差（以 P1 視角，正數代表 P1 先能動） */
  _renderInfo() {
    const [p1, p2] = this.stats
    const parts = [`共 ${this.index}F`]

    if (p1.attackFrames) {
      // 快打的「發生」是第一個攻擊判定幀的編號，所以前搖 5 幀 = 發生 6F
      // 落地硬直等沒有攻擊判定的動作只顯示全體
      if (p1.firstActive >= 0) parts.push(`發生 ${p1.firstActive + 1}F`, `持續 ${p1.activeCount}F`)
      parts.push(`全體 ${p1.attackFrames}F`)
    }

    if (p1.lastBusy >= 0 && p2.lastBusy >= 0) {
      const advantage = p2.lastBusy - p1.lastBusy
      parts.push(`硬直差 ${advantage > 0 ? '+' : ''}${advantage}F`)
    }

    this.infoEl.textContent = parts.join('　')
  }
}
