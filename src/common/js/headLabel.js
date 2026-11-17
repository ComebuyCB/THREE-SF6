import * as THREE from 'three'

/**
 * HeadLabel：人物頭上的 3D 文字（Sprite + canvas 貼圖，永遠面向鏡頭，遠近會有大小變化）
 * - 標記（tag）：一直跟著指定人物的頭，例如 P1 頭上的「you」
 * - 絕招名（title）：絕招發動時顯示在頭的斜上方、鏡頭的另一側，演出結束淡出
 *
 * 文字不做深度測試、不受霧影響，不會被身體擋住，絕招演出的霧裡也看得清楚
 * 位置在 render 前更新（用畫面補間後的姿勢），淡入淡出用真實秒數（暫停時照常）
 */
export class HeadLabel {
  constructor(options) {
    const def = {
      scene: null,
      camera: null,
      tag: {
        text: 'you',
        height: 0.16, // 文字高度（公尺）
        offsetY: 0.32, // 頭骨上方多高（公尺）
        color: '#ffffff',
        stroke: '#1b1d22',
      },
      title: {
        height: 0.18,
        // 文字中心相對頭骨的位置（公尺）：up 往上（比標記高，不會疊在一起）、side 往鏡頭的另一側（左右）、back 遠離鏡頭
        // 演出拉近時畫面很窄，side 太大文字會超出畫面
        offset: { up: 0.55, side: 0.2, back: 0.2 },
        colors: ['#fff6c8', '#ffd23f', '#c98a12'], // 金色漸層：上 → 下
        stroke: '#3a2400',
        fadeIn: 0.15, // 秒
        fadeOut: 0.3,
      },
      font: '900 96px system-ui, sans-serif', // canvas 上的字（解析度用，實際大小由 height 決定）
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
    this.tagFighter = null
    this.tagSprite = null
    this.titleFighter = null
    this.titleSprite = null
    this.titleOpacity = 0
    this.isTitleShow = false
    this.head = new THREE.Vector3()
    this.toHead = new THREE.Vector3()
    this.forward = new THREE.Vector3()
    this.right = new THREE.Vector3()

    // 5. init
    this.init()
  }

  init() {
    this.tagSprite = this._createSprite(this.tag.text, { height: this.tag.height, fill: this.tag.color, stroke: this.tag.stroke })
    this.tagSprite.visible = false
    this.scene.add(this.tagSprite)
  }

  // public

  /** 標記要跟著的人物（null = 不顯示） */
  setTagTarget(fighter) {
    this.tagFighter = fighter
  }

  /** 絕招發動：在人物頭的斜上方顯示絕招名 */
  showTitle(fighter, text) {
    this._disposeTitle()
    this.titleFighter = fighter
    this.titleSprite = this._createSprite(text, { height: this.title.height, fill: this.title.colors, stroke: this.title.stroke })
    this.titleSprite.material.opacity = 0
    this.scene.add(this.titleSprite)
    this.titleOpacity = 0
    this.isTitleShow = true
  }

  /** 絕招名淡出 */
  hideTitle() {
    this.isTitleShow = false
  }

  /** 每次畫面更新（render 前）：跟著頭移動、處理淡入淡出 */
  update(delta) {
    this._updateTag()
    this._updateTitle(delta)
  }

  /** 立刻清掉絕招名（重置用） */
  clearTitle() {
    this._disposeTitle()
  }

  // internal

  _updateTag() {
    const fighter = this.tagFighter
    this.tagSprite.visible = !!fighter?.model
    if (!this.tagSprite.visible) return
    fighter.getHeadPosition(this.head)
    this.tagSprite.position.copy(this.head)
    this.tagSprite.position.y += this.tag.offsetY
  }

  /**
   * 絕招名位置：頭 + 往上 + 往鏡頭的另一側
   * 「另一側」= 頭偏在畫面中心的哪一邊（鏡頭在另一邊），文字就再往那邊偏；鏡頭正對頭時，往人物面向的那邊
   */
  _updateTitle(delta) {
    if (!this.titleSprite) return
    const { fadeIn, fadeOut, offset } = this.title
    this.titleOpacity = this.isTitleShow
      ? Math.min(1, this.titleOpacity + delta / fadeIn)
      : Math.max(0, this.titleOpacity - delta / fadeOut)
    if (!this.isTitleShow && this.titleOpacity <= 0) {
      this._disposeTitle()
      return
    }
    this.titleSprite.material.opacity = this.titleOpacity

    const fighter = this.titleFighter
    fighter.getHeadPosition(this.head)
    // 鏡頭看的水平方向（遠離鏡頭）與畫面右方
    this.camera.getWorldDirection(this.forward).setY(0).normalize()
    this.right.set(-this.forward.z, 0, this.forward.x)
    const across = this.toHead.subVectors(this.head, this.camera.position).dot(this.right)
    const sideSign = Math.abs(across) > 0.05 ? Math.sign(across) : Math.sign(this.right.x * fighter.facingSign) || 1

    this.titleSprite.position.copy(this.head)
      .addScaledVector(this.forward, offset.back)
      .addScaledVector(this.right, offset.side * sideSign)
    this.titleSprite.position.y += offset.up
  }

  /**
   * 文字 Sprite：寬高依文字長度，height 為世界高度（公尺）
   * @param {string | string[]} fill 單色或由上到下的漸層色
   */
  _createSprite(text, { height, fill, stroke }) {
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    ctx.font = this.font
    const pad = 24
    const fontSize = parseInt(this.font.match(/(\d+)px/)[1], 10)
    canvas.width = Math.ceil(ctx.measureText(text).width) + pad * 2
    canvas.height = fontSize + pad * 2

    // 改了 canvas 尺寸後設定會重置，要重新指定
    ctx.font = this.font
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.lineJoin = 'round'
    const x = canvas.width / 2
    const y = canvas.height / 2
    ctx.lineWidth = fontSize * 0.14
    ctx.strokeStyle = stroke
    ctx.strokeText(text, x, y)
    if (Array.isArray(fill)) {
      const gradient = ctx.createLinearGradient(0, y - fontSize / 2, 0, y + fontSize / 2)
      fill.forEach((color, i) => gradient.addColorStop(i / (fill.length - 1), color))
      ctx.fillStyle = gradient
    } else {
      ctx.fillStyle = fill
    }
    ctx.fillText(text, x, y)

    const texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = THREE.SRGBColorSpace
    const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false, fog: false })
    const sprite = new THREE.Sprite(material)
    sprite.scale.set(height * canvas.width / canvas.height, height, 1)
    sprite.renderOrder = 20
    return sprite
  }

  _disposeTitle() {
    if (!this.titleSprite) return
    this.scene.remove(this.titleSprite)
    this.titleSprite.material.map.dispose()
    this.titleSprite.material.dispose()
    this.titleSprite = null
    this.titleFighter = null
    this.isTitleShow = false
  }
}
