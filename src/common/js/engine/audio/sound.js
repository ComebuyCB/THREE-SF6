/**
 * Sound：音效播放（Web Audio，延遲比 <audio> 低，同一個音效可以重疊播放）
 * 瀏覽器規定要使用者操作過才能出聲，第一次按鍵 / 點擊時自動解鎖
 * files 每個音效給網址，或 { url, volume } 個別調整音量（再乘上總音量）
 * 循環播放（環境聲、天氣聲，setLoop）：音量平滑變過去（淡入淡出），降到 0 後停止；stopAll / stopGroup 不會停掉它
 */
export class Sound {
  constructor(options) {
    const def = {
      files: {}, // name → url 或 { url, volume }
      volume: 0.8, // 總音量
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
    this.ctx = new AudioContext({ latencyHint: 'interactive' })
    this.gain = this.ctx.createGain()
    this.gain.connect(this.ctx.destination)
    this.buffers = {} // name → AudioBuffer
    this.volumes = {} // name → 個別音量
    this.playing = new Set() // 播放中的 AudioBufferSourceNode，stopAll 用
    this.groups = new Map() // 分組 → 播放中的 AudioBufferSourceNode（例如某個人物的招式音效，stopGroup 用）
    this.loops = {} // name → { source, gain, stopTimer }：循環播放中
    this.loopTargets = {} // name → { level, fade }：最後要求的音量（還沒解鎖 / 還沒載入時先記著）

    // 5. init
    this.init()
  }

  init() {
    this.setVolume(this.volume)
    Object.entries(this.files).forEach(([name, file]) => {
      const { url, volume = 1 } = typeof file === 'string' ? { url: file } : file
      this.volumes[name] = volume
      this._load(name, url)
    })

    const unlock = () => {
      if (this.ctx.state !== 'suspended') return
      // 解鎖後補上還在等的循環播放（例如一開始就是雨天）
      this.ctx.resume().then(() => this._applyLoops())
    }
    window.addEventListener('keydown', unlock)
    window.addEventListener('pointerdown', unlock)
  }

  // public

  /**
   * @param {number} delay 延遲幾秒播放（現實時間）
   * @param {*} group 分組（任何值，例如 Fighter）：之後可用 stopGroup 只停這一組
   */
  play(name, delay = 0, group = null) {
    const buffer = this.buffers[name]
    if (!buffer || this.ctx.state !== 'running') return
    const source = this.ctx.createBufferSource()
    source.buffer = buffer
    const volume = this.volumes[name] ?? 1
    if (volume === 1) {
      source.connect(this.gain)
    } else {
      const gain = this.ctx.createGain()
      gain.gain.value = volume
      source.connect(gain).connect(this.gain)
    }
    source.start(this.ctx.currentTime + delay)
    this.playing.add(source)
    if (group != null) {
      if (!this.groups.has(group)) this.groups.set(group, new Set())
      this.groups.get(group).add(source)
    }
    source.onended = () => {
      this.playing.delete(source)
      this.groups.get(group)?.delete(source)
    }
  }

  /** 停止某一組播放中（含排程延遲播放）的音效 */
  stopGroup(group) {
    this.groups.get(group)?.forEach(source => {
      try {
        source.stop()
      } catch {
        // 還沒開始的排程音效在部分瀏覽器 stop 會丟錯，忽略
      }
      this.playing.delete(source)
    })
    this.groups.delete(group)
  }

  /** 停止所有播放中（含排程延遲播放）的音效 */
  stopAll() {
    this.playing.forEach(source => {
      try {
        source.stop()
      } catch {
        // 還沒開始的排程音效在部分瀏覽器 stop 會丟錯，忽略
      }
    })
    this.playing.clear()
    this.groups.clear()
  }

  /**
   * 循環播放（環境聲、天氣聲）：音量 level 0 ~ 1（再乘上個別音量），fade 秒平滑變過去；降到 0 後停止播放
   * 只在音量要改變時呼叫（每次呼叫都會從目前的音量重新開始淡入 / 淡出）
   */
  setLoop(name, level, fade = 2) {
    this.loopTargets[name] = { level, fade }
    if (this.ctx.state !== 'running' || !this.buffers[name]) return // 解鎖 / 載入好之後再套用（_applyLoops）
    let loop = this.loops[name]
    if (!loop) {
      if (level <= 0) return
      const source = this.ctx.createBufferSource()
      source.buffer = this.buffers[name]
      source.loop = true
      const gain = this.ctx.createGain()
      gain.gain.value = 0
      source.connect(gain).connect(this.gain)
      source.start()
      loop = this.loops[name] = { source, gain, stopTimer: null }
    }
    const t = this.ctx.currentTime
    const g = loop.gain.gain
    g.cancelScheduledValues(t)
    g.setValueAtTime(g.value, t)
    g.linearRampToValueAtTime(level * (this.volumes[name] ?? 1), t + Math.max(0.01, fade))
    clearTimeout(loop.stopTimer)
    if (level > 0) return
    // 淡出完才停（中途又要求變大聲就不停）
    loop.stopTimer = setTimeout(() => {
      if ((this.loopTargets[name]?.level ?? 0) > 0) return
      loop.source.stop()
      delete this.loops[name]
    }, fade * 1000 + 50)
  }

  setVolume(volume) {
    this.volume = volume
    this.gain.gain.value = volume
  }

  // internal

  /** 補上還在等的循環播放 */
  _applyLoops() {
    Object.entries(this.loopTargets).forEach(([name, { level, fade }]) => {
      if (!this.loops[name] && level > 0) this.setLoop(name, level, fade)
    })
  }

  async _load(name, url) {
    try {
      const res = await fetch(url)
      this.buffers[name] = await this.ctx.decodeAudioData(await res.arrayBuffer())
      if (this.loopTargets[name]) this._applyLoops() // 載入前就要求循環播放的（例如一開始就是雨天）
    } catch (err) {
      console.warn(`[Sound] ${url} 載入失敗`, err)
    }
  }
}
