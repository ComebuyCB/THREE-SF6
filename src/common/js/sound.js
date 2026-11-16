/**
 * Sound：音效播放（Web Audio，延遲比 <audio> 低，同一個音效可以重疊播放）
 * 瀏覽器規定要使用者操作過才能出聲，第一次按鍵 / 點擊時自動解鎖
 * files 每個音效給網址，或 { url, volume } 個別調整音量（再乘上總音量）
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
      if (this.ctx.state === 'suspended') this.ctx.resume()
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

  setVolume(volume) {
    this.volume = volume
    this.gain.gain.value = volume
  }

  // internal

  async _load(name, url) {
    try {
      const res = await fetch(url)
      this.buffers[name] = await this.ctx.decodeAudioData(await res.arrayBuffer())
    } catch (err) {
      console.warn(`[Sound] ${url} 載入失敗`, err)
    }
  }
}
