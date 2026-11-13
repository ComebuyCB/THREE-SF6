import * as THREE from 'three'

/**
 * Stage：場地（地板、左右邊界牆、X 軸刻度尺）
 * 刻度尺畫在 canvas 貼圖上，平貼在地板，跟著場景一起被鏡頭拍到
 */
export class Stage {
  constructor(options) {
    const def = {
      scene: null,
      halfWidth: 4, // 邊界：x = ±halfWidth
      wallHeight: 3,
      rulerDepth: 0.6, // 刻度尺在 z 方向的寬度
      rulerZ: 0.55, // 刻度尺放在人物前方（靠鏡頭）一點，才不會被腳擋住
      pixelsPerMeter: 128,
      showRuler: true,
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
    this.ruler = null
    this.walls = []

    // 5. init
    this.init()
  }

  init() {
    this._setupGround()
    this._setupWalls()
    this._setupRuler()
    this.setRulerVisible(this.showRuler)
  }

  // public

  setRulerVisible(isVisible) {
    this.showRuler = isVisible
    this.ruler.visible = isVisible
  }

  // internal

  /** 地板只顯示影子（透明），讓背景全景圖的地面露出來 */
  _setupGround() {
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.ShadowMaterial({ opacity: 0.45 }))
    ground.rotation.x = -Math.PI / 2
    ground.receiveShadow = true
    this.scene.add(ground)
  }

  /** 左右邊界：半透明的牆 + 地上的紅線 */
  _setupWalls() {
    const geo = new THREE.PlaneGeometry(2, this.wallHeight)
    const mat = new THREE.MeshBasicMaterial({ color: 0xff5566, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false })
    const lineMat = new THREE.LineBasicMaterial({ color: 0xff5566 })

    ;[-1, 1].forEach(side => {
      const x = side * this.halfWidth
      const wall = new THREE.Mesh(geo, mat)
      wall.position.set(x, this.wallHeight / 2, 0)
      wall.rotation.y = Math.PI / 2

      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(x, 0.01, -1), new THREE.Vector3(x, 0.01, 1)]),
        lineMat,
      )
      this.walls.push(wall)
      this.scene.add(wall, line)
    })
  }

  /** X 軸刻度尺：每 0.1 公尺短刻度、0.5 公尺中刻度、1 公尺標數字 */
  _setupRuler() {
    const margin = 0.5 // 邊界外多畫一點
    const width = (this.halfWidth + margin) * 2
    const ppm = this.pixelsPerMeter
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(width * ppm)
    canvas.height = Math.round(this.rulerDepth * ppm)
    const ctx = canvas.getContext('2d')
    const toPx = x => (x + width / 2) * ppm
    const h = canvas.height

    ctx.fillStyle = 'rgba(0, 0, 0, 0.35)'
    ctx.fillRect(0, 0, canvas.width, h)
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)'
    ctx.fillStyle = 'rgba(255, 255, 255, 0.9)'
    ctx.font = `bold ${Math.round(h * 0.38)}px system-ui, sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'bottom'

    // 中心線
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(0, 2)
    ctx.lineTo(canvas.width, 2)
    ctx.stroke()

    // i 以 0.1 公尺為單位、從 0 往兩側數，整數公尺才會剛好落在 i % 10 === 0
    const half = Math.round((width / 2) * 10)
    for (let i = -half; i <= half; i++) {
      const x = i / 10
      const isMeter = i % 10 === 0
      const isHalf = i % 5 === 0
      ctx.lineWidth = isMeter ? 3 : 1.5
      ctx.beginPath()
      ctx.moveTo(toPx(x), 0)
      ctx.lineTo(toPx(x), h * (isMeter ? 0.45 : isHalf ? 0.3 : 0.15))
      ctx.stroke()
      if (isMeter) ctx.fillText(Math.round(x), toPx(x), h - 4)
    }

    const texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = THREE.SRGBColorSpace
    texture.anisotropy = 8

    this.ruler = new THREE.Mesh(
      new THREE.PlaneGeometry(width, this.rulerDepth),
      new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false }),
    )
    this.ruler.rotation.x = -Math.PI / 2
    this.ruler.position.set(0, 0.005, this.rulerZ)
    this.scene.add(this.ruler)
  }
}
