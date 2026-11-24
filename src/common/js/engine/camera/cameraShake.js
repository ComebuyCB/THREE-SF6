import * as THREE from 'three'

/**
 * CameraShake：鏡頭晃動（跟玩法無關）
 * 渲染前 apply 把晃動位移加到鏡頭上、渲染後 restore 扣回去，不影響跟隨鏡頭、滑鼠操作與演出鏡頭的計算
 * 上下、左右用不同頻率，看起來比較像震動而不是規律擺動；幅度隨時間線性減弱
 */
export class CameraShake {
  constructor(options) {
    const def = {
      camera: null,
      duration: 0.3, // 晃多久（秒）
      frequency: 30, // 晃動頻率（Hz）
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
    this.shake = null // 晃動中：{ amp, time, duration, phase }（秒）
    this.offset = new THREE.Vector3() // 這個畫面加在鏡頭上的位移
  }

  // public

  /** 開始晃動（amp 公尺）；前一次還在晃時取比較大的幅度、從頭開始 */
  start(amp, duration = this.duration) {
    if (!amp) return
    const s = this.shake
    const remain = s ? s.amp * (1 - s.time / s.duration) : 0
    this.shake = { amp: Math.max(amp, remain), time: 0, duration, phase: Math.random() * Math.PI * 2 }
  }

  /** 立刻停止 */
  stop() {
    this.shake = null
  }

  /** 渲染前：推進時間、把晃動位移加到鏡頭上（delta = 遊戲時間，暫停時傳 0） */
  apply(delta) {
    this.offset.set(0, 0, 0)
    const s = this.shake
    if (!s) return
    s.time += delta
    if (s.time >= s.duration) {
      this.shake = null
      return
    }
    const k = s.amp * (1 - s.time / s.duration)
    const w = Math.PI * 2 * this.frequency * s.time
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0)
    const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1)
    this.offset.addScaledVector(right, k * Math.sin(w + s.phase)).addScaledVector(up, k * 0.8 * Math.sin(w * 1.37 + s.phase * 2))
    this.camera.position.add(this.offset)
  }

  /** 渲染後：扣回這個畫面的晃動 */
  restore() {
    this.camera.position.sub(this.offset)
  }
}
