import * as THREE from 'three'
import { Terrain } from './terrain.js'

const UP = new THREE.Vector3(0, 1, 0)
const DOWN = new THREE.Vector3(0, -1, 0)

/**
 * Rain：下雨（跟玩法無關）
 * - 雨絲：鏡頭周圍 radius 公尺、height 公尺高的範圍內畫 count 條線段，一直往下落；範圍跟著鏡頭
 * - 落點與遮蔽：把地面切成 cellSize 公尺的格子，每格從天空往下發射線找雨落在哪（地面或屋頂），
 *   再從落點往上發射線：上面還有東西（室內天花板、屋簷下）= 這格不下雨
 *   結果依世界座標快取，鏡頭附近還沒算過的格子每個畫面算 cellBudget 格（還沒算到的格子先不畫雨）
 * - 水花：雨絲落到落點時，有 splashRate 的機率濺起幾顆小水珠（往上彈、受重力落下）
 * amount 0 ~ 1：畫出幾成的雨絲（0 = 不畫）
 */
export class Rain {
  constructor(options) {
    const def = {
      scene: null,
      getEnv: null, // () → 場景模型（雨的落點與遮蔽；沒有 = 落在 y = 0 的地面）
      count: 3000, // 最多幾條雨絲
      radius: 14, // 鏡頭周圍多大範圍（公尺，水平）
      height: 14, // 範圍高度（公尺）
      speed: 14, // 落下速度（公尺 / 秒）
      length: 0.45, // 雨絲長度（公尺）
      wind: new THREE.Vector3(0.12, 0, 0.05), // 斜著落的方向（每往下 1 公尺，水平偏多少）
      color: 0xaabbcc,
      opacity: 0.35,
      cellSize: 0.75, // 落點 / 遮蔽的格子大小（公尺）
      cellBudget: 250, // 每個畫面最多算幾格
      splash: { rate: 0.5, drops: 3, max: 1500, speed: 1.1, life: 0.3, size: 0.035, color: 0xd6e0ea, opacity: 0.75 },
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
    this.amount = 0
    this.drops = null // 每條雨絲相對鏡頭的位置（x, y, z）
    this.mesh = null
    this.env = undefined // 目前快取對應的場景模型（換場景時清掉快取）
    this.cells = new Map() // 格子 key → { land（落點高度，-Infinity = 沒有地面）, covered（上面有東西）}
    this.raycaster = new THREE.Raycaster()
    this.raycaster.firstHitOnly = true
    this.origin = new THREE.Vector3()
    // 水花：world 座標的小水珠（位置、速度、剩餘時間）
    this.splashPos = null
    this.splashVel = null
    this.splashLife = null
    this.splashNext = 0 // 下一顆要用的水珠（環狀重複使用）
    this.splashMesh = null

    // 5. init
    this.init()
  }

  init() {
    this.drops = new Float32Array(this.count * 3)
    for (let i = 0; i < this.count; i++) this._respawn(i, true)
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.count * 6), 3))
    const material = new THREE.LineBasicMaterial({ color: this.color, transparent: true, opacity: this.opacity, depthWrite: false, fog: false })
    this.mesh = new THREE.LineSegments(geometry, material)
    this.mesh.frustumCulled = false
    this.mesh.visible = false
    this.scene.add(this.mesh)

    const { max, size, color, opacity } = this.splash
    this.splashPos = new Float32Array(max * 3).fill(-9999)
    this.splashVel = new Float32Array(max * 3)
    this.splashLife = new Float32Array(max)
    const splashGeometry = new THREE.BufferGeometry()
    splashGeometry.setAttribute('position', new THREE.BufferAttribute(this.splashPos, 3))
    this.splashMesh = new THREE.Points(splashGeometry, new THREE.PointsMaterial({ color, size, transparent: true, opacity, depthWrite: false }))
    this.splashMesh.frustumCulled = false
    this.splashMesh.visible = false
    this.scene.add(this.splashMesh)
  }

  // public

  /** 雨量 0 ~ 1 */
  setAmount(value) {
    this.amount = THREE.MathUtils.clamp(value, 0, 1)
    this.mesh.visible = this.amount > 0.001
    if (this.mesh.visible) this.splashMesh.visible = true
  }

  /** 每個畫面：雨絲往下落、落到落點濺水花，範圍跟著鏡頭（delta = 遊戲時間） */
  update(delta, camera) {
    this._updateSplashes(delta)
    if (!this.mesh.visible) return
    this._syncEnv()
    this._fillCells(camera.position)

    const active = Math.floor(this.count * this.amount)
    const drops = this.drops
    const fall = this.speed * delta
    const { x: wx, z: wz } = this.wind
    const cam = camera.position
    const pos = this.mesh.geometry.attributes.position.array
    for (let i = 0; i < active; i++) {
      const o = i * 3
      drops[o] += wx * fall
      drops[o + 1] -= fall
      drops[o + 2] += wz * fall
      if (drops[o + 1] < -this.height / 2) this._respawn(i, false)

      // 落點：落到地面 / 屋頂就濺水花、從頂端重新開始；上面有遮蔽（室內）或還沒算到的格子不畫
      const x = cam.x + drops[o]
      const y = cam.y + drops[o + 1]
      const z = cam.z + drops[o + 2]
      const cell = this.cells.get(this._cellKey(x, z))
      let isHidden = !cell || cell.covered
      if (cell && !cell.covered && y <= cell.land) {
        // 這一幀才穿過落點：濺水花、從頂端重新開始；本來就在落點下面（例如屋頂下）：不畫，繼續落到範圍底部再重來
        if (y + fall > cell.land) {
          if (Math.random() < this.splash.rate) this._spawnSplash(x, cell.land, z)
          this._respawn(i, false)
        }
        isHidden = true
      }
      const v = i * 6
      if (isHidden) {
        // 兩端點放在同一點 = 不畫
        pos[v] = pos[v + 3] = drops[o]
        pos[v + 1] = pos[v + 4] = -9999
        pos[v + 2] = pos[v + 5] = drops[o + 2]
        continue
      }
      pos[v] = drops[o]
      pos[v + 1] = drops[o + 1]
      pos[v + 2] = drops[o + 2]
      pos[v + 3] = drops[o] - wx * this.length
      pos[v + 4] = drops[o + 1] + this.length
      pos[v + 5] = drops[o + 2] - wz * this.length
    }
    this.mesh.geometry.attributes.position.needsUpdate = true
    this.mesh.geometry.setDrawRange(0, active * 2)
    this.mesh.position.copy(cam)
  }

  // internal

  /** 雨絲重新放到範圍內：isAnyHeight = 一開始隨便放；否則放回頂端 */
  _respawn(i, isAnyHeight) {
    const o = i * 3
    const angle = Math.random() * Math.PI * 2
    const r = Math.sqrt(Math.random()) * this.radius
    this.drops[o] = Math.cos(angle) * r
    this.drops[o + 1] = isAnyHeight ? (Math.random() - 0.5) * this.height : this.height / 2
    this.drops[o + 2] = Math.sin(angle) * r
  }

  _cellKey(x, z) {
    const ix = Math.floor(x / this.cellSize) + 32768
    const iz = Math.floor(z / this.cellSize) + 32768
    return ix * 65536 + iz
  }

  /** 換場景：快取清掉、替新的場景建 BVH */
  _syncEnv() {
    const env = this.getEnv?.() ?? null
    if (env === this.env) return
    this.env = env
    this.cells.clear()
    if (env) Terrain.buildBVH(env)
  }

  /** 鏡頭附近（radius 內）還沒算過的格子，這個畫面算 cellBudget 格 */
  _fillCells(cam) {
    const size = this.cellSize
    const n = Math.ceil(this.radius / size) + 1
    const cx = Math.floor(cam.x / size)
    const cz = Math.floor(cam.z / size)
    let budget = this.cellBudget
    for (let dx = -n; dx <= n && budget > 0; dx++) {
      for (let dz = -n; dz <= n && budget > 0; dz++) {
        const x = (cx + dx + 0.5) * size
        const z = (cz + dz + 0.5) * size
        const key = this._cellKey(x, z)
        if (this.cells.has(key)) continue
        this.cells.set(key, this._probeCell(x, z, cam.y))
        budget--
      }
    }
  }

  /**
   * 一格的落點與遮蔽：從天空往下找第一個面（雨落在這裡），再從落點往上找（有東西 = 上面有遮蔽，例如室內天花板）
   * 只看得到正面的網格也沒關係：天花板通常只有朝下的面，往下的射線穿過它、往上的射線打得到
   */
  _probeCell(x, z, camY) {
    const env = this.env
    if (!env) return { land: 0, covered: false }
    const top = camY + 80
    const ray = this.raycaster
    ray.far = 200
    ray.set(this.origin.set(x, top, z), DOWN)
    const hit = ray.intersectObject(env, true).find(item => item.object.visible)
    if (!hit) return { land: -Infinity, covered: false }
    const land = hit.point.y
    ray.far = 80
    ray.set(this.origin.set(x, land + 0.2, z), UP)
    const above = ray.intersectObject(env, true).find(item => item.object.visible)
    return { land, covered: !!above }
  }

  /** 濺起幾顆小水珠：往上、往外隨機彈開 */
  _spawnSplash(x, y, z) {
    const { drops, max, speed, life } = this.splash
    for (let k = 0; k < drops; k++) {
      const i = this.splashNext
      this.splashNext = (this.splashNext + 1) % max
      const o = i * 3
      const angle = Math.random() * Math.PI * 2
      const out = speed * (0.3 + Math.random() * 0.5)
      this.splashPos[o] = x
      this.splashPos[o + 1] = y + 0.02
      this.splashPos[o + 2] = z
      this.splashVel[o] = Math.cos(angle) * out
      this.splashVel[o + 1] = speed * (0.6 + Math.random() * 0.6)
      this.splashVel[o + 2] = Math.sin(angle) * out
      this.splashLife[i] = life * (0.6 + Math.random() * 0.6)
    }
  }

  /** 水珠：受重力落下，時間到就移走 */
  _updateSplashes(delta) {
    if (!this.splashMesh.visible) return
    const { max } = this.splash
    let alive = 0
    for (let i = 0; i < max; i++) {
      if (this.splashLife[i] <= 0) continue
      const o = i * 3
      this.splashLife[i] -= delta
      if (this.splashLife[i] <= 0) {
        this.splashPos[o + 1] = -9999
        continue
      }
      alive++
      this.splashVel[o + 1] -= 9.8 * delta
      this.splashPos[o] += this.splashVel[o] * delta
      this.splashPos[o + 1] += this.splashVel[o + 1] * delta
      this.splashPos[o + 2] += this.splashVel[o + 2] * delta
    }
    this.splashMesh.geometry.attributes.position.needsUpdate = true
    if (!alive && !this.mesh.visible) this.splashMesh.visible = false
  }
}
