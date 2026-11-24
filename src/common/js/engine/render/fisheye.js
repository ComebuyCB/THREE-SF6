import * as THREE from 'three'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'

/**
 * 桶狀扭曲（魚眼）：畫面中間微微鼓起、邊緣往內彎
 * 輸出的像素在半徑 r（以畫面高度為 1）取來源畫面的 r × (1 + strength × r²)，再整體縮放讓四個角剛好對到來源的角（不會取到畫面外）
 */
const BarrelShader = {
  uniforms: {
    tDiffuse: { value: null },
    strength: { value: 0 },
    aspect: { value: 1 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float strength;
    uniform float aspect;
    varying vec2 vUv;
    void main() {
      vec2 p = vUv * 2.0 - 1.0;
      p.x *= aspect;
      float r2 = dot(p, p);
      float corner = aspect * aspect + 1.0;
      vec2 q = p * (1.0 + strength * r2) / (1.0 + strength * corner);
      q.x /= aspect;
      gl_FragColor = texture2D(tDiffuse, q * 0.5 + 0.5);
    }
  `,
}

/**
 * Fisheye：第一人稱用的輕微魚眼
 * - 打開時（update 的 isOn）鏡頭視角從原本的 fov 平滑加大到 fov、扭曲強度加到 strength；關閉時平滑回來
 * - 完全關閉時直接用 renderer.render（不多花後製的成本）
 */
export class Fisheye {
  constructor(options) {
    const def = {
      renderer: null,
      scene: null,
      camera: null,
      fov: 100, // 打開時的鏡頭垂直視角（度）
      strength: 0.1, // 扭曲強度：0 = 沒有扭曲，越大邊緣彎越多（輕微約 0.1 ~ 0.2）
      blendTime: 0.3, // 打開 / 關閉的過渡秒數
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
    this.baseFov = this.camera.fov // 平常的視角（關閉時回到這個值）
    this.blend = 0 // 0 = 關閉、1 = 完全打開
    this.composer = null

    // 5. init
    this.init()
  }

  init() {
    this.composer = new EffectComposer(this.renderer)
    this.composer.addPass(new RenderPass(this.scene, this.camera))
    this.barrelPass = new ShaderPass(BarrelShader)
    this.composer.addPass(this.barrelPass)
    this.composer.addPass(new OutputPass()) // 色彩空間轉換（直接畫到螢幕時 renderer 會做，後製時要另外做）
    this.setSize(this.renderer.domElement.clientWidth || window.innerWidth, this.renderer.domElement.clientHeight || window.innerHeight)
  }

  // public

  /**
   * 每個畫面：視角、扭曲強度往目標平滑靠近
   * @param {number} delta 真實時間（秒）
   * @param {boolean} isOn 這個畫面要不要魚眼（第一人稱中）
   */
  update(delta, isOn) {
    const target = isOn ? 1 : 0
    if (this.blend === target) return
    const step = this.blendTime > 0 ? delta / this.blendTime : 1
    this.blend = target > this.blend ? Math.min(target, this.blend + step) : Math.max(target, this.blend - step)
    this._applyFov()
  }

  /** GUI 改了 fov 時：打開中的話馬上套用 */
  refresh() {
    this._applyFov()
  }

  /** 畫出這個畫面：有魚眼時走後製，沒有時直接畫 */
  render() {
    if (this.blend <= 0) {
      this.renderer.render(this.scene, this.camera)
      return
    }
    this.barrelPass.uniforms.strength.value = this.strength * this.smoothBlend
    this.barrelPass.uniforms.aspect.value = this.camera.aspect
    this.composer.render()
  }

  setSize(width, height) {
    this.composer.setPixelRatio(this.renderer.getPixelRatio())
    this.composer.setSize(width, height)
  }

  // internal

  /** 過渡曲線：先慢後快再慢 */
  get smoothBlend() {
    const t = this.blend
    return t * t * (3 - 2 * t)
  }

  _applyFov() {
    this.camera.fov = THREE.MathUtils.lerp(this.baseFov, this.fov, this.smoothBlend)
    this.camera.updateProjectionMatrix()
  }
}
