import { InteractiveProp } from './interactiveProp.js'
import { trimClip } from '../assets/clipTools.js'

/**
 * SitSpot：場景裡可以坐下的物件（例如營火 animated_fire.glb）
 * - 自帶的動畫一直循環播放（格鬥 / 自由模式都會動）；靠近時發亮（暖色點光源 + 火焰變亮）、顯示 F 坐下 / 起身
 * - 坐下 / 起身的動作由 freeMode.js 控制（sitDown / standUp），這裡只負責物件本身與提示（見 InteractiveProp）
 */
export class SitSpot extends InteractiveProp {
  static defaults = {
    labels: { use: '坐下', leave: '起身', warping: '移動中…' }, // warping = 傳送換地圖中（不能起身）
    glow: { color: 0xff8a3d, lightIntensity: 6, lightDistance: 4, emissive: 0xff7a2a, emissiveIntensity: 0.6, emissiveBoost: 0.8 },
    playFrames: null, // 只循環動畫的一段：正數 = 前幾幀、負數 = 後幾幀（例如 -40 = 最後 40 幀）；null = 整段
    clipFps: 30, // 模型動畫的幀率（playFrames 用；animated_fire.glb 是 30）
    warpTo: null, // 坐下後傳送到哪個場景（場景名稱；傳送過程由 main.js 處理）；null = 不傳送
  }

  /** 互動種類（main.js 依這個決定按 F 做什麼） */
  get kind() {
    return 'sit'
  }

  onLoaded(gltf) {
    gltf.animations.forEach(clip => this.mixer.clipAction(this._cutClip(clip)).play())
  }

  /** 只留前 / 後 playFrames 幀（裁掉其餘的幀，裁切點的值用內插補上） */
  _cutClip(clip) {
    if (!this.playFrames) return clip
    const total = Math.round(clip.duration * this.clipFps)
    const count = Math.abs(this.playFrames)
    if (count >= total) return clip
    const cut = total - count
    return this.playFrames > 0 ? trimClip(clip, 0, cut, this.clipFps) : trimClip(clip, cut, 0, this.clipFps)
  }

  /** 提示文字：isUsing = 正坐著 */
  getLabel(isUsing) {
    return isUsing ? this.labels.leave : this.labels.use
  }
}
