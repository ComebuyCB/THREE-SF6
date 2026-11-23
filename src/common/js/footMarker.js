import * as THREE from 'three'

/**
 * FootMarker：人物腳底的半透明橢圓（例如標出 P1 是哪一個）
 * 範圍與推擠框（地板判定框 fighter.pushBox）相同：x 方向半寬、z 方向半深都照推擠框，跳起來時仍留在地上
 */
export class FootMarker {
  constructor(options) {
    const def = {
      scene: null,
      color: '#7fd4ff', // 淡藍色
      opacity: 0.25,
      y: 0.005, // 離地高度（公尺）：略高於地板，避免和影子地板重疊閃爍
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
    this.fighter = null
    this.mesh = null
    this.center = new THREE.Vector3()
    this.size = new THREE.Vector3()

    // 5. init
    this.init()
  }

  init() {
    // 半徑 1 的圓，依推擠框大小縮放成橢圓
    const geometry = new THREE.CircleGeometry(1, 48)
    geometry.rotateX(-Math.PI / 2)
    const material = new THREE.MeshBasicMaterial({ color: this.color, transparent: true, opacity: this.opacity, depthWrite: false })
    this.mesh = new THREE.Mesh(geometry, material)
    this.mesh.visible = false
    this.scene.add(this.mesh)
  }

  // public

  /** 要標記的人物（null = 不顯示） */
  setTarget(fighter) {
    this.fighter = fighter
  }

  /** 每次畫面更新（render 前）：對齊推擠框 */
  update() {
    const fighter = this.fighter
    this.mesh.visible = !!fighter?.model
    if (!this.mesh.visible) return
    fighter.pushBox.getCenter(this.center)
    fighter.pushBox.getSize(this.size)
    this.mesh.position.set(this.center.x, fighter.groundY + this.y, this.center.z) // 自由模式站在高處時跟著地面
    this.mesh.scale.set(this.size.x / 2, 1, this.size.z / 2)
  }
}
