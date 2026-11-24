/**
 * 合成音效的預設（playSynth）：name → 層 [{ type 波形, from → to 頻率（Hz）, duration 秒, volume 0 ~ 1,
 *   lowpass 低通（Hz，可省略）, attack 淡入秒數（預設 0.008，越長越柔、沒有衝擊感）, delay 延遲幾秒才開始（預設 0）}]
 */
const SYNTHS = {
  // DG 不夠、衝刺取消改扣白血：柔和的低音警示「嗚—」（一聲，音高慢慢往下一點）；慢慢淡入，沒有重擊感
  // 頻率避開 60 Hz 以下的超低頻（那種會「震」），三角波疊一點點讓聲音在小喇叭也聽得到
  emptyRush: [
    { type: 'sine', from: 140, to: 108, duration: 0.65, volume: 0.21, attack: 0.06 },
    { type: 'triangle', from: 140, to: 108, duration: 0.65, volume: 0.065, attack: 0.06, lowpass: 500 },
  ],
}

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
    this.isPaused = false // setPaused：整個音訊暫停（播放中的音效、循環聲停在原地，恢復後接著播）

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
      if (this.ctx.state !== 'suspended' || this.isPaused) return // 暫停中（setPaused）不因為按鍵就恢復
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

  /**
   * 合成音效（不用音檔，SYNTHS 的預設）：每一層是一個振盪器，頻率從 from 滑到 to、音量快速起來再淡掉
   * 跟一般音效一樣受總音量、暫停影響，stopAll 也會停掉
   */
  playSynth(name) {
    const layers = SYNTHS[name]
    if (!layers || this.ctx.state !== 'running') return
    const ctx = this.ctx
    layers.forEach(({ type, from, to, duration, volume, lowpass, attack = 0.008, delay = 0 }) => {
      const t = ctx.currentTime + delay
      const osc = ctx.createOscillator()
      osc.type = type
      osc.frequency.setValueAtTime(from, t)
      osc.frequency.exponentialRampToValueAtTime(to, t + duration)
      const gain = ctx.createGain()
      gain.gain.setValueAtTime(0.0001, t) // 延遲播放的層：振盪器 t 才開始，之前本來就沒聲音
      gain.gain.exponentialRampToValueAtTime(volume, t + attack) // 淡入（太短會有爆音、太長沒有起音）
      gain.gain.exponentialRampToValueAtTime(0.0001, t + duration)
      let node = osc
      if (lowpass) {
        const filter = ctx.createBiquadFilter()
        filter.type = 'lowpass'
        filter.frequency.value = lowpass
        node = node.connect(filter)
      }
      node.connect(gain).connect(this.gain)
      osc.start(t)
      osc.stop(t + duration + 0.02)
      this.playing.add(osc)
      osc.onended = () => this.playing.delete(osc)
    })
  }

  /**
   * 暫停 / 恢復所有聲音（例如打開主選單）：播放中的音效、循環聲停在原地，恢復後從停下的地方接著播
   * 暫停中 play 不出聲；setLoop 的音量先記著，恢復時補上
   */
  setPaused(isPaused) {
    if (this.isPaused === isPaused) return
    this.isPaused = isPaused
    if (isPaused) {
      if (this.ctx.state === 'running') this.ctx.suspend()
      return
    }
    // 還沒解鎖過（沒按過鍵）時 resume 會被瀏覽器擋，等下一次按鍵 / 點擊解鎖
    this.ctx.resume().then(() => this._applyLoops()).catch(() => {})
  }

  setVolume(volume) {
    this.volume = volume
    this.gain.gain.value = volume
  }

  // internal

  /** 補上還在等的循環播放；已經在播的也套用最後要求的音量（暫停期間天氣變了） */
  _applyLoops() {
    Object.entries(this.loopTargets).forEach(([name, { level, fade }]) => {
      if (this.loops[name] || level > 0) this.setLoop(name, level, fade)
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
