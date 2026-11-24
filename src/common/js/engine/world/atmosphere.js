import * as THREE from 'three'
import { Rain } from './rain.js'

/** 天氣：overcast = 雲遮天的程度、rain = 雨量（0 ~ 1） */
export const WEATHERS = {
  晴天: { overcast: 0, rain: 0 },
  陰天: { overcast: 1, rain: 0 },
  雨天: { overcast: 1, rain: 1 },
}

/**
 * Atmosphere：一天的時間與天氣（跟玩法無關）
 * - 時間（0 ~ 24 點）決定太陽位置：6 點日出、12 點最高、18 點日落；晚上月亮在太陽的另一邊
 *   天空顏色（白天藍、日出日落地平線偏橘、晚上深藍 + 星星）、主光（方向、顏色、陰影跟著太陽，晚上換成月光）、環境光都跟著變
 *   isRunning 時時間自己往前走（speed = 每秒過幾分鐘）
 * - 天氣（WEATHERS）：切換時 transition 秒平滑過渡
 *   陰天：雲布滿、天空變灰、太陽被遮、光線變弱；雨天：再更暗、霧拉近、下雨（rain.js，含水花、屋頂下不下雨）
 * - 閃電（lightning）：雨量超過 minRain 時，每隔 gap 秒（範圍內隨機）閃一次：天空與燈光照幾下（pulses），環境光偏藍白
 * 天空透過 Sky（動態天空才有顏色變化；全景圖只跟著晝夜變暗），燈光透過 onLights 回傳亮度（讓使用的人再乘上自己的效果，例如演出變暗）
 */
export class Atmosphere {
  constructor(options) {
    const def = {
      scene: null,
      sky: null, // Sky
      hemi: null, // HemisphereLight（環境光）
      sun: null, // DirectionalLight（主光：白天太陽、晚上月亮；照向 target，target 由 setFocus 移動）
      sunDistance: 10, // 主光離 target 多遠（公尺）
      // 室內（setIndoor）：主光不跟太陽，固定從 dir 方向照下來、亮度 power（不受時間、天氣影響），影子一直都在
      indoorLight: { dir: [0.25, 1, 0.15], power: 2 },
      time: 15, // 幾點（0 ~ 24）
      isRunning: false,
      speed: 10, // 時間流速：每秒過幾分鐘
      weather: '晴天',
      transition: 3, // 換天氣的過渡秒數
      cloudCover: 0.5, // 晴天的雲量（陰天以上會蓋滿）
      getEnv: null, // () → 場景模型（雨的落點、屋頂下不下雨）
      // 閃電：enabled、雨量至少 minRain 才打、間隔 gap 秒（隨機）、亮度 power、閃法 pulses（[開始秒, 持續秒, 強度]）
      lightning: { enabled: true, minRain: 0.6, gap: [5, 14], power: 1, pulses: [[0, 0.07, 1], [0.13, 0.05, 0.55], [0.26, 0.12, 0.85]] },
      light: { sun: 2.5, hemi: 2, moon: 0.4, nightHemi: 0.35 }, // 亮度：中午的太陽、白天的環境光、月光、晚上的環境光
      // 夜晚燈光亮度 0 ~ 1：晚上的環境光、月光往白天拉（0 = 真實的暗、1 = 跟白天一樣亮、不偏藍）
      // 烘焙光影的場景本來就不會變暗，只有吃燈光的人物、物件會；拉高讓人物跟場景一樣亮
      nightBright: 0,
      onLights: null, // ({ hemi, dir }) → 主光、環境光的基本亮度（沒給 = 直接設在燈上）
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
    const w = WEATHERS[this.weather] ?? WEATHERS.晴天
    this.overcast = w.overcast // 目前的值（往天氣的目標值平滑靠近）
    this.rainAmount = w.rain
    this.rain = new Rain({ scene: this.scene, getEnv: this.getEnv })
    this.flash = 0 // 閃電目前的亮度 0 ~ 1
    this.strike = null // 閃電中：{ time }
    this.nextStrike = this._randomGap()
    this.sunDir = new THREE.Vector3()
    this.moonDir = new THREE.Vector3()
    this.isIndoor = false
    this.lightDir = new THREE.Vector3(0, 1, 0) // 主光從哪個方向照過來（單位向量）

    // 5. init
    this.apply()
  }

  // public

  /** 換天氣（WEATHERS 的名稱）：transition 秒平滑過渡；isInstant = 直接換 */
  setWeather(name, isInstant = false) {
    if (!WEATHERS[name]) return
    this.weather = name
    if (!isInstant) return
    this.overcast = WEATHERS[name].overcast
    this.rainAmount = WEATHERS[name].rain
    this.apply()
  }

  setTime(hours) {
    this.time = ((hours % 24) + 24) % 24
    this.apply()
  }

  /** 每個畫面：時間流動、天氣過渡、雨（delta = 遊戲時間） */
  update(delta, camera) {
    let isChanged = false
    if (this.isRunning && delta > 0) {
      this.time = (this.time + (this.speed / 60) * delta) % 24
      isChanged = true
    }
    const target = WEATHERS[this.weather]
    const step = this.transition > 0 ? delta / this.transition : 1
    const approach = (value, goal) => (value < goal ? Math.min(goal, value + step) : Math.max(goal, value - step))
    if (this.overcast !== target.overcast || this.rainAmount !== target.rain) {
      this.overcast = approach(this.overcast, target.overcast)
      this.rainAmount = approach(this.rainAmount, target.rain)
      isChanged = true
    }
    if (this._updateLightning(delta)) isChanged = true
    if (isChanged) this.apply()
    this.rain.update(delta, camera)
  }

  /** 室內 / 室外：室外主光（影子）跟著太陽、月亮；室內固定從上方照、不受時間天氣影響 */
  setIndoor(isIndoor) {
    this.isIndoor = !!isIndoor
    this.apply()
  }

  /** 主光照向的點（例如人物腳底）：影子範圍跟著這個點，人物走多遠影子都在 */
  setFocus(point) {
    this.sun.target.position.copy(point)
    this.sun.position.copy(point).addScaledVector(this.lightDir, this.sunDistance)
  }

  /** 馬上打一次閃電（GUI 測試用） */
  triggerLightning() {
    this.strike = { time: 0 }
  }

  /** 依目前的時間、天氣算出天空、燈光、霧、雨 */
  apply() {
    const o = this.overcast
    const r = this.rainAmount
    const { sunDir, moonDir } = this

    // 太陽：6 點從東邊（-x）升起，12 點最高，18 點西邊（+x）落下；稍微偏向鏡頭那側（+z），人物正面有光
    const a = ((this.time - 6) / 12) * Math.PI
    sunDir.set(-Math.cos(a) * 0.8, Math.sin(a), 0.45).normalize()
    moonDir.set(-sunDir.x, -sunDir.y, 0.45).normalize()
    const e = sunDir.y // 太陽高度（sin）
    const day = THREE.MathUtils.smoothstep(e, -0.15, 0.25) // 0 = 夜、1 = 白天
    const dusk = Math.exp(-((e / 0.15) ** 2)) // 日出日落時最大
    const night = 1 - day

    // 天空顏色：夜 → 白天，日出日落地平線偏橘；陰天往灰色靠、雨天再更暗
    const zenith = _c1.copy(COLORS.nightZenith).lerp(COLORS.dayZenith, day).lerp(COLORS.duskZenith, dusk * 0.35)
    const horizon = _c2.copy(COLORS.nightHorizon).lerp(COLORS.dayHorizon, day).lerp(COLORS.duskHorizon, dusk * 0.8 * (1 - o))
    const gray = _c3.copy(COLORS.overcast).multiplyScalar(0.12 + 0.88 * day)
    zenith.lerp(gray, o * 0.85).multiplyScalar(1 - 0.35 * r)
    horizon.lerp(gray, o * 0.8).multiplyScalar(1 - 0.3 * r)
    const dome = this.sky.dome
    dome.setColors(zenith, horizon)
    dome.setCloudCover(THREE.MathUtils.lerp(this.cloudCover, 0.95, o))
    dome.setCloudColor(_c4.copy(COLORS.cloud).lerp(COLORS.rainCloud, o).multiplyScalar(0.08 + 0.92 * day).multiplyScalar(1 - 0.3 * r))
    dome.setSun(sunDir, _c5.copy(COLORS.sunLow).lerp(COLORS.sunHigh, THREE.MathUtils.smoothstep(e, 0, 0.5)), THREE.MathUtils.smoothstep(e, -0.05, 0.05) * (1 - o))
    dome.setMoon(moonDir, THREE.MathUtils.smoothstep(moonDir.y, -0.05, 0.05) * night * (1 - o))
    dome.setFlash(this.flash)
    dome.setStars(THREE.MathUtils.smoothstep(night, 0.6, 1) * (1 - o)) // 天色真的暗了才出現
    this.sky.syncHorizon()
    this.sky.setDaylight(THREE.MathUtils.lerp(0.12, 1, day) * (1 - 0.4 * o) * (1 - 0.3 * r))
    this.sky.setFogScale(1 - 0.5 * r)

    // 主光：太陽在地平線上用太陽，否則用月光；陰天、雨天變弱
    const { light } = this
    const sunPower = light.sun * THREE.MathUtils.smoothstep(e, -0.05, 0.2)
    const nb = this.nightBright
    const moonPower = THREE.MathUtils.lerp(light.moon, light.sun * 0.7, nb) * night // 月光：夜晚燈光亮度拉高時變亮
    const isSun = sunPower >= moonPower
    let dirPower = (isSun ? sunPower : moonPower) * (1 - 0.75 * o) * (1 - 0.5 * r)
    if (this.isIndoor) {
      // 室內：固定從上方照、白光，亮度不跟時間天氣
      this.lightDir.fromArray(this.indoorLight.dir).normalize()
      this.sun.color.set(0xffffff)
      dirPower = this.indoorLight.power
    } else {
      this.lightDir.copy(isSun ? sunDir : moonDir)
      this.sun.color.copy(isSun ? _c5 : _c6.copy(COLORS.moonLight).lerp(COLORS.daySkyLight, nb))
    }
    this.setFocus(this.sun.target.position)
    // 環境光：天空那側跟著天色，晚上偏藍、變暗；陰天時主光弱，環境光相對變成主要光源
    const f = this.flash * this.lightning.power
    const lit = THREE.MathUtils.lerp(day, 1, nb) // 燈光用的白天程度（夜晚燈光亮度拉高時，晚上的環境光也接近白天）
    const hemiPower = THREE.MathUtils.lerp(light.nightHemi, light.hemi, lit) * (1 - 0.25 * o) * (1 - 0.3 * r) + f * 3
    this.hemi.color.copy(COLORS.nightSkyLight).lerp(COLORS.daySkyLight, lit).lerp(COLORS.lightning, Math.min(1, f))
    this.hemi.groundColor.copy(COLORS.nightGround).lerp(COLORS.dayGround, lit)

    this.sky.setDaylight(Math.min(2, this.sky.daylight + f)) // 全景圖天空也閃
    if (this.onLights) this.onLights({ hemi: hemiPower, dir: dirPower + f * 1.5 })
    else {
      this.hemi.intensity = hemiPower
      this.sun.intensity = dirPower
    }
    this.rain.setAmount(r)
  }

  // internal

  _randomGap() {
    const [min, max] = this.lightning.gap
    return THREE.MathUtils.randFloat(min, max)
  }

  /**
   * 閃電：雨夠大時倒數，時間到就打一次；打的時候依 pulses 算目前亮度
   * @returns {boolean} 亮度有沒有變（要不要重新套用燈光）
   */
  _updateLightning(delta) {
    const lt = this.lightning
    if (!this.strike && lt.enabled && this.rainAmount >= lt.minRain && delta > 0) {
      this.nextStrike -= delta
      if (this.nextStrike <= 0) {
        this.strike = { time: 0 }
        this.nextStrike = this._randomGap()
      }
    }
    const prev = this.flash
    if (this.strike) {
      const t = (this.strike.time += delta)
      let flash = 0
      lt.pulses.forEach(([start, duration, power]) => {
        if (t >= start && t < start + duration) flash = Math.max(flash, power * (1 - (t - start) / duration) ** 0.5)
      })
      this.flash = flash
      const end = Math.max(...lt.pulses.map(([start, duration]) => start + duration))
      if (t >= end) {
        this.strike = null
        this.flash = 0
      }
    }
    return this.flash !== prev
  }
}

const COLORS = {
  lightning: new THREE.Color('#dfe6ff'),
  dayZenith: new THREE.Color('#3f6fb5'),
  dayHorizon: new THREE.Color('#c8d5e2'),
  duskZenith: new THREE.Color('#4a4f8a'),
  duskHorizon: new THREE.Color('#f08a4b'),
  nightZenith: new THREE.Color('#050a1a'),
  nightHorizon: new THREE.Color('#101a30'),
  overcast: new THREE.Color('#9aa0a8'),
  cloud: new THREE.Color('#ffffff'),
  rainCloud: new THREE.Color('#6f757e'),
  sunLow: new THREE.Color('#ffb070'),
  sunHigh: new THREE.Color('#fff6e8'),
  moonLight: new THREE.Color('#8fa8ff'),
  daySkyLight: new THREE.Color('#ffffff'),
  nightSkyLight: new THREE.Color('#5a6a9a'),
  dayGround: new THREE.Color('#444444'),
  nightGround: new THREE.Color('#1a1a22'),
}
const _c1 = new THREE.Color()
const _c2 = new THREE.Color()
const _c3 = new THREE.Color()
const _c4 = new THREE.Color()
const _c5 = new THREE.Color()
const _c6 = new THREE.Color()
