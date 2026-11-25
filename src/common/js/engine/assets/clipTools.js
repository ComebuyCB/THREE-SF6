import * as THREE from 'three'

/**
 * 動作片段（AnimationClip）處理工具：跟玩法無關，任何用 Mixamo 骨架動作的模式都能用
 * 幀數一律用遊戲幀（預設 60fps，可傳 fps 改）；都回傳新的 clip，不改原本的
 */

/** 動作固定後的臀部水平位置 { x, z }（第一格）；沒有臀部 track = null */
export function getHipsPin(clip) {
  const values = clip?.tracks.find(t => t.name.endsWith('Hips.position'))?.values
  return values ? { x: values[0], z: values[2] } : null
}

/**
 * 人物變亮：材質顏色（會乘上貼圖）乘上倍率，超過 1 = 比貼圖原色亮
 * 在人物 clone 之前改，clone 出來的人物會把這個顏色當成原色
 */
export function brightenScene(scene, rate) {
  scene.traverse(obj => {
    if (!obj.isMesh) return
    ;[obj.material].flat().forEach(material => material.color?.multiplyScalar(rate))
  })
}

/**
 * 裁掉動作開頭 startFrames 幀、結尾 endFrames 幀：每條 track 在兩個裁切點補內插出來的 key，中間的 key 往前平移
 * 要在 makeInPlace 之前做，root motion 才會從裁切後的第一幀算起
 */
export function trimClip(source, startFrames, endFrames, fps = 60) {
  const start = startFrames / fps
  const end = source.duration - endFrames / fps
  if (end - start <= 0) return source

  const tracks = source.tracks.map(track => {
    const size = track.getValueSize()
    const interpolant = track.createInterpolant()
    const first = interpolant.evaluate(start).slice()
    const last = interpolant.evaluate(end).slice()
    const keep = []
    track.times.forEach((t, i) => t > start && t < end && keep.push(i))

    const count = keep.length + 2
    const times = new Float32Array(count)
    const values = new Float32Array(count * size)
    values.set(first, 0)
    keep.forEach((i, n) => {
      times[n + 1] = track.times[i] - start
      values.set(track.values.subarray(i * size, (i + 1) * size), (n + 1) * size)
    })
    times[count - 1] = end - start
    values.set(last, (count - 1) * size)
    return new track.constructor(track.name, times, values)
  })
  return new THREE.AnimationClip(source.name, end - start, tracks)
}

/**
 * 動作開頭 toFrames 幀改成 rate 倍速：key 的時間在這段內除以 rate，之後的整段往前平移
 * 要在 makeInPlace 之前做，root motion 才會跟著新的時間
 */
export function speedUpClip(source, toFrames, rate, fps = 60) {
  const end = Math.min(toFrames / fps, source.duration)
  const remap = t => (t <= end ? t / rate : t - end + end / rate)
  const tracks = source.tracks.map(track => new track.constructor(track.name, track.times.map(remap), track.values))
  return new THREE.AnimationClip(source.name, remap(source.duration), tracks)
}

/**
 * 原地播放：固定臀部的水平位置，讓位移交給程式控制（格鬥遊戲常用作法）
 * isRootMotion：先把臀部的前後位移（Z）存成 clip.rootMotion（{ axis, times, values }），由程式轉成人物座標
 * isFlattenRise：臀部高度不超過第一格（保留下蹲、拿掉往上跳）
 * isAxisX：root motion 改取側向（X）位移
 * isCenterHips：臀部水平位置固定在原點，而不是第一格的位置
 * pinTo：{ x, z } 臀部水平位置固定在這裡（對齊另一個動作，見 getHipsPin）
 */
export function makeInPlace(source, { isRootMotion = false, isFlattenRise = false, isAxisX = false, isCenterHips = false, pinTo = null } = {}) {
  const clip = source.clone()
  const hipsTrack = clip.tracks.find(t => t.name.endsWith('Hips.position'))
  if (!hipsTrack) return clip

  const values = hipsTrack.values
  const startX = values[0]
  const startZ = values[2]

  if (isRootMotion) {
    clip.rootMotion = {
      axis: isAxisX ? 'x' : 'z',
      times: hipsTrack.times.slice(),
      values: hipsTrack.times.map((_, i) => (isAxisX ? values[i * 3] - startX : values[i * 3 + 2] - startZ)),
    }
  }

  const startY = values[1]
  const pinX = pinTo ? pinTo.x : isCenterHips ? 0 : startX
  const pinZ = pinTo ? pinTo.z : isCenterHips ? 0 : startZ
  for (let i = 0; i < values.length; i += 3) {
    values[i] = pinX
    values[i + 2] = pinZ
    if (isFlattenRise) values[i + 1] = Math.min(values[i + 1], startY)
  }
  return clip
}

/**
 * 動作某一段身體朝向偏掉時轉正：整個身體（臀部）繞人物中心的 Y 軸多轉幾度
 * keys：[[幀, 度], ...]（由小到大），中間平滑過渡，頭尾之外維持第一個 / 最後一個值；度數正值 = 往人物的左手邊轉
 * 要在 makeInPlace 之後做（臀部已經固定在原地）；rootMotion 不變，人物前進的路線不受影響
 */
export function turnClip(source, keys, fps = 60) {
  const clip = source.clone()
  if (source.rootMotion) clip.rootMotion = source.rootMotion
  const getAngle = time => {
    const f = time * fps
    const next = keys.findIndex(([frame]) => frame > f)
    if (next === 0) return THREE.MathUtils.degToRad(keys[0][1])
    if (next === -1) return THREE.MathUtils.degToRad(keys[keys.length - 1][1])
    const [f0, d0] = keys[next - 1]
    const [f1, d1] = keys[next]
    return THREE.MathUtils.degToRad(THREE.MathUtils.lerp(d0, d1, THREE.MathUtils.smoothstep(f, f0, f1)))
  }
  const up = new THREE.Vector3(0, 1, 0)
  const turn = new THREE.Quaternion()
  const q = new THREE.Quaternion()
  const v = new THREE.Vector3()
  clip.tracks.forEach(track => {
    const isRotation = track.name.endsWith('Hips.quaternion')
    if (!isRotation && !track.name.endsWith('Hips.position')) return
    const size = isRotation ? 4 : 3
    // 片段的 key 可能比過渡段稀疏：每個遊戲幀補一個 key，轉動才會平順
    const count = Math.round(clip.duration * fps) + 1
    const interpolant = track.createInterpolant()
    const times = new Float32Array(count)
    const values = new Float32Array(count * size)
    for (let i = 0; i < count; i++) {
      const time = Math.min(i / fps, clip.duration)
      times[i] = time
      const value = interpolant.evaluate(time)
      turn.setFromAxisAngle(up, getAngle(time))
      if (isRotation) q.fromArray(value).premultiply(turn).toArray(values, i * size)
      else v.fromArray(value).applyQuaternion(turn).toArray(values, i * size)
    }
    track.times = times
    track.values = values
  })
  return clip
}
