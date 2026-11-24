import * as THREE from 'three'

/**
 * HitEffect：打擊特效，放在命中點
 * 一次特效 = 閃光（瞬間亮起再縮小淡出）+ 火花粒子（往打擊方向噴出、受重力下墜）
 * 種類：一般命中 hit、重擊 heavy（重拳 / 絕招，火花數量與噴出速度是 hit 的 heavyRate 倍）、防禦住 block
 *
 * 特效一律疊在最上層（不做深度測試）、不受場景的霧影響，命中點在身體裡也看得到
 * 時間用秒計算，由呼叫端傳入已乘上遊戲速度的 delta（頓幀期間特效照常播放，打擊感比較強）
 */
export class HitEffect {
  constructor(options) {
    const def = {
      scene: null,
      /**
       * 各打擊結果的特效數據
       * color：火花顏色；coreColor：閃光顏色；count：火花數量；speed：火花初速（公尺 / 秒）
       * size：火花大小（公尺）；flashSize：閃光直徑（公尺）；life：特效秒數
       */
      presets: {
        hit: { color: 0xffa030, coreColor: 0xfff0c0, count: 18, speed: 3.5, size: 0.06, flashSize: 0.55, life: 0.35 },
        block: { color: 0x4fb0ff, coreColor: 0xe0f4ff, count: 12, speed: 2.5, size: 0.05, flashSize: 0.45, life: 0.25 },
      },
      heavyRate: 1.2, // 重擊（heavy）：樣式同 hit，火花數量與噴出速度（擴散距離）乘上這個倍率
      gravity: 6, // 火花往下掉的加速度（公尺 / 秒²）
      drag: 3, // 火花減速（每秒衰減 e^-drag）
      spread: 0.6, // 噴出方向的發散程度：0 = 全部往打擊方向、1 = 四面八方
      depthScale: 0.4, // 前後（Z）方向的噴出比例，橫向格鬥畫面不需要往鏡頭噴太多
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
    this.bursts = [] // 播放中的特效：{ time, life, preset, flash, points, velocities, lifeScales, baseColor }
    this.glowTexture = this._createGlowTexture()
  }

  // public

  /**
   * 在命中點產生一次特效
   * @param {THREE.Vector3} position 命中點（世界座標）
   * @param {{ type?: 'hit' | 'heavy' | 'block', dir?: number }} options dir：打擊方向（世界座標 -1 / 1），火花往這邊噴
   */
  spawn(position, { type = 'hit', dir = 1 } = {}) {
    const preset = this._getPreset(type)

    const flash = new THREE.Sprite(this._createSpriteMaterial(this.glowTexture, preset.coreColor))
    flash.position.copy(position)
    flash.renderOrder = 10
    this.scene.add(flash)

    const { points, velocities, lifeScales } = this._createSparks(position, preset, dir)
    this.scene.add(points)

    this.bursts.push({ time: 0, life: preset.life, preset, flash, points, velocities, lifeScales, baseColor: new THREE.Color(preset.color) })
  }

  /** 推進 delta 秒（暫停時傳 0） */
  update(delta) {
    if (!delta) return
    this.bursts = this.bursts.filter(burst => {
      burst.time += delta
      const t = burst.time / burst.life
      if (t >= 1) {
        this._dispose(burst)
        return false
      }
      this._updateFlash(burst, t)
      this._updateSparks(burst, delta, t)
      return true
    })
  }

  /** 清掉所有特效（重置用） */
  clear() {
    this.bursts.forEach(burst => this._dispose(burst))
    this.bursts = []
  }

  // internal

  /** heavy = hit 的火花數量與噴出速度乘上 heavyRate */
  _getPreset(type) {
    if (type !== 'heavy') return this.presets[type] || this.presets.hit
    const hit = this.presets.hit
    return { ...hit, count: Math.round(hit.count * this.heavyRate), speed: hit.speed * this.heavyRate }
  }

  /** 閃光：前 20% 時間從 40% 放大到全尺寸，前半段淡出 */
  _updateFlash({ flash, preset }, t) {
    const grow = Math.min(1, t / 0.2)
    flash.scale.setScalar(preset.flashSize * (0.4 + 0.6 * (1 - (1 - grow) ** 2)))
    flash.material.opacity = Math.max(0, 1 - t * 2)
  }

  /** 火花：重力 + 減速；用頂點顏色變暗來淡出（疊加混色下黑色 = 看不見），每顆壽命略有不同 */
  _updateSparks({ points, velocities, lifeScales, baseColor }, delta, t) {
    const positions = points.geometry.attributes.position
    const colors = points.geometry.attributes.color
    const damping = Math.exp(-this.drag * delta)

    for (let i = 0; i < positions.count; i++) {
      const v = velocities[i]
      v.y -= this.gravity * delta
      v.multiplyScalar(damping)
      positions.setXYZ(i, positions.getX(i) + v.x * delta, positions.getY(i) + v.y * delta, positions.getZ(i) + v.z * delta)

      const fade = Math.max(0, 1 - t / lifeScales[i])
      colors.setXYZ(i, baseColor.r * fade, baseColor.g * fade, baseColor.b * fade)
    }
    positions.needsUpdate = true
    colors.needsUpdate = true
  }

  /** 建立火花：方向 = 隨機方向往打擊方向偏，速度 50% ~ 100% */
  _createSparks(position, preset, dir) {
    const { count, speed, size } = preset
    const positions = new Float32Array(count * 3)
    const colors = new Float32Array(count * 3)
    const velocities = []
    const lifeScales = []
    const bias = (1 - this.spread) * 2

    for (let i = 0; i < count; i++) {
      position.toArray(positions, i * 3)
      const v = new THREE.Vector3().randomDirection()
      v.x += dir * bias
      v.z *= this.depthScale
      v.normalize().multiplyScalar(speed * (0.5 + Math.random() * 0.5))
      velocities.push(v)
      lifeScales.push(0.6 + Math.random() * 0.4)
    }

    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    const material = new THREE.PointsMaterial({
      size,
      map: this.glowTexture,
      vertexColors: true,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      fog: false,
    })
    const points = new THREE.Points(geometry, material)
    points.frustumCulled = false // 粒子會飛出建立時的範圍
    points.renderOrder = 10
    return { points, velocities, lifeScales }
  }

  _createSpriteMaterial(map, color) {
    return new THREE.SpriteMaterial({
      map,
      color,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      fog: false,
    })
  }

  /** 中心亮、往外漸暗的圓形光點（閃光與火花共用） */
  _createGlowTexture() {
    return this._createCanvasTexture(ctx => {
      const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32)
      gradient.addColorStop(0, 'rgba(255, 255, 255, 1)')
      gradient.addColorStop(0.25, 'rgba(255, 255, 255, 0.8)')
      gradient.addColorStop(1, 'rgba(255, 255, 255, 0)')
      ctx.fillStyle = gradient
      ctx.fillRect(0, 0, 64, 64)
    })
  }

  _createCanvasTexture(draw) {
    const canvas = document.createElement('canvas')
    canvas.width = 64
    canvas.height = 64
    draw(canvas.getContext('2d'))
    const texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = THREE.SRGBColorSpace
    return texture
  }

  /** 移除特效；貼圖是共用的，不 dispose */
  _dispose({ flash, points }) {
    this.scene.remove(flash)
    flash.material.dispose()
    this.scene.remove(points)
    points.geometry.dispose()
    points.material.dispose()
  }
}
