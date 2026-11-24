import * as THREE from 'three'

/**
 * SkyDome：程式畫的動態天空（包住鏡頭的大球，內側上色）
 * - 天頂 → 地平線漸層，地平線以下全部是地平線色（和場景的地平線霧同色，場景模型的邊緣會融進天空）
 * - 雲：雜訊（fbm）投影在天空平面上，隨時間飄動；越接近地平線越淡，地平線一帶只剩霧色
 * - 太陽（圓盤 + 光暈）、月亮、星星：方向用世界座標（跟燈光一致，不跟天空的水平轉動），被雲擋住會變淡
 *   顏色、太陽月亮的位置、星星多亮由外部設定（例如 atmosphere.js 依時間、天氣算）
 * 不受場景霧影響、不寫深度，永遠畫在最後面；球心跟著鏡頭，看起來在無限遠
 */
export class SkyDome {
  constructor(options) {
    const def = {
      scene: null,
      radius: 90, // 要小於鏡頭的 far
      zenith: '#3f6fb5', // 天頂色
      horizon: '#c8d5e2', // 地平線色（同地平線霧）
      cloudColor: '#ffffff',
      cloudCover: 0.5, // 雲量 0 ~ 1
      cloudSpeed: 0.02, // 雲飄動速度
      cloudScale: 0.6, // 雲的大小：越小雲越大
      horizonFade: 0.18, // 地平線往上多高（方向的 y 分量）雲才完全出現
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
    this.mesh = null
    this.uniforms = null

    // 5. init
    this.init()
  }

  init() {
    this.uniforms = {
      uZenith: { value: new THREE.Color(this.zenith) },
      uHorizon: { value: new THREE.Color(this.horizon) },
      uCloud: { value: new THREE.Color(this.cloudColor) },
      uCover: { value: this.cloudCover },
      uScale: { value: this.cloudScale },
      uFade: { value: this.horizonFade },
      uTime: { value: 0 },
      uIntensity: { value: 1 },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: new THREE.Color(1, 0.95, 0.85) },
      uSunVisible: { value: 0 }, // 0 ~ 1：太陽圓盤與光暈多明顯
      uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
      uMoonVisible: { value: 0 },
      uStars: { value: 0 }, // 0 ~ 1：星星亮度
      uFlash: { value: 0 }, // 閃電：整片天空變亮的程度
    }
    const material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    })
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(this.radius, 64, 32), material)
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = -1
    this.scene.add(this.mesh)
  }

  // public

  setVisible(isVisible) {
    this.mesh.visible = isVisible
  }

  /** 地平線色（霧要用同一個顏色） */
  getHorizonColor() {
    return this.uniforms.uHorizon.value
  }

  setCloudCover(value) {
    this.uniforms.uCover.value = value
  }

  /** 亮度倍率（絕招演出變暗用） */
  setIntensity(value) {
    this.uniforms.uIntensity.value = value
  }

  /** 天頂色、地平線色（地平線色同時是背景色，見 Sky） */
  setColors(zenith, horizon) {
    this.uniforms.uZenith.value.copy(zenith)
    this.uniforms.uHorizon.value.copy(horizon)
  }

  setCloudColor(color) {
    this.uniforms.uCloud.value.copy(color)
  }

  /** 太陽：dir = 世界方向（單位向量）、color、visible 0 ~ 1 */
  setSun(dir, color, visible) {
    this.uniforms.uSunDir.value.copy(dir)
    this.uniforms.uSunColor.value.copy(color)
    this.uniforms.uSunVisible.value = visible
  }

  /** 月亮：dir = 世界方向、visible 0 ~ 1 */
  setMoon(dir, visible) {
    this.uniforms.uMoonDir.value.copy(dir)
    this.uniforms.uMoonVisible.value = visible
  }

  /** 閃電：整片天空變亮 0 ~ 1 */
  setFlash(value) {
    this.uniforms.uFlash.value = value
  }

  /** 星星亮度 0 ~ 1 */
  setStars(value) {
    this.uniforms.uStars.value = value
  }

  /** 水平轉動（度） */
  setRotation(deg) {
    this.mesh.rotation.y = THREE.MathUtils.degToRad(deg)
  }

  /** 每個畫面：雲飄動、球心跟著鏡頭 */
  update(delta, camera) {
    this.uniforms.uTime.value += delta * this.cloudSpeed
    this.mesh.position.copy(camera.position)
  }
}

const VERTEX = /* glsl */ `
  varying vec3 vDir;
  varying vec3 vWorldDir;
  void main() {
    vDir = normalize(position);
    vWorldDir = normalize((modelMatrix * vec4(position, 0.0)).xyz); // 只有旋轉（w = 0 不含位移）
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

const FRAGMENT = /* glsl */ `
  uniform vec3 uZenith;
  uniform vec3 uHorizon;
  uniform vec3 uCloud;
  uniform float uCover;
  uniform float uScale;
  uniform float uFade;
  uniform float uTime;
  uniform float uIntensity;
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform float uSunVisible;
  uniform vec3 uMoonDir;
  uniform float uMoonVisible;
  uniform float uStars;
  uniform float uFlash;
  varying vec3 vDir;
  varying vec3 vWorldDir;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }

  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
  }

  float fbm(vec2 p) {
    float sum = 0.0;
    float amp = 0.5;
    for (int i = 0; i < 5; i++) {
      sum += amp * noise(p);
      p *= 2.03;
      amp *= 0.5;
    }
    return sum;
  }

  void main() {
    vec3 dir = normalize(vDir);
    float h = dir.y;
    // 天頂 → 地平線漸層；地平線以下全部是地平線色
    vec3 color = mix(uHorizon, uZenith, pow(clamp(h, 0.0, 1.0), 0.6));
    vec3 wd = normalize(vWorldDir);
    float cloud = 0.0;

    // 星星：天空切成小格，少數格子亮；越接近地平線越淡
    if (uStars > 0.0 && wd.y > 0.0) {
      vec3 cell = floor(wd * 700.0);
      float seed = fract(sin(dot(cell, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
      float star = step(0.9985, seed) * (0.4 + 0.6 * fract(seed * 7919.0)); // 少數格子亮，亮度不一
      color += vec3(star) * uStars * smoothstep(0.0, 0.25, wd.y);
    }

    if (h > 0.0) {
      // 雲投影在天空平面上（近大遠小），兩層不同速度飄動
      vec2 p = dir.xz / (h + 0.12) * uScale;
      float n = fbm(p + vec2(uTime, uTime * 0.35));
      n = n * 0.7 + fbm(p * 2.2 - vec2(uTime * 1.6, 0.0)) * 0.3;
      cloud = smoothstep(1.0 - uCover, 1.0 - uCover + 0.3, n);
      // 越接近地平線越淡：地平線一帶只剩霧色，跟場景模型的霧接得起來
      cloud *= smoothstep(0.0, uFade, h);
      vec3 cloudColor = uCloud * (0.75 + 0.25 * n);
      color = mix(color, cloudColor, cloud * 0.9);
    }

    // 太陽：圓盤 + 光暈；月亮：圓盤（被雲擋住會變淡）
    float sd = max(dot(wd, uSunDir), 0.0);
    color += uSunColor * (pow(sd, 7000.0) * 12.0 + pow(sd, 64.0) * 0.35) * uSunVisible * (1.0 - cloud * 0.92);
    color += vec3(0.85, 0.9, 1.0) * smoothstep(0.99955, 0.9997, dot(wd, uMoonDir)) * uMoonVisible * (1.0 - cloud * 0.95);

    color += vec3(0.75, 0.8, 1.0) * uFlash * (0.6 + 0.4 * cloud); // 閃電：雲被照亮得更明顯
    gl_FragColor = vec4(color * uIntensity, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`
