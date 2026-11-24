// invincible：絕招開頭的無敵幀，顯示跟倒地一樣的白色，但算在招式的全體幀數裡
// frozen：絕招演出停留期間的前搖（只是凍結狀態下播出的動畫），綠色虛線，也算在招式的全體幀數裡
// armor：霸體（動力衝擊前搖），紫色，算在招式的全體幀數裡
// grab：抓技判定（招式 grab.from ~ to），咖啡色，算在招式的全體幀數裡
const TYPES = ['startup', 'active', 'recovery', 'stun', 'block', 'dash', 'down', 'invincible', 'armor', 'frozen', 'grab', 'prejump', 'air', 'landing']
const JUMP_TYPES = ['prejump', 'air', 'landing'] // 跳躍：起跳前 / 滯空 / 落地硬直，另外統計
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
      length: 100, // 容器格數，需為 RULER_STEP 的倍數
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
    this._setMarks(0, this.length, 0) // 還沒記錄時也顯示刻度的數字
    this._renderInfo(true)
  }

  // public

  /**
   * 記錄 1 幀
   * @param {Array<'startup' | 'active' | 'recovery' | 'stun' | 'block' | 'dash' | 'down' | 'invincible' | 'armor' | 'frozen' | 'grab' | 'prejump' | 'air' | 'landing' | null>} types 依 rows 順序（P1、P2）
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
      this.stats = this.rows.map(() => ({ attackStart: -1, firstActive: -1, activeCount: 0, attackFrames: 0, lastBusy: -1, prejump: 0, air: 0, landing: 0 }))
      this.isRecording = true
      this._renderInfo(true)
    }

    const pos = this.index % this.length
    const frame = this.index + 1

    // 快寫滿時先清掉前面，繞回第 1 格時才有空位
    if (pos === this.length - this.clearAhead) this._clearRange(0, pos, this.index - pos + this.length)

    types.forEach((type, row) => {
      this._track(row, type)
      const cell = this.cells[row][pos]
      cell.classList.remove(...TYPES.map(t => `is_${t}`))
      if (type) cell.classList.add(`is_${type}`)
      cell.title = `${frame}F`
    })

    if (pos % RULER_STEP === 0) this.marks[pos / RULER_STEP].textContent = frame

    this.index++
  }

  // internal

  /** 清掉 [start, end) 格，刻度換成接下來要寫的幀數（base = 這一輪第 1 格是第幾幀，0 起算） */
  _clearRange(start, end, base = 0) {
    this.cells.forEach(row => {
      for (let i = start; i < end; i++) {
        row[i].classList.remove(...TYPES.map(t => `is_${t}`))
        row[i].removeAttribute('title')
      }
    })
    this._setMarks(start, end, base)
  }

  /** [start, end) 格的刻度數字 */
  _setMarks(start, end, base) {
    for (let i = Math.ceil(start / RULER_STEP); i * RULER_STEP < end; i++) this.marks[i].textContent = base + i * RULER_STEP + 1
  }

  _track(row, type) {
    const stat = this.stats[row]
    if (!type) return

    stat.lastBusy = this.index
    if (JUMP_TYPES.includes(type)) {
      stat[type]++
      return
    }
    if (type === 'stun' || type === 'block' || type === 'dash' || type === 'down') return

    // 空中攻擊時，發生從出招那幀算起，不含前面的跳躍
    if (stat.attackStart < 0) stat.attackStart = this.index
    stat.attackFrames++
    if (type === 'active') {
      if (stat.firstActive < 0) stat.firstActive = this.index
      stat.activeCount++
    }
  }

  /**
   * 發生 / 持續 / 全體 / 硬直差（以 P1 視角，正數代表 P1 先能動）：記錄停止時結算，沒有的項目寫 --
   * isEmpty：還沒記錄 / 記錄中，全部寫 --
   */
  _renderInfo(isEmpty = false) {
    const [p1, p2] = isEmpty ? [] : this.stats
    const has = isEmpty ? {} : { attack: p1.attackFrames > 0, active: p1.firstActive >= 0, both: p1.lastBusy >= 0 && p2.lastBusy >= 0 }
    const advantage = has.both ? p2.lastBusy - p1.lastBusy : 0
    const items = [
      ['共', isEmpty ? null : this.index],
      // 快打的「發生」是第一個攻擊判定幀的編號，所以前搖 5 幀 = 發生 6F
      ['發生', has.active ? p1.firstActive - p1.attackStart + 1 : null],
      ['持續', has.active ? p1.activeCount : null],
      ['全體', has.attack ? p1.attackFrames : null],
      ['硬直差', has.both ? `${advantage > 0 ? '+' : ''}${advantage}` : null],
    ]
    if (!isEmpty && p1.landing) items.push(['落地', p1.landing])
    this.infoEl.textContent = items.map(([name, value]) => `${name} ${value ?? '--'}F`).join('　')
  }
}
