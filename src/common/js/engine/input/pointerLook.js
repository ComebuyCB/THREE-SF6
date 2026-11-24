/**
 * PointerLook：滑鼠鎖定（游標隱藏）+ 滑鼠移動轉視角（跟玩法無關，第三人稱 / 第一人稱 / 射擊遊戲都能用）
 * - setEnabled(true)：鎖定滑鼠、OrbitControls 不處理滑鼠拖曳（滾輪縮放照常）；false：放開、還原
 * - 鎖定中移動滑鼠 → onLook(dx, dy)（像素）；按滑鼠鍵 → onButton(button)（0 左、1 中、2 右）
 * - 沒鎖定時（例如按 Esc、unlock 放開）點畫面重新鎖定
 * 鎖定滑鼠要在按鍵 / 點擊的事件裡呼叫，瀏覽器才允許
 *
 * 防跳動：Chrome（尤其 Windows）鎖定滑鼠時偶爾會送出一筆數值很大的錯誤移動量，鏡頭就會突然跑位
 * - 鎖定時要求原始滑鼠輸入（unadjustedMovement，不經過系統的滑鼠加速；不支援就退回一般鎖定）
 * - 單筆移動超過 maxStep 像素、或剛鎖定後的第一筆，當成錯誤數值丟掉
 */
export class PointerLook {
  constructor(options) {
    const def = {
      canvas: null,
      controls: null, // OrbitControls（打開時停用它的滑鼠拖曳）
      onLook: null, // (dx, dy)
      onButton: null, // (button)
      isBlocked: null, // () → 暫時不處理滑鼠（例如過場中）
      // () → 鎖定被使用者放開（按 Esc、切換視窗），不是 unlock / setEnabled(false) 放開的
      //   Chrome 鎖定中按 Esc 只會放開鎖定，網頁收不到 keydown，要靠這個知道使用者按了 Esc
      onLost: null,
      maxStep: 250, // 單筆滑鼠移動超過幾像素就當成錯誤數值丟掉
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
    this.isEnabled = false
    this.savedButtons = null // OrbitControls 原本的滑鼠設定
    this.isFreshLock = false // 剛鎖定：下一筆移動丟掉
    this.isReleasing = false // 程式自己放開鎖定中（不算 onLost）

    // 5. init
    this.init()
  }

  init() {
    this.bindEvents()
  }

  bindEvents() {
    const canvas = this.canvas
    // 打開時不讓 OrbitControls 收到按下（它會 setPointerCapture，滑鼠鎖定中會出錯）；滾輪是另一個事件，照常
    canvas.addEventListener('pointerdown', e => {
      if (this.isEnabled) e.stopImmediatePropagation()
    }, { capture: true })
    canvas.addEventListener('mousedown', e => {
      if (!this.isEnabled || this.isBlocked?.()) return
      if (e.button === 1) e.preventDefault() // 中鍵不要觸發瀏覽器的自動捲動
      if (!this.isLocked) {
        this.lock()
        return
      }
      this.onButton?.(e.button)
    })
    document.addEventListener('mousemove', e => {
      if (!this.isEnabled || !this.isLocked) return
      const { movementX: dx, movementY: dy } = e
      if (this.isFreshLock) {
        this.isFreshLock = false
        return
      }
      if (Math.abs(dx) > this.maxStep || Math.abs(dy) > this.maxStep) return // 錯誤數值：丟掉
      this.onLook?.(dx, dy)
    })
    document.addEventListener('pointerlockchange', () => {
      if (this.isLocked) {
        this.isFreshLock = true
        return
      }
      const isUser = !this.isReleasing
      this.isReleasing = false
      if (isUser && this.isEnabled) this.onLost?.()
    })
  }

  // public

  /** 滑鼠目前是不是鎖在畫面上 */
  get isLocked() {
    return document.pointerLockElement === this.canvas
  }

  setEnabled(isOn) {
    if (this.isEnabled === isOn) return
    this.isEnabled = isOn
    const buttons = this.controls?.mouseButtons
    if (isOn) {
      if (buttons) {
        this.savedButtons = { ...buttons }
        Object.assign(buttons, { LEFT: null, MIDDLE: null, RIGHT: null })
      }
      this.lock()
      return
    }
    if (buttons && this.savedButtons) Object.assign(buttons, this.savedButtons)
    this.unlock()
  }

  /** 暫時放開滑鼠（游標出現，可以點 GUI）；點畫面會再鎖定 */
  unlock() {
    if (!this.isLocked) return
    this.isReleasing = true
    document.exitPointerLock()
  }

  /** 鎖定滑鼠；失敗（例如剛按 Esc 放開）就等下次點畫面 */
  lock() {
    const canvas = this.canvas
    const fallback = () => {
      try {
        canvas.requestPointerLock()?.catch?.(() => {})
      } catch {
        // 不支援或被拒絕：維持游標顯示
      }
    }
    try {
      // 原始滑鼠輸入：避開系統加速造成的錯誤移動量；瀏覽器不支援這個選項時會拒絕，改用一般鎖定
      const result = canvas.requestPointerLock({ unadjustedMovement: true })
      if (result?.catch) result.catch(err => err?.name === 'NotSupportedError' && fallback())
    } catch {
      fallback()
    }
  }
}
