import * as THREE from 'three'
import { MeshBVH, acceleratedRaycast } from 'three-mesh-bvh'

const DOWN = new THREE.Vector3(0, -1, 0)
const UP = new THREE.Vector3(0, 1, 0)

/**
 * Terrain：角色在 3D 場景裡移動用的地形查詢（跟玩法無關，任何需要「走在場景上」的模式都能用）
 * - 擋牆：往移動方向在幾個高度發射線，撞到就沿牆滑開（collide / castWall）
 * - 留在場景內：走完這一步往下找不到場景 = 場景邊緣，擋住；沒有場景時限制在 |x|、|z| ≤ bounds 的方框內
 * - 地板高度：從腳底上方 stepUp 往下找第一個面（getFloor），斜坡、台階、平台都會跟著
 * - 視線：兩點之間有沒有被場景擋住（hasLineOfSight）
 * - 推出（depenetrate）：角色當成直立的膠囊體，跟場景重疊就沿著碰到的面水平推出去（任何原因卡進模型都會被推出來）
 * - 額外的碰撞物件（setColliders，例如場景裡的櫃子）：擋牆、推出、視線都算進去；模型還在載入也沒關係，載好後自動建 BVH
 * 場景模型很大，第一次 setEnv 時替網格建 BVH 加速射線（Terrain.buildBVH，已建過會跳過）
 *
 * 位置一律用世界座標；pos 是腳底的位置（y = 腳底高度）
 */
export class Terrain {
  constructor(options) {
    const def = {
      radius: 0.3, // 擋牆半徑（公尺）：牆前面留多少距離
      rayHeights: [0.4, 1.2], // 擋牆射線的高度（從腳底算，公尺）：膝蓋、胸口
      groundRay: { from: 3, length: 6 }, // 場景邊緣偵測：從腳底上方多高往下找地面、找多遠
      floorRay: { stepUp: 0.35, far: 30 }, // 地板高度：從腳底上方 stepUp 往下找、最遠找多遠（stepUp = 走路能直接踩上去的高度差）
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
    this.env = null // 場景模型（null = 用 bounds 方框）
    this.bounds = null // 沒有場景時的範圍：|x|、|z| ≤ bounds（公尺）；null = 不限制
    this.raycaster = new THREE.Raycaster()
    this.raycaster.firstHitOnly = true
    this.origin = new THREE.Vector3()
    this.normal = new THREE.Vector3()
    this.meshes = [] // 場景裡有 BVH 的網格（推出用）
    this.colliders = [] // 額外的碰撞物件（Object3D）
    this.colliderMeshes = [] // 碰撞物件裡已建好 BVH 的網格
    this.targets = [] // 射線要打的物件：場景 + 碰撞物件
  }

  // public

  /** 場景網格建 BVH 加速射線（已建過的跳過）；其他地方要對場景發射線時也可以先呼叫 */
  static buildBVH(env) {
    env.updateMatrixWorld(true)
    env.traverse(obj => {
      if (!obj.isMesh || obj.isSkinnedMesh || obj.userData.isShadowCatcher || obj.geometry.boundsTree) return
      obj.geometry.boundsTree = new MeshBVH(obj.geometry)
      obj.raycast = acceleratedRaycast
    })
  }

  /** 換場景（null = 沒有場景，改用 bounds 方框） */
  setEnv(env) {
    this.env = env
    this.meshes = env ? this._collectMeshes(env) : []
    this._updateTargets()
  }

  /** 額外的碰撞物件（例如場景裡的櫃子）；換場景時重新給 */
  setColliders(objects = []) {
    this.colliders = objects.filter(Boolean)
    this.colliderMeshes = []
    this._updateTargets()
  }

  /**
   * 膠囊體推出：角色（腳底 pos、身高 height、半徑 radius）跟場景重疊的話，沿著碰到的面推出去，直接改 pos
   * - 膠囊從腳底上方 bottom 公尺開始：地板、小台階交給地板高度處理，不會被推
   * - 只推水平方向（上下交給跳躍 / 地板高度）；最多重複 iterations 次（角落同時碰到兩面牆）
   * @returns {{ push: THREE.Vector3, depth: number }} push = 推了多少；depth = 推完後還剩的最大重疊（公尺，> 0 = 還卡著）
   */
  depenetrate(pos, { height = 1.75, radius = this.radius, bottom = 0.5, iterations = 3 } = {}) {
    const push = new THREE.Vector3()
    this._syncColliders()
    const meshes = this.colliderMeshes.length ? this.meshes.concat(this.colliderMeshes) : this.meshes
    if (!meshes.length) return { push, depth: 0 }
    const start = new THREE.Vector3(pos.x, pos.y + bottom + radius, pos.z)
    const end = new THREE.Vector3(pos.x, Math.max(start.y, pos.y + height - radius), pos.z)
    let depth = 0
    for (let i = 0; i < iterations; i++) {
      const step = new THREE.Vector3()
      depth = 0
      _box.makeEmpty().expandByPoint(start).expandByPoint(end).expandByScalar(radius)
      meshes.forEach(mesh => {
        if (!mesh.visible) return
        _meshBox.copy(mesh.geometry.boundingBox).applyMatrix4(mesh.matrixWorld)
        if (!_meshBox.intersectsBox(_box)) return
        const result = this._pushOutOfMesh(mesh, start.clone().add(step), end.clone().add(step), radius)
        step.add(result.push)
        depth = Math.max(depth, result.depth)
      })
      step.y = 0
      start.add(step)
      end.add(step)
      push.add(step)
      if (step.lengthSq() < 1e-8) break
    }
    pos.add(push)
    return { push, depth }
  }

  /**
   * 移動一步：碰到牆去掉朝牆的分量（沿牆滑開），滑開後還是撞到就停住
   * 走到場景邊緣（前方沒有地面）：只保留 x 或 z 其中一個方向（沿著邊緣滑），都不行就停住
   * 會直接改 step 並回傳
   */
  collide(pos, step) {
    this._slideWall(pos, step)
    if (this.hasGround(pos, step)) return step
    const alongX = new THREE.Vector3(step.x, 0, 0)
    const alongZ = new THREE.Vector3(0, 0, step.z)
    if (this.hasGround(pos, alongX) && !this.castWall(pos, alongX)) return step.copy(alongX)
    if (this.hasGround(pos, alongZ) && !this.castWall(pos, alongZ)) return step.copy(alongZ)
    return step.set(0, 0, 0)
  }

  /**
   * 腳下地板的世界高度：從 pos（腳底）上方 stepUp 往下找場景，第一個碰到的面
   * 沒有場景 = 0；找不到 = null
   */
  getFloor(pos) {
    if (!this.env) return 0
    const { stepUp, far } = this.floorRay
    this.raycaster.far = far
    this.raycaster.set(this.origin.set(pos.x, pos.y + stepUp, pos.z), DOWN)
    const hit = this._cast().find(item => item.object.visible)
    return hit ? hit.point.y : null
  }

  /**
   * 頭上的天花板（世界高度）：從 from（世界座標）往上找場景，第一個碰到的面；沒有場景、找不到 = null
   * 只碰得到面朝下的面（從下面看得到的天花板）；far = 往上找多遠
   */
  getCeiling(from, far = 10) {
    if (!this.targets.length) return null
    this._syncColliders()
    this.raycaster.far = far
    this.raycaster.set(this.origin.copy(from), UP)
    const hit = this._cast().find(item => item.object.visible)
    return hit ? hit.point.y : null
  }

  /** 走完這一步（再往前擋牆半徑）的位置，往下找得到場景模型 = 還在場景內；沒有場景時看是否在 bounds 方框內 */
  hasGround(pos, step) {
    const length = step.length()
    if (length === 0) return true
    const at = pos.clone().add(step).addScaledVector(step, this.radius / length)
    if (!this.env) return this.bounds == null || (Math.abs(at.x) <= this.bounds && Math.abs(at.z) <= this.bounds)
    const { from, length: far } = this.groundRay
    this.raycaster.far = far
    this.raycaster.set(this.origin.set(at.x, pos.y + from, at.z), DOWN)
    return this._cast().some(item => item.object.visible)
  }

  /**
   * 從腳底上方各個高度（rayHeights）往 step 的方向發射線，距離 = 這一步 + 擋牆半徑；回傳最近的命中（沒有 = null）
   * 命中的 distance 含擋牆半徑：離牆的實際空間 = distance - radius
   */
  castWall(pos, step) {
    const length = step.length()
    if (!this.targets.length || length === 0) return null
    this._syncColliders()
    const dir = step.clone().divideScalar(length)
    this.raycaster.far = length + this.radius
    let nearest = null
    this.rayHeights.forEach(h => {
      this.raycaster.set(this.origin.set(pos.x, pos.y + h, pos.z), dir)
      const hit = this._cast().find(item => item.object.visible && item.face)
      if (hit && (!nearest || hit.distance < nearest.distance)) nearest = hit
    })
    return nearest
  }

  /** from → to 之間沒有被場景擋住（世界座標；沒有場景 = 一律看得到） */
  hasLineOfSight(from, to) {
    if (!this.targets.length) return true
    this._syncColliders()
    const dir = to.clone().sub(from)
    const length = dir.length()
    if (length < 1e-4) return true
    this.raycaster.far = length
    this.raycaster.set(from, dir.divideScalar(length))
    return !this._cast().some(item => item.object.visible)
  }

  // internal

  /** 用目前 raycaster 的設定打場景 + 碰撞物件 */
  _cast() {
    return this.raycaster.intersectObjects(this.targets, true)
  }

  _updateTargets() {
    this.targets = [this.env, ...this.colliders].filter(Boolean)
  }

  /** 有 BVH 的網格（推出用） */
  _collectMeshes(object) {
    Terrain.buildBVH(object)
    const meshes = []
    object.traverse(obj => {
      if (!obj.isMesh || obj.isSkinnedMesh || obj.userData.isShadowCatcher || !obj.geometry.boundsTree) return
      if (!obj.geometry.boundingBox) obj.geometry.computeBoundingBox()
      meshes.push(obj)
    })
    return meshes
  }

  /** 碰撞物件的模型載好了（網格數量變了）：建 BVH、加進推出用的網格 */
  _syncColliders() {
    let count = 0
    this.colliders.forEach(obj => obj.traverse(o => { if (o.isMesh && !o.isSkinnedMesh) count++ }))
    if (count === this.colliderMeshes.length) return
    this.colliderMeshes = this.colliders.flatMap(obj => this._collectMeshes(obj))
  }

  /**
   * 一個網格的推出：膠囊（世界座標的線段 start ~ end、半徑 radius）換到網格的座標裡，對每個重疊的三角形沿「三角形最近點 → 膠囊最近點」推開
   * @returns {{ push: THREE.Vector3, depth: number }} 世界座標的推移量、最大重疊深度
   */
  _pushOutOfMesh(mesh, start, end, radius) {
    const inverse = _matrix.copy(mesh.matrixWorld).invert()
    const scale = mesh.matrixWorld.getMaxScaleOnAxis() || 1
    const r = radius / scale
    _segment.start.copy(start).applyMatrix4(inverse)
    _segment.end.copy(end).applyMatrix4(inverse)
    const before = _segment.start.clone()
    _localBox.makeEmpty().expandByPoint(_segment.start).expandByPoint(_segment.end).expandByScalar(r)
    let depth = 0
    mesh.geometry.boundsTree.shapecast({
      intersectsBounds: box => box.intersectsBox(_localBox),
      intersectsTriangle: tri => {
        const distance = tri.closestPointToSegment(_segment, _triPoint, _capsulePoint)
        if (distance >= r) return
        const dir = _capsulePoint.sub(_triPoint)
        // 線段穿過三角形（距離 0）：沿三角形法線推
        if (dir.lengthSq() < 1e-12) tri.getNormal(dir)
        dir.normalize()
        const overlap = r - distance
        _segment.start.addScaledVector(dir, overlap)
        _segment.end.addScaledVector(dir, overlap)
        depth = Math.max(depth, overlap * scale)
      },
    })
    const push = _segment.start.clone().applyMatrix4(mesh.matrixWorld).sub(before.applyMatrix4(mesh.matrixWorld))
    return { push, depth }
  }

  /** 撞牆：去掉朝牆的分量；滑開後還是撞到就停住 */
  _slideWall(pos, step) {
    const hit = this.castWall(pos, step)
    if (!hit) return step
    this.normal.copy(hit.face.normal).transformDirection(hit.object.matrixWorld).setY(0)
    if (this.normal.lengthSq() < 1e-6) return step.set(0, 0, 0)
    this.normal.normalize()
    const into = step.dot(this.normal)
    if (into < 0) step.addScaledVector(this.normal, -into)
    return this.castWall(pos, step) ? step.set(0, 0, 0) : step
  }
}

const _box = new THREE.Box3()
const _meshBox = new THREE.Box3()
const _localBox = new THREE.Box3()
const _matrix = new THREE.Matrix4()
const _segment = new THREE.Line3()
const _triPoint = new THREE.Vector3()
const _capsulePoint = new THREE.Vector3()
