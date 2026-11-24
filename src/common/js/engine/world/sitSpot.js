import { InteractiveProp } from './interactiveProp.js'

/**
 * SitSpot：場景裡可以坐下的物件（例如營火 animated_fire.glb）
 * - 自帶的動畫一直循環播放（格鬥 / 自由模式都會動）；靠近時發亮（暖色點光源 + 火焰變亮）、顯示 F 坐下 / 起身
 * - 坐下 / 起身的動作由 freeMode.js 控制（sitDown / standUp），這裡只負責物件本身與提示（見 InteractiveProp）
 */
export class SitSpot extends InteractiveProp {
  static defaults = {
    labels: { use: '坐下', leave: '起身' },
    glow: { color: 0xff8a3d, lightIntensity: 6, lightDistance: 4, emissive: 0xff7a2a, emissiveIntensity: 0.6, emissiveBoost: 0.8 },
  }

  /** 互動種類（main.js 依這個決定按 F 做什麼） */
  get kind() {
    return 'sit'
  }

  onLoaded(gltf) {
    gltf.animations.forEach(clip => this.mixer.clipAction(clip).play())
  }

  /** 提示文字：isUsing = 正坐著 */
  getLabel(isUsing) {
    return isUsing ? this.labels.leave : this.labels.use
  }
}
