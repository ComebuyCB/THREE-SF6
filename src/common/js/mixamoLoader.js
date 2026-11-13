import * as THREE from 'three'
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'

// 每個 Mixamo 人物的骨頭前綴不同（mixamorig、mixamorig12…），統一成 mixamorig 才能共用動作
// FBXLoader / GLTFLoader 都會移除冒號：mixamorig12:Hips → mixamorig12Hips
const BONE_PREFIX_RE = /^mixamorig\d*/
const BONE_PREFIX = 'mixamorig'
const HIPS = `${BONE_PREFIX}Hips`

/**
 * MixamoLoader：在瀏覽器讀人物（GLB 或 FBX）與動作 FBX，並把動作綁到人物上，動作可以給所有人物共用
 *
 * 人物建議用 GLB：由 Desktop/FbxToGlb 工具從 Mixamo FBX 轉出，檔案約小 10 倍，材質也已在 Blender 修好
 * GLB 要求：骨架外層的 Armature 節點不能有旋轉 / 縮放（工具匯出前已套用變換），否則臀部位移的方向與單位會錯
 *
 * 處理的問題：
 * 1. 骨頭前綴不一致 → 統一名稱
 * 2. 各人物臀部高度 / 單位不同 → 臀部位移依高度比例縮放
 * 3. 人物 FBX 的材質是 Phong，頭髮、睫毛會被當成半透明 → 轉成 Standard，透明改用 alphaTest（GLB 不需要）
 * 4. 動作骨架的軸向、靜止姿勢、骨頭長度和人物不同 → 世界空間重定向，見 bindAnimation
 */
export class MixamoLoader {
  constructor(options) {
    const def = {
      roughness: 0.75, // Mixamo 貼圖沒有可靠的粗糙度，統一用偏霧面的值
      alphaTest: 0.5,
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
    this.loader = new FBXLoader()
    this.gltfLoader = new GLTFLoader()
    this.cache = {} // url → Promise，同一個檔案只下載一次
  }

  // public

  /**
   * 載入人物（.glb 或 .fbx）
   * @returns {Promise<{ scene: THREE.Group, hipsY: number, boneNames: Set<string> }>}
   */
  loadCharacter(url, onProgress) {
    const isGltf = this._isGltf(url)
    return this._load(url, onProgress, result => {
      const object = isGltf ? result.scene : result
      this._normalizeBones(object)
      // GLB 的材質在轉檔工具裡已修好；FBX 才需要轉換
      if (!isGltf) this._fixMaterials(object)
      // 人物自帶的動作用不到（FBX 會帶一個單格動作）
      object.animations = []
      this._checkArmature(object, url)

      const boneNames = new Set()
      object.traverse(obj => {
        if (obj.isBone) boneNames.add(obj.name)
      })
      return { scene: object, hipsY: this._getHipsY(object), boneNames }
    })
  }

  /**
   * 載入動作 FBX（Mixamo 下載時選 Without Skin，或自己錄製、骨頭名稱沿用 mixamorig 的檔案）
   * 載入時就把動作在「原本的骨架」上播一遍，記下每幀每根骨頭的世界旋轉，供 bindAnimation 重定向
   * @returns {Promise<{ clip, hipsY, times, rest, frames }>}
   */
  loadAnimation(url, onProgress) {
    return this._load(url, onProgress, object => {
      this._normalizeBones(object)
      const clip = object.animations[0]
      clip.tracks.forEach(track => {
        track.name = track.name.replace(BONE_PREFIX_RE, BONE_PREFIX)
      })
      return { clip, hipsY: this._getHipsY(object), ...this._sampleSource(object, clip) }
    })
  }

  /**
   * 把動作重定向到人物（世界空間）
   * 錄製的動作骨架跟人物骨架的 local 軸向、靜止姿勢、骨頭長度都可能不同，不能直接複製 local 旋轉：
   * 1. 每根骨頭先算「靜止時，人物骨頭指向子骨頭的方向」轉到「動作骨架同一根骨頭方向」的修正 A
   * 2. 每幀：人物骨頭世界旋轉 = 動作骨頭世界旋轉 × 動作靜止世界旋轉⁻¹ × A × 人物靜止世界旋轉
   *    → 骨頭方向跟動作骨架完全一致，與兩邊 local 軸向無關
   * 3. 再換回相對父骨頭的 local 旋轉寫成 track
   * 位移只保留臀部（依臀部高度比例縮放）；其他骨頭的位移 / 縮放 / 表情 track 都丟掉，人物維持自己的骨頭長度
   * @returns {THREE.AnimationClip}
   */
  bindAnimation(character, animation, name) {
    const { times, rest, frames } = animation
    const scene = character.scene
    scene.updateMatrixWorld(true)

    // 人物上會被動畫綁定的骨頭（PropertyBinding 依名稱找第一個符合的物件）
    const targets = []
    const targetByObject = new Map()
    scene.traverse(obj => {
      if (!obj.isBone || !rest[obj.name] || scene.getObjectByName(obj.name) !== obj) return
      const restWorld = obj.getWorldQuaternion(new THREE.Quaternion())
      const correction = this._getRestCorrection(obj, restWorld, rest)
      const target = { obj, name: obj.name, restWorld, correction, values: new Float32Array(times.length * 4) }
      targets.push(target)
      targetByObject.set(obj, target)
    })

    const sourceRestInv = name => rest[name].world.clone().invert()
    const restInv = Object.fromEntries(targets.map(t => [t.name, sourceRestInv(t.name)]))
    const world = new Map() // 這一幀已算好的世界旋轉
    const q = new THREE.Quaternion()
    const parentWorld = new THREE.Quaternion()

    times.forEach((_, f) => {
      world.clear()
      // traverse 是先父後子，父骨頭的世界旋轉一定先算好
      scene.traverse(obj => {
        if (obj === scene) return
        if (world.has(obj.parent)) parentWorld.copy(world.get(obj.parent))
        else obj.parent.getWorldQuaternion(parentWorld)

        const target = targetByObject.get(obj)
        if (!target) {
          if (obj.isBone) world.set(obj, parentWorld.clone().multiply(obj.quaternion))
          return
        }

        const w = q.fromArray(frames[target.name], f * 4)
          .multiply(restInv[target.name])
          .multiply(target.correction)
          .multiply(target.restWorld)
          .clone()
        world.set(obj, w)

        const local = parentWorld.clone().invert().multiply(w)
        local.toArray(target.values, f * 4)
      })
    })

    const tracks = targets.map(t => new THREE.QuaternionKeyframeTrack(`${t.name}.quaternion`, times, t.values))

    const hipsTrack = animation.clip.tracks.find(t => t.name === `${HIPS}.position`)
    if (hipsTrack && character.boneNames.has(HIPS)) {
      const ratio = character.hipsY / animation.hipsY
      const copy = hipsTrack.clone()
      for (let i = 0; i < copy.values.length; i++) copy.values[i] *= ratio
      tracks.push(copy)
    }

    return new THREE.AnimationClip(name, animation.clip.duration, tracks)
  }

  // internal

  _load(url, onProgress, parse) {
    if (!this.cache[url]) {
      const loader = this._isGltf(url) ? this.gltfLoader : this.loader
      this.cache[url] = loader.loadAsync(url, onProgress).then(parse)
    }
    return this.cache[url]
  }

  _isGltf(url) {
    return /\.(glb|gltf)$/i.test(url)
  }

  /** 臀部的父節點有旋轉 / 縮放時，動作的臀部位移會套錯方向，提醒重新用 FbxToGlb 轉檔 */
  _checkArmature(object, url) {
    const parent = object.getObjectByName(HIPS)?.parent
    if (!parent) return
    object.updateMatrixWorld(true)
    const scale = new THREE.Vector3()
    const rotation = new THREE.Quaternion()
    parent.matrixWorld.decompose(new THREE.Vector3(), rotation, scale)
    const isClean = Math.abs(scale.x - 1) < 1e-3 && rotation.angleTo(new THREE.Quaternion()) < 1e-3
    if (!isClean) console.warn(`[MixamoLoader] ${url}：骨架外層有旋轉或縮放，臀部位移會錯，請用 FbxToGlb 重新轉檔`)
  }

  /**
   * 在動作自己的骨架上播一遍，記下靜止與每幀的骨頭世界旋轉
   * rest[name] = { world, dir }：dir 是靜止時指向子骨頭的世界方向（沒有子骨頭為 null）
   * frames[name] = Float32Array，每幀 4 個值
   */
  _sampleSource(object, clip) {
    const bones = {}
    object.traverse(obj => {
      if (obj.isBone && !bones[obj.name]) bones[obj.name] = obj
    })

    object.updateMatrixWorld(true)
    const rest = {}
    Object.values(bones).forEach(bone => {
      const world = bone.getWorldQuaternion(new THREE.Quaternion())
      // 有多個子骨頭（Hips、Spine2）時以脊椎主幹為準，例如 Spine2 對齊 Neck 而不是肩膀
      const children = bone.children.filter(c => c.isBone && c.position.lengthSq() > 1e-8)
      const child = children.find(c => /Spine|Neck|Head/.test(c.name)) || children[0]
      const dir = child ? child.getWorldPosition(new THREE.Vector3()).sub(bone.getWorldPosition(new THREE.Vector3())).normalize() : null
      rest[bone.name] = { world, dir, child: child?.name }
    })

    // 只用旋轉 track 取樣（位移、縮放、表情不影響旋轉）
    const rotationClip = new THREE.AnimationClip('sample', clip.duration, clip.tracks.filter(t => t.name.endsWith('.quaternion')))
    const hipsRotation = rotationClip.tracks.find(t => t.name === `${HIPS}.quaternion`) || rotationClip.tracks[0]
    const times = Float32Array.from(hipsRotation.times)

    const mixer = new THREE.AnimationMixer(object)
    mixer.clipAction(rotationClip).play()
    const frames = Object.fromEntries(Object.keys(bones).map(name => [name, new Float32Array(times.length * 4)]))
    const q = new THREE.Quaternion()

    times.forEach((t, f) => {
      mixer.setTime(t)
      object.updateMatrixWorld(true)
      Object.entries(bones).forEach(([name, bone]) => bone.getWorldQuaternion(q).toArray(frames[name], f * 4))
    })
    mixer.stopAllAction()
    mixer.uncacheRoot(object)

    return { times, rest, frames }
  }

  /**
   * 靜止姿勢修正：把人物骨頭靜止時的方向轉到動作骨架同一根骨頭的方向（世界空間）
   * 兩邊用同一根子骨頭判斷方向；找不到就不修正
   */
  _getRestCorrection(bone, restWorld, sourceRest) {
    const source = sourceRest[bone.name]
    const child = source?.child && bone.children.find(c => c.name === source.child)
    if (!source?.dir || !child) return new THREE.Quaternion()

    const dir = child.getWorldPosition(new THREE.Vector3()).sub(bone.getWorldPosition(new THREE.Vector3()))
    if (dir.lengthSq() < 1e-10) return new THREE.Quaternion()
    // A 作用在人物靜止世界旋轉之前（左乘），所以在世界空間把人物方向轉到動作方向
    return new THREE.Quaternion().setFromUnitVectors(dir.normalize(), source.dir)
  }

  _normalizeBones(object) {
    object.traverse(obj => {
      if (obj.isBone) obj.name = obj.name.replace(BONE_PREFIX_RE, BONE_PREFIX)
    })
  }

  _getHipsY(object) {
    return object.getObjectByName(HIPS)?.position.y || 1
  }

  /** Phong → Standard；有透明貼圖的部位改用 alphaTest，避免半透明排序錯誤 */
  _fixMaterials(object) {
    const converted = new Map() // 同一個材質只轉一次

    const convert = material => {
      if (!converted.has(material)) {
        const isCutout = material.transparent || !!material.alphaMap
        converted.set(material, new THREE.MeshStandardMaterial({
          name: material.name,
          color: material.color,
          map: material.map,
          normalMap: material.normalMap,
          alphaMap: material.alphaMap,
          alphaTest: isCutout ? this.alphaTest : 0,
          side: isCutout ? THREE.DoubleSide : THREE.FrontSide,
          roughness: this.roughness,
          metalness: 0,
        }))
        material.dispose()
      }
      return converted.get(material)
    }

    object.traverse(obj => {
      if (!obj.isMesh) return
      obj.material = Array.isArray(obj.material) ? obj.material.map(convert) : convert(obj.material)
    })
  }
}
