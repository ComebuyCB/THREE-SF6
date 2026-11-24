const ARROWS = {
  '0,0': '', '0,1': '↑', '0,-1': '↓', '-1,0': '←', '1,0': '→',
  '-1,1': '↖', '1,1': '↗', '-1,-1': '↙', '1,-1': '↘',
}
// 按鍵 → 樣式（顏色在 CSS）；沒有 text 的是圓點
const BUTTONS = {
  light: { className: 'is_light' },
  medium: { className: 'is_medium' },
  heavy: { className: 'is_heavy' },
  rush: { className: 'is_rush', text: 'X' },
  DI: { className: 'is_drive', text: 'DI' },
}

/**
 * InputHistory：按鍵的歷史紀錄（最新的在最上面）
 * 每一列 = 當時的方向（上下左右、斜向）+ 按下的鍵：方向改變、按下按鍵時多一列；同時按的鍵（mergeTime 內）放在同一列
 * 放開方向（回到中立）不另外記一列
 */
export class InputHistory {
  constructor(options) {
    const def = {
      el: '#inputHistory',
      max: 10, // 最多顯示幾列
      mergeTime: 50, // 幾毫秒內按的鍵算同時按（放同一列）
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

    // 4. setup runtime state
    this.arrow = '' // 現在的方向
    this.rowTime = -Infinity // 最上面那列的時間（毫秒）
  }

  // public

  /** 方向鍵有變化（x：-1 左 / 1 右；y：-1 下 / 1 上）：改變成另一個方向才多一列 */
  setDirection(x, y, now) {
    const arrow = ARROWS[`${x},${y}`]
    if (arrow === this.arrow) return
    this.arrow = arrow
    if (arrow) this._addRow(now)
  }

  /** 按下按鍵（BUTTONS 的 key） */
  press(key, now) {
    const { className, text = '' } = BUTTONS[key] ?? {}
    if (!this.rootEl || !className) return
    const isMerge = now - this.rowTime <= this.mergeTime && this.rootEl.firstElementChild?.dataset.arrow === this.arrow
    const row = isMerge ? this.rootEl.firstElementChild : this._addRow(now)
    const btn = document.createElement('span')
    btn.className = `_btn ${className}`
    btn.textContent = text
    row.append(btn)
  }

  setVisible(isVisible) {
    this.rootEl?.classList.toggle('is_uiHide', !isVisible)
  }

  clear() {
    if (this.rootEl) this.rootEl.innerHTML = ''
    this.rowTime = -Infinity
  }

  // internal

  _addRow(now) {
    if (!this.rootEl) return null
    const row = document.createElement('li')
    row.className = '_row'
    row.dataset.arrow = this.arrow
    const arrow = document.createElement('span')
    arrow.className = '_arrow'
    arrow.textContent = this.arrow
    row.append(arrow)
    this.rootEl.prepend(row)
    while (this.rootEl.children.length > this.max) this.rootEl.lastElementChild.remove()
    this.rowTime = now
    return row
  }
}
