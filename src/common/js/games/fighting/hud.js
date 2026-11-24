import * as THREE from 'three'

/**
 * Hud：疊在畫面上的 HTML 資訊
 * - 人物腳底的即時座標（x、y = 腳底離地高度，跳起來時會變），可從 GUI 開關
 * - 連段數：P1、P2 各自計數，P1 在畫面左側、P2 在畫面右側
 * - 血量（含虛血）、動力槽（DG）在上方，絕招量條（SG）在下方；數值來自 Combat.gauges（gauge.js）
 */
export class Hud {
  constructor(options) {
    const def = {
      camera: null,
      canvas: null, // renderer.domElement，用來換算螢幕座標
      coords: ['#coordP1', '#coordP2'],
      combo: { p1: '#comboP1', p2: '#comboP2' },
      status: { p1: '#statusP1', p2: '#statusP2' }, // 血量 + 動力槽
      superGauge: { p1: '#superP1', p2: '#superP2' }, // 絕招量條
      comboDebug: '#comboDebug', // 連段傷害（除錯）
      gameSpeed: '.js-game-speed', // 遊戲速度（連段傷害上方）
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
    // 量條：每個玩家一組元素
    this.gauges = Object.fromEntries(Object.keys(this.status).map(slot => {
      const status = document.querySelector(this.status[slot])
      const superGauge = document.querySelector(this.superGauge[slot])
      const hp = status.querySelector('.js-gauge-hp')
      const dg = status.querySelector('.js-gauge-dg')
      const sg = superGauge.querySelector('.js-gauge-sg')
      return [slot, {
        status,
        name: status.querySelector('.js-status-name'), // DG 另一側的角色名字
        hp,
        dg,
        sg,
        dgCells: [...dg.children],
        sgCells: [...sg.children],
        sgNum: superGauge.querySelector('.js-gauge-sg-num'),
      }]
    }))
    // 連段傷害（除錯）：每個玩家一欄
    const comboDebugEl = document.querySelector(this.comboDebug)
    this.comboDebugEls = Object.fromEntries(['p1', 'p2'].map(slot => {
      const col = comboDebugEl?.querySelector(`._col.is_${slot}`)
      return [slot, { damage: col?.querySelector('.js-combo-damage'), scale: col?.querySelector('.js-combo-scale') }]
    }))
    this.gameSpeedEl = comboDebugEl?.querySelector(this.gameSpeed)
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

  /** 每次畫面更新：座標文字（x、y、z，公尺）跟著人物腳底移動；格鬥模式 z 固定 0，自由模式會前後走動 */
  updateCoords(fighters) {
    if (!this.showCoords) return
    const { clientWidth: w, clientHeight: h } = this.canvas

    fighters.forEach((fighter, i) => {
      const el = this.coordEls[i]
      if (!fighter) return

      const { x, y, z } = fighter.model.position
      this.projected.set(x, y, z).project(this.camera)
      const left = (this.projected.x * 0.5 + 0.5) * w
      const top = (-this.projected.y * 0.5 + 0.5) * h
      el.style.transform = `translate(${left}px, ${top}px)`
      el.textContent = `x ${x.toFixed(2)}　y ${y.toFixed(2)}　z ${z.toFixed(2)}`
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

  /**
   * 每次畫面更新：血量、虛血、DG、SG 寫進畫面
   * @param {{ p1: Gauge, p2: Gauge }} gauges
   */
  updateGauges(gauges) {
    Object.entries(this.gauges).forEach(([slot, els]) => {
      const g = gauges[slot]
      if (!g) return
      els.hp.style.setProperty('--hp', g.hp / g.maxHp)
      els.hp.style.setProperty('--wl', Math.min(g.wl, g.hp) / g.maxHp) // 虛血最多畫到剩下的血量
      this._fitCells(els.dg, els.dgCells, g.dgMaxBars)
      this._fitCells(els.sg, els.sgCells, g.maxBars)
      this._setCells(els.dgCells, g.dg, g.barSize)
      this._setCells(els.sgCells, g.sg, g.barSize)
      this._setText(els.sgNum, Math.floor(g.sg / g.barSize))
      this._setAttr(els.hp, 'aria-valuemax', g.maxHp)
      this._setAttr(els.dg, 'aria-valuemax', g.dgMaxPoints)
      this._setAttr(els.sg, 'aria-valuemax', g.maxPoints)
      this._setAttr(els.hp, 'aria-valuenow', Math.round(g.hp))
      this._setAttr(els.dg, 'aria-valuenow', Math.round(g.dg))
      this._setAttr(els.sg, 'aria-valuenow', Math.round(g.sg))
    })
  }

  /** DG 另一側顯示角色名字 */
  setName(slot, name) {
    const el = this.gauges[slot]?.name
    if (el) el.textContent = name
  }

  /** AI 操作中：名字旁的紅點閃爍 */
  setAI(slot, isOn) {
    this.gauges[slot]?.status.classList.toggle('is_ai', isOn)
  }

  /**
   * 連段傷害（除錯）：這次（或上一次）連段的總傷害、下一擊的補正
   * @param {{ p1: { scale: number, damage: number }, p2: { scale: number, damage: number } }} stats Combat.comboStats
   */
  updateComboDebug(stats) {
    Object.entries(this.comboDebugEls).forEach(([slot, els]) => {
      const stat = stats[slot]
      if (!stat || !els.damage) return
      this._setText(els.damage, stat.damage)
      this._setText(els.scale, `${Math.round(stat.scale * 100)}%`)
    })
  }

  /** 遊戲速度：暫停時顯示「暫停」 */
  updateGameSpeed(timeScale, isPaused) {
    const el = this.gameSpeedEl
    if (!el) return
    this._setText(el, isPaused ? '暫停' : `遊戲速度 ${+timeScale.toFixed(2)}x`)
    el.classList.toggle('is_paused', isPaused)
  }

  update(delta) {
    Object.values(this.combos).forEach(combo => {
      if (combo.hideTimer <= 0) return
      combo.hideTimer -= delta
      if (combo.hideTimer <= 0) combo.el.classList.remove('is_show')
    })
  }

  // internal

  /** 格數跟 HTML 的不一樣時補 / 拿掉格子 */
  _fitCells(rootEl, cells, count) {
    while (cells.length < count) {
      const cell = document.createElement('span')
      cell.className = '_cell'
      rootEl.append(cell)
      cells.push(cell)
    }
    while (cells.length > count) cells.pop().remove()
  }

  /** 分格量條：每格 barSize 點，寫入每格的填滿比例（--fill），滿格加 is_full */
  _setCells(cells, value, barSize) {
    cells.forEach((cell, i) => {
      const fill = Math.min(1, Math.max(0, value / barSize - i))
      cell.style.setProperty('--fill', fill)
      cell.classList.toggle('is_full', fill >= 1)
    })
  }

  /** 數值有變才寫入，避免每個畫面都改 DOM */
  _setText(el, value) {
    if (el.textContent !== String(value)) el.textContent = value
  }

  _setAttr(el, name, value) {
    if (el.getAttribute(name) !== String(value)) el.setAttribute(name, value)
  }
}
