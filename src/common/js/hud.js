import * as THREE from 'three'

/**
 * Hud：疊在畫面上的 HTML 資訊
 * - 人物腳底的即時座標（x、y = 腳底離地高度，跳起來時會變），可從 GUI 開關
 * - 連段數：P1、P2 各自計數，P1 在畫面左側、P2 在畫面右側
 */
export class Hud {
  constructor(options) {
    const def = {
      camera: null,
      canvas: null, // renderer.domElement，用來換算螢幕座標
      coords: ['#coordP1', '#coordP2'],
      combo: { p1: '#comboP1', p2: '#comboP2' },
      showCoords: true,
      comboMin: 2, // 幾下以上才顯示
      comboHideDelay: 1.2, // 連段結束後幾秒淡出（秒）
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
    this.coordEls = this.coords.map(selector => document.querySelector(selector))
    // 4. setup runtime state
    // 連段數：每個玩家一組（元素、目前數字、淡出倒數）
    this.combos = Object.fromEntries(Object.entries(this.combo).map(([slot, selector]) => {
      const el = document.querySelector(selector)
      return [slot, { el, numEl: el.querySelector('._num'), count: 0, hideTimer: 0 }]
    }))
    this.projected = new THREE.Vector3()

    // 5. init
    this.init()
  }

  init() {
    this.setCoordsVisible(this.showCoords)
  }

  // public

  setCoordsVisible(isVisible) {
    this.showCoords = isVisible
    this.coordEls.forEach(el => el.classList.toggle('is_hide', !isVisible))
  }

  /** 每次畫面更新：座標文字跟著人物腳底移動 */
  updateCoords(fighters) {
    if (!this.showCoords) return
    const { clientWidth: w, clientHeight: h } = this.canvas

    fighters.forEach((fighter, i) => {
      const el = this.coordEls[i]
      if (!fighter) return

      this.projected.set(fighter.x, fighter.y, 0).project(this.camera)
      const left = (this.projected.x * 0.5 + 0.5) * w
      const top = (-this.projected.y * 0.5 + 0.5) * h
      el.style.transform = `translate(${left}px, ${top}px)`
      el.textContent = `x ${fighter.x.toFixed(2)}　y ${fighter.y.toFixed(2)}`
    })
  }

  /**
   * 設定某個玩家的連段數；0 代表連段結束，延遲一下再淡出
   * @param {'p1' | 'p2'} slot
   */
  setCombo(slot, count) {
    const combo = this.combos[slot]
    if (count === combo.count) return
    combo.count = count

    if (count < this.comboMin) {
      combo.hideTimer = this.comboHideDelay
      return
    }

    combo.hideTimer = 0
    combo.numEl.textContent = count
    combo.el.classList.add('is_show')
    // 重新觸發彈跳動畫
    combo.el.classList.remove('is_pop')
    void combo.el.offsetWidth
    combo.el.classList.add('is_pop')
  }

  update(delta) {
    Object.values(this.combos).forEach(combo => {
      if (combo.hideTimer <= 0) return
      combo.hideTimer -= delta
      if (combo.hideTimer <= 0) combo.el.classList.remove('is_show')
    })
  }
}
