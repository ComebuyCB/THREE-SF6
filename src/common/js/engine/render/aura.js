import * as THREE from 'three'

/**
 * Aura：包在角色外圍的氣場特效（不改模型本身的顏色）
 * - 外殼光暈：共用同一副骨架的複製網格，頂點沿法線往外推 thickness 公尺；只有輪廓邊緣發光（fresnel），光紋往上流動
 * - 火花：從身上的骨頭附近往外、往上噴（世界座標，人物移動時會留下軌跡）
 * - 啟動爆發（burst）：腳下一圈衝擊波光環 + 一陣火花 + 點光源閃一下
 *
 * 使用：
 *   aura.burst()       啟動的瞬間
 *   aura.setLevel(k)   持續的強度 0 ~ 1（0 = 外殼、火花停止，已經噴出去的火花照樣飛完）
 *   aura.update(delta) 每個畫面（在角色擺好姿勢之後、渲染之前）
 */
export class Aura {
  constructor(options) {
    const def = {
      scene: null, // 火花、光環、點光源放的地方（世界座標）
      model: null, // 角色模型（含 SkinnedMesh 與骨頭）
      height: 1.75, // 角色身高（公尺）：換算外殼厚度
      color: 0xff9a2e,
      // 外殼：厚度（公尺）、亮度、邊緣銳利度（越大光越集中在輪廓）、光紋密度（每公尺幾條）、往上流的速度
      shell: { thickness: 0.035, intensity: 2.2, power: 2.2, bands: 9, speed: 2.5 },
      // 火花：最多幾顆、持續時每秒噴幾顆、啟動時一次噴幾顆、大小（公尺）、壽命（秒）、往外 / 往上的速度（公尺 / 秒）、重力
      sparks: { max: 300, rate: 160, burst: 120, size: 0.085, life: [0.25, 0.6], out: [0.6, 1.8], up: [0.4, 2.2], gravity: -3 },
      // 衝擊波光環：從多大擴散到多大（公尺）、秒數
      wave: { from: 0.3, to: 2.2, time: 0.4 },
      // 點光源：亮度、範圍、閃一下的秒數
      flare: { intensity: 6, distance: 4, flash: 0.35 },
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
    this.level = 0
    this.time = 0
    this.emitCarry = 0 // 還沒噴出的火花（小數）
    this.ringTime = Infinity
    this.flashTime = Infinity
    this.bones = [] // 火花從這些骨頭附近噴出
    this.shellMeshes = []
    this._v1 = new THREE.Vector3()
    this._v2 = new THREE.Vector3()

    // 5. init
    this.init()
  }

  init() {
    this._setupShell()
    this._setupSparks()
    this._setupRing()
    this._setupLight()
  }

  // public

  /** 啟動的瞬間：光環擴散、一陣火花、點光源閃一下；sparkLife = 這陣火花的壽命倍率 */
  burst({ sparkLife = 1 } = {}) {
    this.ringTime = 0
    this.flashTime = 0
    this._emit(this.sparks.burst, 1.6, sparkLife)
  }

  /** 持續強度 0 ~ 1 */
  setLevel(level) {
    this.level = THREE.MathUtils.clamp(level, 0, 1)
  }

  /** 外殼離身體多遠（公尺）：不給 = 預設的 shell.thickness（例如絕招用比較大的外殼） */
  setThickness(thickness) {
    this.defaultThickness ??= this.shell.thickness
    this.shell.thickness = thickness ?? this.defaultThickness
  }

  /** 換顏色（例如不同角色的氣場顏色） */
  setColor(color) {
    this.color = color
    this.shellMaterial.userData.uniforms.uColor.value.set(color)
    this.ringMaterial.color.set(color)
    this.light.color.set(color)
  }

  update(delta) {
    this.time += delta
    this._updateShell()
    this._updateSparks(delta)
    this._updateRing(delta)
    this._updateLight(delta)
  }

  dispose() {
    this.shellMeshes.forEach(mesh => mesh.parent?.remove(mesh))
    this.shellMaterial.dispose()
    this.scene.remove(this.points, this.ring, this.light)
    this.points.geometry.dispose()
    this.points.material.map.dispose()
    this.points.material.dispose()
    this.ring.geometry.dispose()
    this.ringMaterial.map.dispose()
    this.ringMaterial.dispose()
  }

  // internal

  /** 外殼：每個 SkinnedMesh 複製一份（共用形狀與骨架），掛在原本網格底下 */
  _setupShell() {
    const uniforms = {
      uColor: { value: new THREE.Color(this.color) },
      uLevel: { value: 0 },
      uTime: { value: 0 },
      uThickness: { value: 0 },
      uPower: { value: this.shell.power },
      uBands: { value: this.shell.bands },
      uSpeed: { value: this.shell.speed },
    }
    const material = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, toneMapped: false })
    material.userData.uniforms = uniforms
    material.onBeforeCompile = shader => {
      Object.assign(shader.uniforms, uniforms)
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
uniform float uThickness;
varying vec3 vAuraNormal;
varying vec3 vAuraView;
varying float vAuraY;`)
        // 綁定姿勢下沿法線往外推（之後骨架變形會帶著走）
        .replace('#include <begin_vertex>', `#include <begin_vertex>
transformed += normalize(normal) * uThickness;`)
        .replace('#include <project_vertex>', `#include <project_vertex>
vAuraNormal = normalize(normalMatrix * objectNormal);
vAuraView = -mvPosition.xyz;
vAuraY = (modelMatrix * vec4(transformed, 1.0)).y;`)
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
uniform vec3 uColor;
uniform float uLevel;
uniform float uTime;
uniform float uPower;
uniform float uBands;
uniform float uSpeed;
varying vec3 vAuraNormal;
varying vec3 vAuraView;
varying float vAuraY;`)
        .replace('#include <dithering_fragment>', `#include <dithering_fragment>
float rim = pow(1.0 - abs(dot(normalize(vAuraNormal), normalize(vAuraView))), uPower);
float flow = 0.55 + 0.45 * sin(vAuraY * uBands * 6.2832 - uTime * uSpeed * 6.2832);
gl_FragColor = vec4(uColor * rim * flow * uLevel, 1.0);`)
    }
    this.shellMaterial = material

    // 厚度：公尺換算成網格自己的單位（模型多半有縮放；用最高的那個網格對應角色身高）
    const meshes = []
    this.model.traverse(obj => {
      if (obj.isSkinnedMesh && !obj.userData.isXray && !obj.userData.isEffect) meshes.push(obj)
      if (obj.isBone && /Hips|Spine|Neck|Head$|Arm|UpLeg|Leg$/.test(obj.name)) this.bones.push(obj)
    })
    const tallest = Math.max(0, ...meshes.map(mesh => {
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox()
      const box = mesh.geometry.boundingBox
      return box.max.y - box.min.y
    }))
    this.unitsPerMeter = tallest > 0 ? tallest / this.height : 1
    // traverse 結束後才加，避免走訪到新加的
    meshes.forEach(mesh => {
      const shell = new THREE.SkinnedMesh(mesh.geometry, material)
      shell.bind(mesh.skeleton, mesh.bindMatrix)
      shell.userData.isEffect = true
      shell.renderOrder = 3 // 畫在人物之後（人物的深度擋住內側）
      shell.frustumCulled = false
      shell.visible = false
      mesh.add(shell)
      this.shellMeshes.push(shell)
    })
  }

  _setupSparks() {
    const { max, size } = this.sparks
    const geometry = new THREE.BufferGeometry()
    this.positions = new Float32Array(max * 3)
    this.colors = new Float32Array(max * 3)
    geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3))
    geometry.setAttribute('color', new THREE.BufferAttribute(this.colors, 3))
    geometry.setDrawRange(0, 0)
    this.particles = [] // { pos, vel, life, age }
    const material = new THREE.PointsMaterial({ size, map: makeSparkTexture(), vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, toneMapped: false })
    this.points = new THREE.Points(geometry, material)
    this.points.frustumCulled = false
    this.points.renderOrder = 3
    this.scene.add(this.points)
  }

  _setupRing() {
    // 柔邊光圈貼圖（外緣最亮、往內漸淡）貼在一片平面上
    this.ringMaterial = new THREE.MeshBasicMaterial({ color: this.color, map: makeRingTexture(), transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false, toneMapped: false })
    this.ring = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.ringMaterial)
    this.ring.rotation.x = -Math.PI / 2
    this.ring.visible = false
    this.ring.renderOrder = 3
    this.scene.add(this.ring)
  }

  /** 點光源一直在場景裡（亮度 0）：之後才加燈會讓所有材質重新編譯，畫面卡一下 */
  _setupLight() {
    this.light = new THREE.PointLight(this.color, 0, this.flare.distance)
    this.scene.add(this.light)
  }

  _updateShell() {
    const u = this.shellMaterial.userData.uniforms
    const pulse = 1 + 0.15 * Math.sin(this.time * 18) // 外殼輕微脈動
    u.uLevel.value = this.level * this.shell.intensity
    u.uTime.value = this.time
    u.uThickness.value = this.shell.thickness * pulse * this.unitsPerMeter
    const isVisible = this.level > 0.001
    this.shellMeshes.forEach(mesh => { mesh.visible = isVisible })
  }

  _updateSparks(delta) {
    if (delta > 0 && this.level > 0) {
      this.emitCarry += this.sparks.rate * this.level * delta
      const count = Math.floor(this.emitCarry)
      this.emitCarry -= count
      if (count) this._emit(count, 1)
    }
    const { gravity } = this.sparks
    const base = new THREE.Color(this.color)
    const hot = new THREE.Color(0xfff2c0) // 剛噴出時偏白熱
    const c = new THREE.Color()
    let n = 0
    this.particles = this.particles.filter(p => {
      p.age += delta
      if (p.age >= p.life) return false
      p.vel.y += gravity * delta
      p.pos.addScaledVector(p.vel, delta)
      const t = p.age / p.life
      c.copy(hot).lerp(base, Math.min(1, t * 2)).multiplyScalar((1 - t) * (1 - t)) // 加法混色：顏色變黑 = 淡出
      this.positions.set([p.pos.x, p.pos.y, p.pos.z], n * 3)
      this.colors.set([c.r, c.g, c.b], n * 3)
      n++
      return true
    })
    const geometry = this.points.geometry
    geometry.setDrawRange(0, n)
    geometry.attributes.position.needsUpdate = true
    geometry.attributes.color.needsUpdate = true
  }

  /** 噴 count 顆火花：從隨機一根骨頭往外（水平離開身體中心）、往上；speed = 速度倍率、lifeRate = 壽命倍率 */
  _emit(count, speed, lifeRate = 1) {
    if (!this.bones.length) return
    const { max, life, out, up } = this.sparks
    const center = this.bones[0].getWorldPosition(this._v1)
    for (let i = 0; i < count && this.particles.length < max; i++) {
      const bone = this.bones[Math.floor(Math.random() * this.bones.length)]
      const pos = bone.getWorldPosition(new THREE.Vector3())
      const dir = this._v2.set(pos.x - center.x, 0, pos.z - center.z)
      if (dir.lengthSq() < 1e-4) dir.set(Math.random() - 0.5, 0, Math.random() - 0.5)
      dir.normalize().applyAxisAngle(_up, THREE.MathUtils.randFloatSpread(2.4)) // 往外，帶一點隨機角度
      pos.addScaledVector(dir, THREE.MathUtils.randFloat(0.12, 0.25)) // 從身體表面外一點開始（不在模型上）
      pos.y += THREE.MathUtils.randFloatSpread(0.15)
      const vel = dir.clone().multiplyScalar(THREE.MathUtils.randFloat(...out) * speed)
      vel.y = THREE.MathUtils.randFloat(...up) * speed
      this.particles.push({ pos, vel, age: 0, life: THREE.MathUtils.randFloat(...life) * lifeRate })
    }
  }

  _updateRing(delta) {
    const { from, to, time } = this.wave
    this.ringTime += delta
    const t = this.ringTime / time
    this.ring.visible = t < 1
    if (!this.ring.visible) return
    const k = 1 - (1 - t) ** 3 // 先快後慢
    const center = this.bones[0]?.getWorldPosition(this._v1) ?? this.model.position
    this.ring.position.set(center.x, this.model.position.y + 0.03, center.z)
    this.ring.scale.setScalar(THREE.MathUtils.lerp(from, to, k))
    this.ringMaterial.opacity = Math.min(1, (1 - t) * 1.6) // 前半段全亮，後半段淡出
  }

  _updateLight(delta) {
    const { intensity, flash } = this.flare
    this.flashTime += delta
    const f = this.flashTime < flash ? 1 - this.flashTime / flash : 0
    this.light.intensity = intensity * Math.max(f * 1.5, this.level * 0.5)
    if (this.light.intensity > 0 && this.bones[0]) this.bones[0].getWorldPosition(this.light.position).y += 0.2
  }
}

const _up = new THREE.Vector3(0, 1, 0)

/** 衝擊波光圈的貼圖：外緣一圈最亮（白熱），往內拖一段淡淡的光，往外很快消失 */
function makeRingTexture() {
  const size = 256
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  const r = size / 2
  const g = ctx.createRadialGradient(r, r, 0, r, r, r)
  g.addColorStop(0, 'rgba(255,255,255,0)')
  g.addColorStop(0.45, 'rgba(255,255,255,0)')
  g.addColorStop(0.75, 'rgba(255,255,255,0.25)')
  g.addColorStop(0.9, 'rgba(255,255,255,1)')
  g.addColorStop(0.95, 'rgba(255,255,255,0.6)')
  g.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, size, size)
  return new THREE.CanvasTexture(canvas)
}

/** 火花的貼圖：中間亮、往外漸淡的圓點 */
function makeSparkTexture() {
  const size = 64
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  g.addColorStop(0, 'rgba(255,255,255,1)')
  g.addColorStop(0.25, 'rgba(255,255,255,0.8)')
  g.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, size, size)
  return new THREE.CanvasTexture(canvas)
}
