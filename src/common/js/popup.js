/**
 * Popup：按鈕開關的小視窗（操作說明 (?)、除錯 (bug)）
 * root 裡要有：.js-popup-toggle（開關按鈕）、.js-popup-panel（視窗，[hidden] 收起）、.js-popup-close（視窗裡的 ×）
 */
export class Popup {
  constructor(options) {
    const def = {
      el: null,
      onToggle: null, // (popup, isOpen)：開關後呼叫（main.js 用來一次只開一個）
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
    this.root = document.querySelector(this.el)
    this.toggleEl = this.root.querySelector('.js-popup-toggle')
    this.panelEl = this.root.querySelector('.js-popup-panel')
    this.closeEl = this.root.querySelector('.js-popup-close')

    // 5. init
    this.init()
  }

  init() {
    this.bindEvents()
  }

  bindEvents() {
    this.toggleEl.addEventListener('click', () => this.toggle())
    this.closeEl?.addEventListener('click', () => this.toggle(false))
  }

  // public

  get isOpen() {
    return !this.panelEl.hidden
  }

  /** 開關；isOpen 沒給 = 切換 */
  toggle(isOpen = !this.isOpen) {
    this.panelEl.hidden = !isOpen
    this.toggleEl.setAttribute('aria-expanded', String(isOpen))
    this.onToggle?.(this, isOpen)
  }
}
