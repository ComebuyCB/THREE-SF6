/**
 * MotionInput：一個玩家的方向鍵指令（下 → 前、下 → 後），配合攻擊鍵出招
 * - update：方向鍵每次按下 / 放開都記錄現在的方向狀態（{ x: -1 / 0 / 1, down }）
 * - read：按攻擊鍵的瞬間往回找「先有下、之後有左 / 右」，找到就回傳是前還是後
 *   斜下（下 + 前一起按著）也算：下 → 斜下前、斜下前 → 前、下 → 前都可以；只有同時按下斜下、沒有先後的不算
 */
export class MotionInput {
  constructor(options) {
    const def = {
      buttonTime: 200, // 左 / 右放開後幾毫秒內按攻擊鍵才算
      motionTime: 350, // 下放開後（或還按著）幾毫秒內按攻擊鍵才算
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
    this.log = [{ x: 0, down: false, time: 0 }] // 方向狀態的紀錄，每筆持續到下一筆的 time
  }

  // public

  /** 方向鍵有變化時記錄現在的狀態（毫秒，performance.now()） */
  update(x, down, now) {
    const last = this.log[this.log.length - 1]
    if (last.x === x && last.down === down) return
    this.log.push({ x, down, time: now })
    if (this.log.length > 16) this.log.shift()
  }

  /**
   * 按攻擊鍵的瞬間：有沒有完成指令
   * @param {number} facingSign 面向（+1 右、-1 左），決定左 / 右哪邊是前
   * @returns {'forward' | 'back' | null}
   */
  read(facingSign, now) {
    const endOf = i => this.log[i + 1]?.time ?? now
    for (let j = this.log.length - 1; j > 0; j--) {
      if (endOf(j) < now - this.buttonTime) return null
      const side = this.log[j]
      if (!side.x) continue
      for (let i = j - 1; i >= 0; i--) {
        if (endOf(i) < now - this.motionTime) break
        const down = this.log[i]
        // 有先後：先的那筆沒有這個方向（下 → 前），或後的那筆已經沒有下（斜下 → 前）
        if (down.down && (down.x !== side.x || !side.down)) return side.x === facingSign ? 'forward' : 'back'
      }
    }
    return null
  }

  /** 指令用掉了：只留現在的狀態，同一組方向不會再出第二次 */
  clear(now) {
    const { x, down } = this.log[this.log.length - 1]
    this.log = [{ x, down, time: now }]
  }
}
