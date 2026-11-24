import * as THREE from 'three'
import { SkyDome } from './skyDome.js'

// 場景模型的霧（取代 three.js 的 fog_fragment）：霧色 = 看出去方向的天空貼圖顏色，和一般霧色依 uSkyMix 混合
// textureLod 0：equirect 的左右接縫在 mipmap 計算會出現細線，固定用最清楚的那層
const SKY_FOG_PARS = `
uniform sampler2D uSkyMap;
uniform float uSkyMix;
uniform mat3 uSkyMat;
uniform float uSkyIntensity;
uniform vec3 uFogCenter;
uniform float uFogRadial;
varying vec3 vSkyFogPos;
`
const SKY_FOG_FRAGMENT = `
#ifdef USE_FOG
	// uFogRadial = 1：距離改算到 uFogCenter 的直線距離（黑暗霧：以鏡頭或人物為中心的圓形範圍）；0 = 畫面深度
	float fogDist = uFogRadial > 0.5 ? distance( vSkyFogPos, uFogCenter ) : vFogDepth;
	float fogFactor = smoothstep( fogNear, fogFar, fogDist );
	vec3 skyDir = uSkyMat * normalize( vSkyFogPos - cameraPosition );
	vec3 skyFog = linearToOutputTexel( vec4( textureLod( uSkyMap, equirectUv( skyDir ), 0.0 ).rgb * uSkyIntensity, 1.0 ) ).rgb;
	gl_FragColor.rgb = mix( gl_FragColor.rgb, mix( skyFog, fogColor, uSkyMix ), fogFactor );
#endif
`

/**
 * Sky：天空背景 + 場景的霧（跟玩法無關）
 * - 天空：skies 的 'procedural' = 程式畫的動態天空（skyDome.js）；其餘是 2:1 全景圖，當作無限遠的背景（載入過會快取）
 * - 地平線霧：場景模型越遠越融進天空的地平線色（離鏡頭 near ~ far 公尺漸濃）；霧色 = 動態天空的地平線色，全景圖則取圖片地平線那一圈的平均色
 *   全景圖時，場景模型（patchMaterial 過的材質）的霧色改成「它正後方那一點的天空貼圖顏色」，遠處的模型直接融進天空
 * - 疊加的霧（setFogBlend）：例如演出時漸變成另一種霧（顏色、距離）；amount 0 = 平常、1 = 完全換成疊加的霧
 * - 亮度（setIntensity）：背景與動態天空一起變暗 / 變亮
 * - 時間 / 天氣（atmosphere.js）：syncHorizon 讓霧色跟上動態天空的地平線色；setDaylight 讓全景圖跟著晝夜變暗；setFogScale 拉近地平線霧（雨天）
 * - 黑暗霧（setDarkFog）：取代地平線霧，以中心點（setFogCenter，例如鏡頭或角色）為圓心，near 公尺外開始變暗、far 公尺外全暗
 *   天空亮度乘上 (1 - skyDarken)；只有 patchMaterial 過的材質用圓形距離，其他材質照 three.js 的畫面深度算
 * 霧一直掛在場景上、只改顏色與距離：中途才加上或拿掉 scene.fog 會讓所有材質重新編譯，畫面會頓一下
 */
export class Sky {
  constructor(options) {
    const def = {
      scene: null,
      skies: {}, // 名稱 → 'procedural' 或全景圖網址
      rotation: 0, // 天空水平轉動（度）
      cloudCover: 0.5, // 動態天空的雲量 0 ~ 1
      horizonFog: { enabled: true, near: 15, far: 70 }, // 地平線霧；關掉時推到很遠
      // 黑暗霧：enabled 時取代地平線霧；color = 霧色、near ~ far = 開始變暗 ~ 全暗（公尺，離中心點）、skyDarken = 天空變暗多少（0 ~ 1）
      darkFog: { enabled: false, color: 0x000000, near: 4, far: 14, skyDarken: 1 },
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
    this.name = null // 目前的天空
    this.cache = {} // 名稱 → texture
    this.horizonColor = new THREE.Color(0xc8d5e2) // 地平線霧的顏色（跟著天空）
    this.intensity = 1
    this.daylight = 1 // 全景圖天空的晝夜亮度（動態天空的顏色本身就有晝夜，不另外乘）
    this.fogScale = 1 // 地平線霧的距離倍率（雨天拉近）
    this.blend = { amount: 0, color: new THREE.Color(), near: 0, far: 0 } // 疊加的霧
    // 全景圖天空的霧（patchMaterial 的材質共用）：uSkyMix 0 = 用天空貼圖、1 = 用一般霧色
    this.fogUniforms = {
      uSkyMap: { value: null },
      uSkyMix: { value: 1 },
      uSkyMat: { value: new THREE.Matrix3() },
      uSkyIntensity: { value: 1 },
      uFogCenter: { value: new THREE.Vector3() }, // 黑暗霧的中心（世界座標）
      uFogRadial: { value: 0 }, // 1 = 用到中心的直線距離
    }
    this.fog = null
    this.dome = null

    // 5. init
    this.init()
  }

  init() {
    this.fog = new THREE.Fog(this.horizonColor, 1000, 1100)
    this.scene.fog = this.fog
    this.dome = new SkyDome({ scene: this.scene, cloudCover: this.cloudCover })
    this._applyFog()
  }

  // public

  /** 切換天空（skies 的名稱） */
  setSky(name) {
    const url = this.skies[name]
    if (!url) return
    this.name = name
    if (url === 'procedural') {
      this._apply(null)
      return
    }
    if (this.cache[name]) {
      this._apply(this.cache[name])
      return
    }
    new THREE.TextureLoader().load(url, texture => {
      texture.mapping = THREE.EquirectangularReflectionMapping
      texture.colorSpace = THREE.SRGBColorSpace
      this.cache[name] = texture
      if (this.name === name) this._apply(texture) // 載入期間又切到別張時不覆蓋
    })
  }

  /** 天空水平轉動（度） */
  setRotation(deg) {
    this.rotation = deg
    this.scene.backgroundRotation.y = THREE.MathUtils.degToRad(deg)
    this.dome.setRotation(deg)
    this._updateFogUniforms()
  }

  setCloudCover(value) {
    this.cloudCover = value
    this.dome.setCloudCover(value)
  }

  /** 地平線霧：{ enabled, near, far }（只給要改的欄位） */
  setHorizonFog(options) {
    Object.assign(this.horizonFog, options)
    this._applyFog()
  }

  /** 動態天空的地平線色換了（時間 / 天氣）：霧色跟上（全景圖天空的霧色照圖片，不跟） */
  syncHorizon() {
    if (!this.dome.mesh.visible) return
    this.horizonColor.copy(this.dome.getHorizonColor())
    this._applyFog()
  }

  /** 全景圖天空的晝夜亮度 0 ~ 1 */
  setDaylight(value) {
    if (this.daylight === value) return
    this.daylight = value
    this.setIntensity(this.intensity)
  }

  /** 地平線霧的距離倍率（1 = GUI 設定的距離，越小霧越近越濃） */
  setFogScale(value) {
    if (this.fogScale === value) return
    this.fogScale = value
    this._applyFog()
  }

  /** 黑暗霧：{ enabled, color, near, far, skyDarken }（只給要改的欄位） */
  setDarkFog(options) {
    Object.assign(this.darkFog, options)
    this._applyFog()
    this.setIntensity(this.intensity) // 天空跟著變暗 / 恢復
  }

  /** 黑暗霧的中心（世界座標，每個畫面更新，例如鏡頭或角色的位置） */
  setFogCenter(pos) {
    this.fogUniforms.uFogCenter.value.copy(pos)
  }

  /** 疊加的霧：amount 0 ~ 1 從平常的地平線霧漸變成 { color, near, far } */
  setFogBlend(amount, { color, near, far } = {}) {
    this.blend.amount = amount
    if (color !== undefined) this.blend.color.set(color)
    if (near !== undefined) this.blend.near = near
    if (far !== undefined) this.blend.far = far
    this._applyFog()
  }

  /** 背景與動態天空的亮度（1 = 正常）；黑暗霧打開時再乘上 (1 - skyDarken) */
  setIntensity(value) {
    this.intensity = value
    const dark = this.darkFog.enabled ? 1 - this.darkFog.skyDarken : 1
    this.scene.backgroundIntensity = value * dark * this.daylight
    this.dome.setIntensity(value * dark)
    this._updateFogUniforms()
  }

  /** 場景模型的材質：霧改成會融進天空貼圖的版本（載入場景模型時對每個材質呼叫） */
  patchMaterial(material) {
    material.customProgramCacheKey = () => 'skyFog'
    material.onBeforeCompile = shader => {
      Object.assign(shader.uniforms, this.fogUniforms)
      shader.vertexShader = `varying vec3 vSkyFogPos;\n${shader.vertexShader}`.replace(
        '#include <project_vertex>',
        '#include <project_vertex>\n\tvSkyFogPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;',
      )
      shader.fragmentShader = `${SKY_FOG_PARS}\n${shader.fragmentShader}`.replace('#include <fog_fragment>', SKY_FOG_FRAGMENT)
    }
    material.needsUpdate = true
  }

  /** 每個畫面：動態天空（雲的流動、跟著鏡頭） */
  update(delta, camera) {
    this.dome.update(delta, camera)
  }

  // internal

  /** 套用天空：texture = null 時用動態天空；霧色換成這片天空的地平線色 */
  _apply(texture) {
    this.dome.setVisible(!texture)
    this.scene.background = texture || this.dome.getHorizonColor()
    this.horizonColor.copy(texture ? this._sampleHorizonColor(texture) : this.dome.getHorizonColor())
    this.setRotation(this.rotation)
    this.setIntensity(this.intensity)
    this._applyFog()
  }

  /** 霧的顏色與距離：平常的霧（黑暗霧 / 地平線霧 / 推到很遠）和疊加的霧依 amount 線性漸變 */
  _applyFog() {
    const { enabled, near, far } = this.horizonFog
    const dark = this.darkFog
    const { amount, color } = this.blend
    let base = enabled ? { near: near * this.fogScale, far: far * this.fogScale } : { near: 1000, far: 1100 }
    if (dark.enabled) base = { near: dark.near, far: dark.far }
    const baseColor = dark.enabled ? _color.set(dark.color) : this.horizonColor
    this.fog.color.copy(baseColor).lerp(color, amount)
    this.fog.near = THREE.MathUtils.lerp(base.near, this.blend.near, amount)
    this.fog.far = THREE.MathUtils.lerp(base.far, this.blend.far, amount)
    this._updateFogUniforms()
  }

  /** 天空貼圖霧的設定：貼圖、轉動、亮度、和一般霧色的混合 */
  _updateFogUniforms() {
    const u = this.fogUniforms
    const texture = this.scene.background?.isTexture ? this.scene.background : null
    u.uSkyMap.value = texture
    // 黑暗霧：霧色一律用 fog.color（不融進天空貼圖）、距離用到中心點的直線距離
    u.uSkyMix.value = texture && !this.darkFog.enabled ? this.blend.amount : 1
    u.uFogRadial.value = this.darkFog.enabled ? 1 : 0
    u.uSkyIntensity.value = this.scene.backgroundIntensity
    // 同背景的轉動（three.js 的背景：equirect 轉成 cube 後，旋轉角度取負）
    u.uSkyMat.value.setFromMatrix4(new THREE.Matrix4().makeRotationY(-THREE.MathUtils.degToRad(this.rotation)))
  }

  /** 全景圖地平線那一圈（圖片垂直中間）的平均色 */
  _sampleHorizonColor(texture) {
    const canvas = document.createElement('canvas')
    canvas.width = 64
    canvas.height = 32
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    ctx.drawImage(texture.image, 0, 0, canvas.width, canvas.height)
    const { data } = ctx.getImageData(0, canvas.height / 2 - 1, canvas.width, 2)
    const sum = [0, 0, 0]
    for (let i = 0; i < data.length; i += 4) {
      sum[0] += data[i]
      sum[1] += data[i + 1]
      sum[2] += data[i + 2]
    }
    const count = data.length / 4
    return new THREE.Color().setRGB(sum[0] / count / 255, sum[1] / count / 255, sum[2] / count / 255, THREE.SRGBColorSpace)
  }
}

const _color = new THREE.Color()
