import * as THREE from 'three'
import { KNOCK_DECAY } from './fighter.js'
import { Terrain } from '../../engine/world/terrain.js'

/**
 * FreeMode：自由模式，人物在 3D 場景裡前後左右自由跑動；打架用跟格鬥模式同一套戰鬥流程（combat.js）
 *
 * 移動（自由狀態，由這裡控制）：
 * - 方向以鏡頭為準：P1 W / A / S / D、P2 ↑ / ← / ↓ / →；人物轉向移動方向，播跑步動畫（run）
 * - 碰撞擋牆：往移動方向發射線（高度從腳底算），碰到場景就沿著牆滑開
 * - 地面跟著場景高低（斜坡、台階、平台）：每個畫面從腳底上方 floor.stepUp 往下找場景，人物的 groundY 換成那個高度
 *   比腳底高超過 stepUp 的當成牆（爬不上去，要跳上去）；比腳底低超過 stepDown（走出平台邊緣）就從當下高度落下
 *   跳躍 / 落下時看腳下的場景：落到比起跳處高的平台上就站在上面（Fighter.getFloor）
 *   格鬥模式不受影響（groundY 固定 0）
 * - 卡進模型：每個畫面
 *   1. 穿牆檢查：上一個畫面的位置到現在之間有牆（沒經過碰撞的移動，例如抓技拉過來、招式位移）→ 停在牆前
 *   2. 把人物當成膠囊體推出場景（Terrain.depenetrate）
 *   3. 推了還是卡著、或站在地上卻找不到地板（在空心的模型裡）超過 unstick.time 秒 → 放回最後一個安全位置
 *   安全位置每 unstick.saveEvery 秒記一次：站在地上、沒卡住的位置
 * - 留在場景內：腳下（往前一點）往下沒有場景模型 = 場景邊緣，擋住不能走出去；沒有場景時限制在 |x|、|z| ≤ bounds 的方框內
 * - 推擠框跟著人物走：兩人重疊時各退一半
 *
 * 戰鬥（交給 Combat，空間規則是本檔的 PlaneSpace）：
 * - Fighter 的格鬥邏輯只看 x：每個人有自己的方向 dir（格鬥邏輯的 +x），x 的變化換成沿著 dir 移動，也會被牆擋住
 * - 出招、衝刺取消（0）、跳躍（P1 空白鍵）、衝刺、受擊 / 防禦硬直期間由格鬥邏輯控制，能自由行動且沒有要做的事就交還給自由移動
 * - 出招朝自己面向（移動中 = 移動方向）；這個方向前方 attackAssist.angle 度、attackAssist.range 公尺內有對手時，出招當下自動轉向對手
 * - 被打中的人轉向攻擊方，擊退 / 擊飛沿著攻擊方的方向；被擊飛撞到場景物體就反彈（launch.wallBounce）
 * - 防禦：不用另外按，攻擊打中的那一幀如果正往離開對手的方向移動（跟「朝對手」的夾角 90° 以上）就擋住（防禦動畫、防禦硬直）
 *   平常照常跑，不會因為要防禦而被卡住；GUI「P2 木樁防禦」打開時 P2 原地防禦
 * - 空中操控：跳躍的浮空狀態（state 'air'）按方向鍵，人物轉向那個方向、水平速度往斜跳速度靠近；放開維持當下的速度
 *   空中出招、空中衝刺、被打飛 / 受擊都不受影響
 * - 快跑跳：按著 sprint 鍵跳躍（含空中操控）水平速度 = 快跑速度（runSpeed × sprintRate），沒按 = 一般斜跳速度
 * - 快跑：按著 sprint 鍵（P1 左 Shift、P2 右 Shift）跑步速度 × sprintRate、改播 dashStyle.anim（FastRun），沒有幀數限制
 * - 衝刺取消：移動中按 0 = 往移動方向衝刺取消（同格鬥模式的「前 + 0」）；沒在移動只按 0 沒反應
 *   衝刺方向前方 rushAssist.angle 度、rushAssist.range 公尺內有對手時，衝刺途中一直對準對手，停在對手面前（不會擦邊跨過去）
 *   衝刺取消的動作換成 dashStyle.anim（FastRun）
 * - 絕招沒有鏡頭演出：從動畫開頭直接播，原本演出凍結的幀數另一名角色凍結不動（Combat.freeze）
 * - 坐下（sitDown / standUp，main.js 按 F 時呼叫）：sitAnims.down 倒著播 → sitAnims.idle 循環；再按一次 sitAnims.down 正著播 → 回到自由移動
 *   坐著（含坐下、起身途中）不能移動、出招；被打中就直接中斷
 * - 躲進櫃子（hideIn / leaveHide，main.js 按 F 時呼叫，櫃子見 engine/world/hideSpot.js）：
 *   開門、走到門前、走進去、轉身、關門 → 躲好（isHidden：AI 看不到）；再按一次：開門、走出來、門自己關上
 *   躲藏途中不能移動、出招，也不做卡牆推出；被打中就直接中斷
 * - 環繞鏡頭（main.js 的 H）：isCameraHeld() 為 true 時這裡不動鏡頭
 * - 招式有 aimOpponent（例如風擺柳碎步）：放招時朝向對手；穿越（閃身步）每次穿越開始時對準對手
 *
 * AI：靠視野索敵（aiSight）：面向左右各 angle 度、range 公尺內，而且中間沒有場景擋住，才算看到對手
 *     看到（或剛被打）→ 追過去，離對手 aiFight.engageDistance 內改用格鬥模式的 AI（ai.js，對手換算到自己的方向上）
 *     沒看到超過 memory 秒 → 忘掉，回到隨意走動（撞到東西換方向）；追的路上被牆擋住也會放棄
 *
 * 鏡頭：跟著 P1（N 切換 P1 / P2，注視點平滑移過去），距離不變，滾輪縮放
 *   滑鼠游標隱藏（main.js 鎖定滑鼠），移動滑鼠 = 繞著人物轉鏡頭（addLook）；滑鼠中鍵鎖定對手，再按一次回到一般鏡頭（左 / 右鍵是輕 / 重攻擊，main.js）
 *   進入時平滑轉成俯角 enterPitch 度、距離拉遠成 enterZoom 倍
 *   跟隨的人被攻擊（打中或被防禦）時，鏡頭平滑轉向攻擊方（faceAttacker，hitTurn）；轉的途中移動滑鼠就停止
 * 第一人稱切換（C）：鏡頭 firstPerson.transition 秒平滑移過去；進第一人稱時移到眼睛才把頭藏起來，回第三人稱時頭馬上補回、鏡頭再拉回背後
 * 第一人稱（C，toggleFirstPerson）：鏡頭放在跟隨的人頭的位置（身體照常顯示，只有頭在渲染時縮到看不見），滑鼠轉視角，人物一直面向視角方向
 *   W / S / A / D = 往前跑 / 往後走 / 往左右側走（後走、側走用 walk 動作與 firstPerson 的速度倍率）
 *   只有按著後（S）才算防禦；出招、跳躍、衝刺取消朝視角方向（S 跳 = 往後跳）；鎖定對手時視角轉向對手
 *
 * 擋牆、留在場景內、地板高度、視線都交給 Terrain（engine/world/terrain.js）
 */
export class FreeMode {
  constructor(options) {
    const def = {
      camera: null,
      controls: null,
      combat: null, // 共用的戰鬥流程（combat.js）
      aiThink: null, // (slot, self, opponentInLine) → 格鬥模式 AI 的輸入（main.js 的 FighterAI）
      isStandGuard: null, // (slot) → 一直原地防禦（GUI「P2 木樁防禦」）
      runSpeed: 4, // 跑步速度（公尺 / 秒）
      turnSpeed: 12, // 轉向速度：越大轉越快
      radius: 0.3, // 人物擋牆半徑（公尺）
      rayHeights: [0.4, 1.2], // 擋牆射線的高度（公尺）：膝蓋、胸口
      groundRay: { from: 3, length: 6 }, // 場景邊緣偵測：從腳底上方多高（公尺）往下找地面、找多遠
      // 地面高度：stepUp = 走路能直接踩上去的高度差（從腳底上方這麼高往下找地板），stepDown = 往下超過這個高度差就落下，
      // far = 往下找多遠，cameraSpeed = 鏡頭高度跟上地面高度的快慢
      floor: { stepUp: 0.35, stepDown: 0.4, far: 30, cameraSpeed: 8 },
      ceilingFrom: 0.5, // 找天花板的射線從腳底上方多高開始往上（公尺；在身體裡面，不會打到腳邊的小東西）
      // 卡進模型：depth = 推完還重疊多少（公尺）算卡著、time = 卡著幾秒就放回安全位置、saveEvery = 幾秒記一次安全位置
      unstick: { depth: 0.05, time: 0.3, saveEvery: 0.25 },
      followHeight: 1, // 鏡頭注視點在人物腳底上方多高（公尺）
      switchTime: 0.6, // N 切換跟隨的人：注視點移過去的秒數
      enterPitch: 30, // 進入自由模式時的鏡頭俯角（度）
      enterZoom: 2, // 進入自由模式時鏡頭距離 × 這個倍率（稍微拉遠）
      enterTime: 0.6, // 進入自由模式時鏡頭轉過去的秒數
      lockOnTurnSpeed: 6, // 鎖定對手時鏡頭轉過去的速度：越大越快
      // 鎖定對手、離對手 distance 公尺內：轉向速度 × (距離 / distance)，越近越慢；最慢 minRate 倍（貼身時還是會慢慢跟上）
      lockOnNear: { distance: 5, minRate: 0.15 },
      lookSpeed: 0.0025, // 滑鼠轉鏡頭：每移動 1 像素轉幾弧度
      // 被攻擊時鏡頭轉向攻擊方：speed = 轉向速度（越大越快，每秒靠近剩餘角度的比例），time = 最多轉幾秒
      hitTurn: { speed: 3, time: 1.2 },
      pitchRange: [0.15, 2.6], // 第三人稱鏡頭的垂直角度範圍（弧度，0 = 正上方、π/2 = 水平、超過 = 從下往上看）
      cameraFloorGap: 0.25, // 第三人稱鏡頭最低離地多高（公尺）：往下壓到地面時鏡頭往人物拉近（只影響畫面）
      cameraFloorMinDist: 1.8, // 貼地時最近拉到多近（公尺）；再往下壓就改成視線往上抬（看天空，人物在畫面下方）
      // 第一人稱：鏡頭 = Head 骨頭往上 eyeUp、往視角方向 eyeForward 公尺（沒有 Head 骨頭時用身高 × eyeRate）
      //   maxPitch = 上下最多看幾弧度，startPitch = 打開第一人稱時的視角（度，負數 = 往下看），back / side = 後走、側走的速度倍率（相對跑步）
      //   transition = 切換第一 / 第三人稱時鏡頭移過去的秒數
      //   headHideLead = 切換時鏡頭到位前幾秒就先藏頭（鏡頭最後幾幀已經進到頭裡，晚藏會看到臉的內側閃一下）
      //   deathRise = 倒地不起（死亡動畫）的最後 frames 幀，視角平滑往上抬 deg 度（疊在當下的視角上，停在最後一幀時維持）
      firstPerson: { transition: 0.4, headHideLead: 0.05, deathRise: { frames: 50, deg: 25 }, eyeUp: 0.08, eyeForward: 0.03, eyeRate: 0.93, maxPitch: 1.3, startPitch: -10, back: 0.5, side: 0.7 },
      fps: 60, // 格鬥邏輯的幀率（同 fighter.js）
      overheadRate: 0.8, // 高度差超過身高的這個比例就不推擠（越過頭頂）
      dashStyle: { anim: 'fastRun', speedRate: 2 }, // 自由模式的衝刺：動作、位移倍率（相對格鬥模式）
      // 坐下：down = 起身動作（坐下時倒著播、起身時正著播），idle = 坐著循環
      sitAnims: { down: 'standUp', idle: 'sitIdle' },
      // 躲進櫃子：走路速度（公尺 / 秒）、轉身秒數、進到櫃子裡之後站著的動作（沒有這個動作的人物用 idle）
      hide: { walkSpeed: 1.6, turnTime: 0.35, idleAnim: 'hideIdle' },
      isCameraHeld: null, // () → 鏡頭由別人控制中（例如環繞鏡頭），這裡不動鏡頭
      sprintRate: 2, // 快跑：跑步速度倍率
      jumpSpeedRate: 2, // 自由模式斜跳的水平速度倍率（相對格鬥模式；跳的高度、滯空時間不變）
      // 空中操控（只在跳躍的浮空狀態）：turnSpeed = 轉向速度（弧度 / 秒），accel = 水平速度靠近目標的快慢（越大越快）
      airControl: { turnSpeed: 10, accel: 8 },
      // 出招自動面向對手：出招方向（移動中 = 移動方向，沒在移動 = 面向）左右各 angle 度內、range 公尺內有對手時，出招當下轉向對手
      attackAssist: { angle: 60, range: 3 },
      // 衝刺取消追蹤對手：衝刺開始時對手在衝刺方向左右各 angle 度、range 公尺內 → 衝刺中一直轉向對手，
      // 停在兩人推擠框相貼再隔 gap 公尺的位置（之後的出招打得到）
      rushAssist: { angle: 60, range: 6, gap: 0.1 },
      // 閒置回復：站著 / 走路 / 跑步（沒出招、沒被打、沒在空中）連續 delay 秒後，HP / WL / DG / SG 每秒回復這麼多點，到上限為止
      idleRecover: { delay: 2, hp: 2000, dg: 10000, sg: 3000 },
      // AI 隨意走動：每段跑多久、停多久（秒，範圍內隨機）
      wander: { moveTime: [1, 3], idleTime: [0.5, 2] },
      // AI 打架：看到對手（aiSight）且離對手 engageDistance 公尺內，改用格鬥模式的 AI
      aiFight: { engageDistance: 5 },
      // AI 視野：面向左右各 angle 度、range 公尺內、視線（eyeHeight 高）沒被場景擋住才看得到；看不到 memory 秒後忘掉對手
      aiSight: { angle: 60, range: 15, eyeHeight: 1.4, memory: 2 },
      keys: {
        p1: { forward: 'KeyW', back: 'KeyS', left: 'KeyA', right: 'KeyD', jump: 'Space', sprint: 'ShiftLeft' },
        p2: { forward: 'ArrowUp', back: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', sprint: 'ShiftRight' },
      },
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
    this.isActive = false
    this.fighters = {} // { p1, p2 }
    // slot → { dir（格鬥邏輯的 +x 方向）, localRot（格鬥邏輯裡的轉向）, isEngine（由格鬥邏輯控制）, isJumpHeld, wander }
    this.states = {}
    this.accumulator = 0 // 尚未消化的時間，累積滿 1 幀推進格鬥邏輯
    // 地形查詢：擋牆、場景邊緣、地板高度、視線（沒有場景時限制在 bounds 方框內，見 bounds）
    this.terrain = new Terrain({ radius: this.radius, rayHeights: this.rayHeights, groundRay: this.groundRay, floorRay: { stepUp: this.floor.stepUp, far: this.floor.far } })
    this.followSlot = 'p1' // 鏡頭跟著誰
    this.followBlend = null // 切換跟隨中：{ from（注視點起點）, t（0 ~ 1） }
    this.offsetBlend = null // 進入時的鏡頭轉向：{ from, to（鏡頭相對注視點的位置）, t }
    this.isLockOn = false // 滑鼠中鍵：鏡頭鎖定對手
    this.attackerTurn = null // 被攻擊後轉向攻擊方中：{ other, time }
    this.look = { dx: 0, dy: 0 } // 這個畫面累積的滑鼠移動（像素），_updateCamera 用掉
    this.isFirstPerson = false // C：第一人稱
    // 第一人稱的視角（yaw 同人物 rotation.y、pitch 往上為正）；distance / height = 切回第三人稱時鏡頭的距離與仰角（sin）
    this.fp = { yaw: 0, pitch: 0, distance: 3, height: 0.6 }
    // 第一 / 第三人稱切換中：{ isIn（往第一人稱）, t（0 ~ 1）, fromPos, fromTarget（開始時的鏡頭）, offset（回第三人稱時的目標鏡頭位置，相對注視點）}
    this.fpBlend = null
    this.interpolated = [] // 這個畫面做了補間的人（渲染後還原）
    this.cameraGroundY = 0 // 鏡頭注視點跟著的地面高度（平滑跟上跟隨的人的 groundY）
    this.floorClamp = null // 這個畫面鏡頭被地面擋住、往人物拉近前的位置（渲染後還原）
    this.forward = new THREE.Vector3()
    this.right = new THREE.Vector3()
    this.input = new THREE.Vector3()
    this.step = new THREE.Vector3()
    this.space = new PlaneSpace(this) // 給 Combat 用的空間規則
  }

  // public

  /** 進入自由模式：env = 目前的 3D 場景模型（可為 null） */
  enter(fighters, env) {
    this.isActive = true
    this.fighters = fighters
    this.states = Object.fromEntries(Object.entries(fighters).map(([slot, f]) => [slot, {
      dir: this._getFacingDir(f),
      localRot: Math.PI / 2,
      isEngine: false,
      isJumpHeld: false,
      wander: { dir: new THREE.Vector3(), time: 0, isMoving: false },
      lostTime: Infinity, // AI：多久沒看到對手（秒）；memory 內 = 還記得、會追
      sit: null, // 坐下中：{ phase: 'down' | 'idle' | 'up' }
      hide: null, // 躲櫃子中：{ spot, phase: 'approach' | 'enter' | 'turn' | 'close' | 'hidden' | 'open' | 'exit', t, from }
      safe: null, // 最後一個安全位置：{ pos, groundY }
      safeTimer: 0,
      stuckTime: 0, // 連續卡著幾秒
      lastPos: null, // 上一個畫面的位置（穿牆檢查）
    }]))
    this.accumulator = 0
    this.setEnv(env)
    Object.values(fighters).forEach(f => {
      // 地面高度跟著場景：先站到腳下的地板上，跳躍 / 落下時落在場景上
      f.getFloor = fighter => this.terrain.getFloor(fighter.model.position)
      // 天花板：從上一幀的腳底往上 ceilingFrom 公尺（身體裡面）往上找，跳躍不會穿過天花板
      f.getCeiling = (fighter, fromY) => {
        const pos = fighter.model.position
        return this.terrain.getCeiling(_ceilingFrom.set(pos.x, fighter.groundY + fromY + this.ceilingFrom, pos.z))
      }
      f.groundY = 0
      this._followGround(f, true)
      f.isFreeFacing = true
      f.isGuarding = false
      f.dashStyle = this.dashStyle
      f.jumpSpeedRate = this.jumpSpeedRate
      f.playLoop('idle')
    })

    // 鏡頭：注視點平滑移到 P1，角度轉成俯角 enterPitch、距離拉遠成 enterZoom 倍（水平方向不變）
    this.followSlot = 'p1'
    this.cameraGroundY = fighters.p1.groundY
    this.followBlend = { from: this.controls.target.clone(), t: 0 }
    const offset = this.camera.position.clone().sub(this.controls.target)
    const dist = offset.length() * this.enterZoom
    const flat = offset.clone().setY(0)
    if (flat.lengthSq() < 1e-6) flat.set(0, 0, 1)
    flat.normalize()
    const pitch = THREE.MathUtils.degToRad(this.enterPitch)
    const to = flat.multiplyScalar(dist * Math.cos(pitch)).setY(dist * Math.sin(pitch))
    this.offsetBlend = { from: offset, to, t: 0 }
  }

  exit() {
    if (this.isFirstPerson) this.toggleFirstPerson()
    Object.entries(this.fighters).forEach(([slot, f]) => this._cancelHide(f, this.states[slot]))
    this.fpBlend = null
    Object.values(this.fighters).forEach(f => {
      // 回到格鬥模式：地面 y = 0（main.js 接著 resetAll 讓人物站回地面）
      f.getFloor = null
      f.getCeiling = null
      f.groundY = 0
      f.isFreeFacing = false
      f.dashStyle = null
      f.jumpSpeedRate = 1
    })
    this.isActive = false
    this.isLockOn = false
    this.fighters = {}
    this.states = {}
    this.terrain.setEnv(null)
  }

  /** 換擋牆用的場景（自由模式中切換場景時） */
  setEnv(env) {
    this.terrain.setEnv(env)
  }

  /** 沒有場景時的範圍：|x|、|z| ≤ bounds（公尺）；null = 不限制（main.js 依打鬥場地寬度設定） */
  get bounds() {
    return this.terrain.bounds
  }

  set bounds(value) {
    this.terrain.bounds = value
  }

  /** 滑鼠移動（鎖定滑鼠時，main.js 呼叫）：累積起來，下一次 _updateCamera 轉鏡頭 */
  addLook(dx, dy) {
    if (!this.isActive) return
    this.look.dx += dx
    this.look.dy += dy
  }

  /**
   * N：第一人稱開關
   * 打開：視角 = 目前鏡頭的水平方向，隱藏跟隨的人的模型；關閉：鏡頭回到人物背後（距離、仰角同打開前），模型顯示
   */
  toggleFirstPerson() {
    if (!this.isActive && !this.isFirstPerson) return
    const fighter = this.fighters[this.followSlot]
    this.isFirstPerson = !this.isFirstPerson
    this.offsetBlend = null
    this.followBlend = null
    this.controls.enableZoom = !this.isFirstPerson
    // 從目前畫面上的鏡頭開始平滑移過去（切換到一半又按 C 也從當下的位置接著移）
    const from = { fromPos: this.camera.position.clone(), fromTarget: this.controls.target.clone() }
    if (this.isFirstPerson) {
      // 切換途中再按回來：視角維持原本的（不從中途的鏡頭重新算）
      if (!this.fpBlend) {
        const offset = this.camera.position.clone().sub(this.controls.target)
        const length = offset.length() || 3
        this.fp.distance = length
        this.fp.height = offset.y / length
        this.fp.yaw = Math.atan2(-offset.x, -offset.z) // 看的方向 = 鏡頭 → 注視點
        this.fp.pitch = THREE.MathUtils.degToRad(this.firstPerson.startPitch) // 預設稍微往下看
      }
      this.fpBlend = { isIn: true, t: 0, ...from }
      return
    }
    if (!fighter) return
    // 回到第三人稱：目標是人物背後（視角方向的反方向），距離、仰角同打開前；頭不用等，馬上補回（不再呼叫 _placeFirstPersonCamera）
    const { distance, height } = this.fp
    const flat = Math.sqrt(Math.max(0, 1 - height * height)) * distance
    const offset = new THREE.Vector3(-Math.sin(this.fp.yaw) * flat, height * distance, -Math.cos(this.fp.yaw) * flat)
    this.fpBlend = { isIn: false, t: 0, ...from, offset }
  }

  /**
   * 被攻擊時（main.js 的 onHit，打中或被防禦）：跟隨的人是被打的那個，就讓鏡頭平滑轉向攻擊方
   * 鎖定對手中不用轉（本來就看著）；轉到角度差很小、超過 hitTurn.time 秒或移動滑鼠時停止
   */
  faceAttacker(attacker, target) {
    if (!this.isActive || this.isLockOn || target !== this.fighters[this.followSlot]) return
    this.attackerTurn = { other: attacker, time: this.hitTurn.time }
  }

  /** 滑鼠中鍵：鏡頭鎖定對手（再按一次解除）：鏡頭水平轉到跟隨的人背後，畫面朝向對手 */
  toggleLockOn() {
    this.setLockOn(!this.isLockOn)
  }

  /** 鎖定 / 解除鎖定對手（滑鼠左鍵拖曳轉鏡頭時由 main.js 解除） */
  setLockOn(isOn) {
    if (!this.isActive || this.isLockOn === isOn) return
    this.isLockOn = isOn
    this.offsetBlend = null
  }

  /**
   * C：鏡頭改跟另一個人（注視點平滑移過去，距離、角度不變）
   * 第一人稱：鏡頭從目前的眼睛平滑移到那個人的眼睛（同切換第一人稱的過渡，到了才藏頭），視角換成他面向的方向
   */
  switchFollow() {
    if (!this.isActive) return
    this.followSlot = this.followSlot === 'p1' ? 'p2' : 'p1'
    if (this.isFirstPerson) {
      this.fp.yaw = this.fighters[this.followSlot].model.rotation.y
      this.fpBlend = { isIn: true, t: 0, fromPos: this.camera.position.clone(), fromTarget: this.controls.target.clone() }
      return
    }
    this.followBlend = { from: this.controls.target.clone(), t: 0 }
  }

  /** 是否坐著（含坐下、起身途中） */
  isSitting(slot) {
    return !!this.states[slot]?.sit
  }

  /**
   * 坐下：轉向 lookAt（世界座標，例如營火）後播坐下動作；正在自由移動、能行動時才可以
   * @returns {boolean} 有沒有坐下
   */
  sitDown(slot, lookAt) {
    const fighter = this.fighters[slot]
    const st = this.states[slot]
    if (!this.isActive || !fighter || st.sit || st.isEngine || !fighter.canAct) return false
    if (!fighter.playPose(this.sitAnims.down, { reverse: true, isOnce: true })) return false
    if (lookAt) {
      const to = lookAt.clone().sub(fighter.model.position).setY(0)
      if (to.lengthSq() > 1e-6) fighter.model.rotation.y = Math.atan2(to.x, to.z)
    }
    fighter.model.scale.x = Math.abs(fighter.model.scale.x)
    st.sit = { phase: 'down' }
    return true
  }

  /** 直接把人放到 pos（換場景傳送）：地面高度、防卡住的記錄（上一個位置、安全位置）、補間記錄一起重設 */
  teleport(slot, pos) {
    const fighter = this.fighters[slot]
    const st = this.states[slot]
    if (!fighter || !st) return
    fighter.model.position.copy(pos)
    fighter.groundY = pos.y
    st.lastPos = pos.clone()
    st.safe = { pos: pos.clone(), groundY: pos.y }
    st.stuckTime = 0
    fighter.syncCapturedPosition()
    if (slot === this.followSlot) this.cameraGroundY = pos.y
  }

  /** 起身：坐好之後才可以（坐下途中按無效）；播完回到自由移動 */
  standUp(slot) {
    const st = this.states[slot]
    if (st?.sit?.phase !== 'idle') return false
    this.fighters[slot].playPose(this.sitAnims.down, { isOnce: true })
    st.sit.phase = 'up'
    return true
  }

  /** 是否躲在櫃子裡（含進出途中） */
  isHiding(slot) {
    return !!this.states[slot]?.hide
  }

  /**
   * 躲進櫃子（HideSpot）：開門 → 走到門前 → 走進去 → 轉身面向門外 → 關門；正在自由移動、能行動時才可以
   * @returns {boolean} 有沒有開始躲
   */
  hideIn(slot, spot) {
    const fighter = this.fighters[slot]
    const st = this.states[slot]
    if (!this.isActive || !fighter || st.sit || st.hide || st.isEngine || !fighter.canAct || !spot?.isLoaded) return false
    spot.openDoor()
    st.hide = { spot, phase: 'approach', t: 0, from: null }
    return true
  }

  /** 從櫃子出來：躲好之後才可以（進去途中按無效）；開門 → 走出來 → 交還給自由移動（門自己關上） */
  leaveHide(slot) {
    const st = this.states[slot]
    if (st?.hide?.phase !== 'hidden') return false
    st.hide.spot.openDoor()
    st.hide.phase = 'open'
    return true
  }

  /** Esc：立刻取消所有出拳、招式、吸附、凍結；位置與面向保留，回到站立、交還給自由移動 */
  cancelAll() {
    if (!this.isActive) return
    this.combat.reset()
    Object.entries(this.fighters).forEach(([slot, fighter]) => {
      const model = fighter.model
      const pos = model.position.clone().setY(fighter.groundY) // 站回目前的地面（不是 y = 0）
      const rot = model.rotation.y
      fighter.resetToIdle() // 會把 y、z 歸零、轉回左右：之後還原
      model.position.copy(pos)
      model.rotation.y = rot
      model.scale.x = Math.abs(model.scale.x)
      this.states[slot].isEngine = false
      this.states[slot].sit = null
      this._cancelHide(fighter, this.states[slot])
    })
    this.accumulator = 0
  }

  /**
   * 每個畫面更新：決定誰由格鬥邏輯控制、自由移動、推進格鬥邏輯、推擠，鏡頭跟著人物
   * @param {number} delta 遊戲時間（秒，含遊戲速度、暫停）
   * @param {Set<string>} pressed 按著的鍵（e.code）
   * @param {{ p1: boolean, p2: boolean }} ai 由 AI 操作的人物
   * @param {number} realDelta 真實時間（秒）：鏡頭移動用，暫停時照常
   */
  update(delta, pressed, ai, realDelta = delta) {
    this.camera.getWorldDirection(this.forward).setY(0).normalize()
    this.right.set(-this.forward.z, 0, this.forward.x)

    // 這個畫面的輸入（鍵盤；AI 的在每一幀格鬥邏輯推進前才想）
    const raws = {}
    const before = {} // 自由移動前的位置：算這個畫面的水平速度（走出平台邊緣時延續）
    Object.entries(this.fighters).forEach(([slot, fighter]) => {
      if (this.combat.isFrozenOther(fighter)) return // 對手放絕招的凍結期間：完全不動
      const st = this.states[slot]
      if (!fighter.isAirborne) st.fallSpeed = null // 落地了：走出邊緣的落下結束
      before[slot] = fighter.model.position.clone()
      if (st.sit && !fighter.canAct) st.sit = null // 坐著被打中：中斷坐下，交給格鬥邏輯
      if (st.sit) {
        raws[slot] = this._updateSit(slot, fighter, st, delta)
        return
      }
      if (st.hide && !fighter.canAct) this._cancelHide(fighter, st) // 躲著被打中：中斷，交給格鬥邏輯
      if (st.hide) {
        const yawBefore = fighter.model.rotation.y
        raws[slot] = this._updateHide(slot, fighter, st, delta)
        // 第一人稱：走位、轉身時視角跟著人物一起轉（滑鼠照常可以再轉）
        if (this._isFirstPersonSlot(slot)) this.fp.yaw += fighter.model.rotation.y - yawBefore
        return
      }
      raws[slot] = ai[slot] ? this._prepareAI(fighter, st, delta) : this._preparePlayer(slot, fighter, st, pressed)
      if (!st.isEngine) this._updateFree(slot, fighter, st, pressed, ai, delta)
      else if (!ai[slot] && !this._isFirstPersonSlot(slot)) this._steerAir(fighter, st, this._getInputDir(this.keys[slot], pressed), delta)
      else if (!ai[slot]) this._strafeAir(fighter, st, this._getInputDir(this.keys[slot], pressed), delta)
      if (!fighter.isAirborne) st.airSide = 0 // 第一人稱空中側移的速度：落地清掉
      // 自由移動的水平速度（公尺 / 秒）；格鬥邏輯控制中不算（那時的水平速度在 vx 裡）
      st.moveVel = !st.isEngine && delta > 0 ? fighter.model.position.clone().sub(before[slot]).setY(0).divideScalar(delta) : null
    })

    // 格鬥邏輯：固定每秒 fps 幀
    const step = 1 / this.fps
    this.accumulator += delta
    while (this.accumulator >= step) {
      this.accumulator -= step
      Object.entries(this.fighters).forEach(([slot, fighter]) => {
        const st = this.states[slot]
        if (ai[slot] && st.isEngine && !this.combat.isFrozenOther(fighter)) raws[slot] = this._thinkAI(slot, fighter, st)
        this._aimRush(fighter, st)
      })
      const active = Object.keys(this.fighters).filter(slot => this.states[slot].isEngine)
      if (active.length) {
        this.combat.step(raws, active)
        Object.entries(this.fighters).forEach(([slot, fighter]) => this._stopRushAtOpponent(fighter, this.states[slot]))
        active.forEach(slot => this.fighters[slot].captureFrame()) // 畫面補間：記下這一幀
      }
      // 按一下的輸入只送一次（方向、防禦是按著的，繼續送）
      Object.keys(raws).forEach(slot => {
        if (raws[slot]) raws[slot] = { ...raws[slot], jump: false, dash: 0, attack: null, rush: false }
      })
    }
    this.space.resolvePush(Object.values(this.fighters), {})
    // 地面跟著場景高低（在地上的人）；走出平台邊緣就落下
    Object.entries(this.fighters).forEach(([slot, f]) => this._followGround(f, false, this.states[slot]))
    // 卡進模型就推出來（還是卡著就放回安全位置）；邏輯幀之後的這些移動同步到補間記錄，渲染後才不會被蓋回去
    Object.entries(this.fighters).forEach(([slot, f]) => {
      if (!this.states[slot].hide) this._unstick(f, this.states[slot], delta) // 躲櫃子時位置由走位控制（人在櫃子裡）
      f.syncCapturedPosition()
    })

    this._recoverIdle(delta)

    // 推擠框跟著人物（腳底橢圓、除錯顯示也用它）
    Object.values(this.fighters).forEach(f => {
      f.model.updateMatrixWorld(true)
      f.updateBoxes()
    })

    this._updateCamera(realDelta)
  }

  /**
   * 閒置回復：能自由行動、站在地上（idle / 走 / 跑、坐著、躲櫃子都算；出招、受擊、防禦硬直、空中、死亡不算）連續 idleRecover.delay 秒後
   * HP / WL / DG / SG 慢慢回到上限；一出招或被打就重新計時
   * @param {number} delta 遊戲時間（秒；暫停、主選單時 0）
   */
  _recoverIdle(delta) {
    if (delta <= 0) return
    const { delay, ...rates } = this.idleRecover
    Object.entries(this.fighters).forEach(([slot, fighter]) => {
      const st = this.states[slot]
      const gauge = this.combat.gauges[slot]
      const isIdle = fighter.canAct && fighter.state !== 'guard' && !fighter.isAirborne && !fighter.isDying
      if (!isIdle || !gauge) {
        st.idleTime = 0
        return
      }
      st.idleTime = (st.idleTime || 0) + delta
      if (st.idleTime >= delay) gauge.recover(delta, rates)
    })
  }

  /** 渲染前：格鬥邏輯控制中的人在前後兩幀之間內插（自由移動的人每個畫面直接移動，不用） */
  applyInterpolation(isPaused) {
    const alpha = isPaused ? 1 : this.accumulator * this.fps
    this.interpolated = Object.entries(this.fighters).filter(([slot]) => this.states[slot].isEngine).map(([, f]) => f)
    this.interpolated.forEach(f => f.applyInterpolation(alpha))
    if (this.isFirstPerson) this._placeFirstPersonCamera()
    else this._clampCameraToFloor()
  }

  /**
   * 第三人稱鏡頭往下壓到地面以下（從下往上看）：
   * - 沿著鏡頭 → 注視點的方向往人物拉近，停在地面上方 cameraFloorGap
   * - 拉到 cameraFloorMinDist 還不夠：鏡頭停在地面上這個距離，視線改成往上抬（抬的角度同原本鏡頭往上看的角度）
   * 只影響這個畫面（restoreFrames 還原鏡頭與注視點），鏡頭原本的距離不變，抬回來就恢復
   */
  _clampCameraToFloor() {
    this.floorClamp = null
    const minY = this.cameraGroundY + this.cameraFloorGap
    const pos = this.camera.position
    const target = this.controls.target
    if (pos.y >= minY || target.y <= minY) return
    this.floorClamp = { pos: pos.clone(), target: target.clone() }
    const offset = pos.clone().sub(target)
    const r = offset.length()
    const t = (minY - target.y) / (pos.y - target.y) // 0 ~ 1：從注視點往鏡頭走到這個比例剛好在 minY
    if (r * t >= this.cameraFloorMinDist) {
      pos.lerpVectors(target, this.floorClamp.pos, t)
      return
    }
    // 貼地、離人物 cameraFloorMinDist：水平方向同原本的鏡頭
    const dy = target.y - minY
    const flat = Math.sqrt(Math.max(0, this.cameraFloorMinDist ** 2 - dy * dy))
    const side = offset.setY(0).lengthSq() > 1e-8 ? offset.normalize() : new THREE.Vector3(0, 0, 1)
    pos.set(target.x + side.x * flat, minY, target.z + side.z * flat)
    // 視線往上抬：原本鏡頭看注視點往上的角度（比看人物需要的角度大才抬）
    const wantUp = Math.asin(THREE.MathUtils.clamp((target.y - this.floorClamp.pos.y) / r, -1, 1))
    const up = Math.max(Math.atan2(dy, flat), wantUp)
    const look = new THREE.Vector3(-side.x * Math.cos(up), Math.sin(up), -side.z * Math.cos(up))
    target.copy(pos).addScaledVector(look, r)
  }

  /** 渲染後：還原成邏輯幀的姿勢；第一人稱縮掉的頭還原 */
  restoreFrames() {
    this.interpolated.forEach(f => f.restoreFrame())
    this.interpolated = []
    if (this.floorClamp) {
      this.camera.position.copy(this.floorClamp.pos)
      this.controls.target.copy(this.floorClamp.target)
    }
    this.floorClamp = null
    this.hiddenHead?.setHeadHidden(false)
    this.hiddenHead = null
  }

  /**
   * 第一人稱鏡頭的位置（渲染前、補間之後，鏡頭跟著畫面上的姿勢不會抖）：Head 骨頭往上 eyeUp、往視角方向 eyeForward
   * 跟隨的人的頭縮到看不見，渲染後由 restoreFrames 還原
   */
  _placeFirstPersonCamera() {
    const fighter = this.fighters[this.followSlot]
    if (!fighter) return
    const blend = this.fpBlend?.isIn ? this.fpBlend : null
    const { eyeUp, eyeForward, eyeRate } = this.firstPerson
    const fp = this.fp
    fighter.model.updateMatrixWorld(true)
    const eye = fighter.getHeadPosition()
    if (eye) eye.y += eyeUp
    const pos = eye ?? fighter.model.position.clone().setY(fighter.model.position.y + fighter.characterHeight * eyeRate)
    pos.addScaledVector(this._getYawDir(), eyeForward)
    const pitch = fp.pitch + this._getDeathRise(fighter) // 倒地不起的最後幾幀視角往上抬
    const look = new THREE.Vector3(Math.sin(fp.yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(fp.yaw) * Math.cos(pitch))
    const target = pos.clone().add(look)
    if (blend) {
      // 切換中：從開始時的鏡頭往眼睛移過去；到位前 headHideLead 秒就先藏頭
      const k = smoothStep(blend.t)
      this.camera.position.lerpVectors(blend.fromPos, pos, k)
      this.controls.target.lerpVectors(blend.fromTarget, target, k)
      this.camera.lookAt(this.controls.target)
      const { transition, headHideLead } = this.firstPerson
      const remain = (1 - blend.t) * transition // 還要幾秒到位
      if (blend.t >= 1) this.fpBlend = null
      else if (remain > headHideLead) return
    } else {
      this.camera.position.copy(pos)
      this.controls.target.copy(target)
      this.camera.lookAt(target)
    }
    fighter.setHeadHidden(true)
    this.hiddenHead = fighter
  }

  /**
   * 回第三人稱的過渡：注視點跟著人物（同一般第三人稱），鏡頭從眼睛移到人物背後的目標位置；滑鼠轉的是目標位置
   * 過渡完 fpBlend 清掉，之後照一般第三人稱（鏡頭相對注視點的位置就是目標位置）
   */
  _updateLeaveFirstPerson(fighter, dx, dy, delta) {
    const blend = this.fpBlend
    blend.t = Math.min(1, blend.t + delta / this.firstPerson.transition)
    blend.offset = this._rotateOffset(blend.offset, dx, dy)
    this.cameraGroundY += (fighter.groundY - this.cameraGroundY) * Math.min(1, delta * this.floor.cameraSpeed)
    const aim = fighter.model.position.clone().setY(this.cameraGroundY + this.followHeight)
    const k = smoothStep(blend.t)
    this.camera.position.lerpVectors(blend.fromPos, aim.clone().add(blend.offset), k)
    this.controls.target.lerpVectors(blend.fromTarget, aim, k)
    this.camera.lookAt(this.controls.target)
    if (blend.t >= 1) this.fpBlend = null
  }

  // internal

  /**
   * 玩家這個畫面的輸入，順便決定要不要交給格鬥邏輯（出招、衝刺、跳、防禦、還不能自由行動）
   * 從自由移動切過去時把方向對好：衝刺 → 連按的方向；跳 / 0 / 出招 → 移動方向（沒在移動就是面向）；木樁防禦 → 對手
   * 防禦：正往離開對手的方向移動（夾角 90° 以上）時 isGuarding = true，打中的那一幀由 Combat 判斷成防禦
   */
  _preparePlayer(slot, fighter, st, pressed) {
    const keys = this.keys[slot]
    const pending = this.combat.input[slot]
    const moveDir = this._getInputDir(keys, pressed)
    const other = this._getOpponent(fighter)
    const toOther = other.model.position.clone().sub(fighter.model.position).setY(0)

    const raw = { move: 0 }
    const isFP = this._isFirstPersonSlot(slot)
    const isForwardKey = pressed.has(keys.forward)
    const isBackKey = pressed.has(keys.back) && !isForwardKey
    // 按著快跑鍵：跳躍的水平速度跟快跑一樣（起跳、空中操控都看這個倍率）
    const isSprint = !!keys.sprint && pressed.has(keys.sprint)
    fighter.jumpSpeedRate = isSprint ? (this.runSpeed * this.sprintRate) / fighter.jump.forwardSpeed : this.jumpSpeedRate
    const isJump = !!keys.jump && pressed.has(keys.jump)
    raw.jump = isJump && !st.isJumpHeld
    st.isJumpHeld = isJump
    const isStandGuard = !!this.isStandGuard?.(slot)
    // 第一人稱：只有按著後（S）才算防禦；第三人稱：往離開對手的方向移動
    const isAway = isFP ? isBackKey : !!moveDir && moveDir.dot(toOther) <= 0
    // 防禦姿勢只有木樁防禦（原地）；往後跑的防禦是被打中那一幀才判斷，不改變移動
    raw.guard = isStandGuard || isAway
    raw.standGuard = isStandGuard
    const isAction = !!pending.pendingAttack || pending.rushLife > 0
    // 在空中一定交給格鬥邏輯（落下、落地才會推進）
    const needEngine = !fighter.canAct || fighter.isAirborne || isAction || raw.jump || isStandGuard

    if (needEngine && fighter.canAct) {
      // 出招方向：第一人稱 = 視角方向；第三人稱移動中 = 移動方向，否則 = 面向
      const baseDir = isFP ? this._getYawDir() : moveDir ?? this._getFacingDir(fighter)
      if (isStandGuard) this._aim(fighter, st, toOther)
      else if (pending.pendingAttack && this._isInAssist(baseDir, toOther, other)) this._aim(fighter, st, toOther) // 前方有對手：出招時轉向對手
      else if (!st.isEngine) this._aim(fighter, st, baseDir)
      // 跑步中跳 = 往前跳；第一人稱：W 往前跳、S 往後跳、只按左右 = 原地跳
      if (raw.jump && moveDir) raw.move = isFP ? (isForwardKey ? 1 : isBackKey ? -1 : 0) : 1
    }
    // 移動中按 0：轉向移動方向後當成「前 + 0」（衝刺取消）
    if (moveDir && pending.rushLife > 0) raw.move = 1
    this._setEngine(fighter, st, needEngine)
    // 自由移動中：防禦狀態直接設定（格鬥邏輯控制中的人由 raw.guard 在推進時設定）
    if (!st.isEngine) fighter.isGuarding = raw.guard
    return raw
  }

  /**
   * 出招自動面向：對手在 dir 前方左右各 attackAssist.angle 度內、attackAssist.range 公尺內（水平距離）
   * 對手死亡中不算（不會轉向打不到的人）
   */
  _isInAssist(dir, toOther, other, { angle, range } = this.attackAssist) {
    const dist = toOther.length()
    if (other.isDying || dist > range || dist < 1e-4) return false
    return dir.dot(toOther) / dist >= Math.cos(THREE.MathUtils.degToRad(angle))
  }

  /**
   * 衝刺取消追蹤：衝刺開始的第一幀決定要不要追（對手在衝刺方向前方 rushAssist 範圍內），要追的話衝刺中每幀轉向對手
   * st.rushHome：null = 還沒決定（不在衝刺中時清掉）、true / false = 這次衝刺追 / 不追
   */
  _aimRush(fighter, st) {
    if (!this._isRushMoving(fighter)) {
      st.rushHome = null
      return
    }
    const other = this._getOpponent(fighter)
    const toOther = other.model.position.clone().sub(fighter.model.position).setY(0)
    st.rushHome ??= this._isInAssist(st.dir, toOther, other, this.rushAssist)
    if (st.rushHome && toOther.lengthSq() > 1e-6) this._aim(fighter, st, toOther)
  }

  /** 追蹤中的衝刺：衝到對手面前（推擠框相貼 + gap）就停在那裡，不會衝過頭或擦邊跨過去 */
  _stopRushAtOpponent(fighter, st) {
    if (!st.rushHome || !this._isRushMoving(fighter)) return
    const other = this._getOpponent(fighter)
    const pos = fighter.model.position
    const toOther = other.model.position.clone().sub(pos).setY(0)
    const dist = toOther.length()
    const gap = fighter.pushHalfWidth + other.pushHalfWidth + this.rushAssist.gap
    if (dist >= gap || dist < 1e-4) return
    const stop = other.model.position.clone().addScaledVector(toOther.divideScalar(dist), -gap)
    pos.x = stop.x
    pos.z = stop.z
  }

  /** 衝刺取消中，或衝刺中出招、還在照衝刺速度前進（rushCarryFrames） */
  _isRushMoving(fighter) {
    return fighter.isRushing || (fighter.state === 'attack' && fighter.rushCarryFrames > 0)
  }

  /** AI：離對手 engageDistance 內交給格鬥邏輯（輸入在每一幀推進前由 _thinkAI 決定），遠的時候隨意走動 */
  _prepareAI(fighter, st, delta) {
    const other = this._getOpponent(fighter)
    const dist = other.model.position.clone().sub(fighter.model.position).setY(0).length()
    this._updateSight(fighter, st, delta)
    this._setEngine(fighter, st, !fighter.canAct || fighter.isAirborne || (this._isAware(st) && dist <= this.aiFight.engageDistance))
    return { move: 0 }
  }

  /** AI 視野：看到對手（或正被打 / 防禦中）就記下來，沒看到就累計時間 */
  _updateSight(fighter, st, delta) {
    const isHurt = fighter.state === 'hit' || fighter.state === 'block' || fighter.state === 'down'
    st.lostTime = isHurt || this._canSee(fighter) ? 0 : st.lostTime + delta
  }

  /** 還記得對手（memory 秒內看過） */
  _isAware(st) {
    return st.lostTime <= this.aiSight.memory
  }

  /** 看得到對手：在面向左右各 angle 度、range 公尺內，視線高度往對手發射線沒被場景擋住 */
  _canSee(fighter) {
    const other = this._getOpponent(fighter)
    if (other.isDying || other.isHidden) return false // 躲在櫃子裡看不到
    const { angle, range, eyeHeight } = this.aiSight
    const from = fighter.model.position
    const toOther = other.model.position.clone().sub(from).setY(0)
    const dist = toOther.length()
    if (dist > range) return false
    if (dist > 1e-4 && this._getFacingDir(fighter).dot(toOther) / dist < Math.cos(THREE.MathUtils.degToRad(angle))) return false
    const eye = from.clone()
    eye.y += eyeHeight
    const target = other.model.position.clone()
    target.y += eyeHeight
    return this.terrain.hasLineOfSight(eye, target)
  }

  /** 格鬥模式的 AI：能自由行動時先轉向對手，對手換算到自己的方向上（x = 在自己 +x 上的距離） */
  _thinkAI(slot, fighter, st) {
    const other = this._getOpponent(fighter)
    if (fighter.canAct) {
      const toOther = other.model.position.clone().sub(fighter.model.position).setY(0)
      if (toOther.lengthSq() > 1e-6) this._aim(fighter, st, toOther)
    }
    const localX = this.space.localX(fighter, other)
    const opponentInLine = new Proxy(other, {
      get: (target, prop) => {
        if (prop === 'x') return localX
        const value = Reflect.get(target, prop, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    return this.aiThink?.(slot, fighter, opponentInLine) || { move: 0 }
  }

  /** 切換控制：自由移動 → 格鬥邏輯時補間從現在開始；格鬥邏輯 → 自由移動時清掉防禦、鏡像 */
  _setEngine(fighter, st, isEngine) {
    if (isEngine === st.isEngine) return
    st.isEngine = isEngine
    if (isEngine) {
      fighter.captureFrame()
      fighter.captureFrame()
      return
    }
    fighter.isGuarding = false
    fighter.model.scale.x = Math.abs(fighter.model.scale.x)
  }

  /** 自由狀態：跑、轉向、播動畫；AI 隨意走動 */
  _updateFree(slot, fighter, st, pressed, ai, delta) {
    if (!ai[slot] && this._isFirstPersonSlot(slot)) {
      this._updateFirstPersonMove(slot, fighter, pressed, delta)
      return
    }
    const dir = ai[slot] ? this._getWanderDir(fighter, st, delta) : this._getInputDir(this.keys[slot], pressed)
    const sprintKey = this.keys[slot].sprint
    const isSprint = !ai[slot] && !!dir && !!sprintKey && pressed.has(sprintKey)
    const isMoved = dir ? this._move(fighter, dir, delta, isSprint ? this.sprintRate : 1) : false
    // AI 撞到東西：馬上換個方向繼續走；追對手被擋住就放棄（忘掉對手，之後要再看到才會追）
    if (ai[slot] && dir && !isMoved) {
      if (this._isAware(st)) st.lostTime = Infinity
      this._turnAway(st.wander)
    }
    fighter.playLoop(dir ? this._getRunKey(fighter, isSprint) : 'idle')
    fighter.mixer.update(delta)
    fighter.updateEffects(delta) // 衝刺取消的發光、受擊紅光照時間淡出
  }

  /**
   * 空中操控：跳躍的浮空狀態（state 'air'、跳躍拋物線中）按方向鍵時，格鬥邏輯的 +x（st.dir）轉向輸入方向，
   * 水平速度 vx 往斜跳速度靠近；沒按方向鍵就不變（原地跳維持原地、斜跳維持原本的速度）
   * 走出平台邊緣的落下（st.fallSpeed）也可以操控，速度往走出去時的速度靠近
   */
  _steerAir(fighter, st, dir, delta) {
    const isWalkOff = st.fallSpeed != null
    if (!dir || fighter.state !== 'air' || !(fighter.isJumpArc || isWalkOff) || delta <= 0) return
    const { turnSpeed, accel } = this.airControl
    // 方向：從目前的 st.dir 往輸入方向轉，每秒最多 turnSpeed 弧度
    const from = Math.atan2(st.dir.x, st.dir.z)
    const diff = Math.atan2(Math.sin(Math.atan2(dir.x, dir.z) - from), Math.cos(Math.atan2(dir.x, dir.z) - from))
    const angle = from + Math.sign(diff) * Math.min(Math.abs(diff), turnSpeed * delta)
    this._aim(fighter, st, new THREE.Vector3(Math.sin(angle), 0, Math.cos(angle)))
    // 速度：格鬥邏輯裡人物面向 +x，往前 = 正的 vx
    const speed = isWalkOff ? st.fallSpeed : fighter.jump.forwardSpeed * fighter.jumpSpeedRate
    fighter.vx += (speed - fighter.vx) * (1 - Math.exp(-accel * delta))
  }

  /**
   * 第一人稱空中側移：跳躍 / 落下的滯空中（state 'air'），按鍵方向在「面向的左右」上的分量 → 側移速度
   * 往 runSpeed × firstPerson.side 靠近（airControl.accel），放開維持當下的速度；前後照格鬥邏輯的 vx（往前跳 / 往後跳）
   * 會被牆擋住；身體方向（st.dir）不變，視角照常由滑鼠控制
   */
  _strafeAir(fighter, st, dir, delta) {
    if (fighter.state !== 'air' || !fighter.isAirborne || delta <= 0) return
    const side = this.step.set(-st.dir.z, 0, st.dir.x) // 面向的左右（哪一邊都可以，方向由分量的正負決定）
    if (dir) {
      const goal = dir.dot(side) * this.runSpeed * this.firstPerson.side
      st.airSide = (st.airSide || 0) + (goal - (st.airSide || 0)) * (1 - Math.exp(-this.airControl.accel * delta))
    }
    if (!st.airSide || Math.abs(st.airSide) < 1e-3) return
    const step = this.terrain.collide(fighter.model.position, side.multiplyScalar(st.airSide * delta))
    fighter.model.position.add(step)
  }

  /**
   * 躲櫃子中（每個畫面）：不能移動、出招；依階段走位、轉身，等門開好 / 關好
   * approach 走到門前 → enter 走進去 → turn 轉身面向門外 → close 關門 → hidden 躲好；open 開門 → exit 走出來 → 結束
   */
  _updateHide(slot, fighter, st, delta) {
    const pending = this.combat.input[slot]
    pending.pendingAttack = null
    pending.rushLife = 0
    fighter.isGuarding = false
    const h = st.hide
    const spot = h.spot
    const pos = fighter.model.position
    const { walkSpeed, turnTime } = this.hide
    const outYaw = Math.atan2(spot.frontDir.x, spot.frontDir.z) // 面向門外
    // 進到櫃子裡（轉身、關門、躲著、等開門）站著用 hide.idleAnim，門外等門開用一般 idle；走路時下面換成 walk
    const isInside = ['turn', 'close', 'hidden', 'open'].includes(h.phase)
    let anim = isInside && fighter.actions[this.hide.idleAnim] ? this.hide.idleAnim : 'idle'
    // 往 goal 走：面向走的方向，到了回傳 true
    const walkTo = (goal, faceYaw = null) => {
      const to = goal.clone().sub(pos).setY(0)
      const dist = to.length()
      const step = walkSpeed * delta
      if (dist <= step || dist < 1e-3) {
        pos.x = goal.x
        pos.z = goal.z
        return true
      }
      pos.addScaledVector(to.divideScalar(dist), step)
      fighter.model.rotation.y = faceYaw ?? Math.atan2(to.x, to.z)
      anim = 'walk'
      return false
    }

    if (h.phase === 'approach') {
      if (walkTo(spot.frontPoint)) h.phase = 'enter'
    } else if (h.phase === 'enter') {
      // 門開好才走進去
      if (spot.isDoorOpen && walkTo(spot.insidePoint)) {
        h.phase = 'turn'
        h.t = 0
        h.from = fighter.model.rotation.y
      }
    } else if (h.phase === 'turn') {
      h.t = Math.min(1, h.t + delta / turnTime)
      const diff = Math.atan2(Math.sin(outYaw - h.from), Math.cos(outYaw - h.from))
      fighter.model.rotation.y = h.from + diff * h.t
      if (h.t >= 1) {
        spot.closeDoor()
        h.phase = 'close'
      }
    } else if (h.phase === 'close') {
      if (spot.isDoorClosed) {
        h.phase = 'hidden'
        fighter.isHidden = true
      }
    } else if (h.phase === 'open') {
      fighter.isHidden = false
      if (spot.isDoorOpen) h.phase = 'exit'
    } else if (h.phase === 'exit') {
      if (walkTo(spot.frontPoint, outYaw)) {
        spot.closeDoor()
        st.hide = null
      }
    }
    fighter.model.scale.x = Math.abs(fighter.model.scale.x)
    fighter.playLoop(anim)
    fighter.mixer.update(delta)
    fighter.updateEffects(delta)
    return { move: 0 }
  }

  /** 躲藏中斷（被打中、Esc、離開自由模式）：看得到了，門關上 */
  _cancelHide(fighter, st) {
    if (!st.hide) return
    st.hide.spot.closeDoor()
    st.hide = null
    fighter.isHidden = false
  }

  /** 坐下中：不能移動、出招（按的鍵丟掉）；坐下 / 起身的動作播完才換下一段 */
  _updateSit(slot, fighter, st, delta) {
    const pending = this.combat.input[slot]
    pending.pendingAttack = null
    pending.rushLife = 0
    fighter.isGuarding = false
    fighter.mixer.update(delta)
    fighter.updateEffects(delta)
    if (st.sit.phase === 'down' && fighter.isPoseDone) {
      fighter.playPose(this.sitAnims.idle)
      st.sit.phase = 'idle'
    } else if (st.sit.phase === 'up' && fighter.isPoseDone) {
      st.sit = null
      fighter.playLoop('idle')
    }
    return { move: 0 }
  }

  /** 這個人是第一人稱操作中（鏡頭跟著他、第一人稱打開） */
  _isFirstPersonSlot(slot) {
    return this.isFirstPerson && slot === this.followSlot
  }

  /** 第一人稱視角的水平方向 */
  _getYawDir(target = new THREE.Vector3()) {
    return target.set(Math.sin(this.fp.yaw), 0, Math.cos(this.fp.yaw))
  }

  /** 第一人稱的自由移動：人物一直面向視角，W 往前跑（Shift 快跑）、S 往後走、A / D 側走；方向鍵以視角為準（_getInputDir） */
  _updateFirstPersonMove(slot, fighter, pressed, delta) {
    const keys = this.keys[slot]
    const model = fighter.model
    model.rotation.y = this.fp.yaw
    model.scale.x = Math.abs(model.scale.x)
    const dir = this._getInputDir(keys, pressed)
    let anim = 'idle'
    if (dir) {
      const forward = dir.dot(this._getYawDir())
      const isSprint = forward > 0.5 && !!keys.sprint && pressed.has(keys.sprint)
      const { back, side } = this.firstPerson
      const rate = forward > 0.5 ? (isSprint ? this.sprintRate : 1) : forward < -0.5 ? back : side
      const step = this.terrain.collide(model.position, this.step.copy(dir).multiplyScalar(this.runSpeed * rate * delta))
      model.position.add(step)
      anim = forward > 0.5 ? this._getRunKey(fighter, isSprint) : forward < -0.5 ? 'walkBack' : 'walk'
    }
    fighter.playLoop(anim)
    fighter.mixer.update(delta)
    fighter.updateEffects(delta)
  }

  /** 人物目前面向（世界方向） */
  _getFacingDir(fighter, target = new THREE.Vector3()) {
    const rot = fighter.model.rotation.y
    return target.set(Math.sin(rot), 0, Math.cos(rot))
  }

  /** 把格鬥邏輯的 +x 對準 dir，人物面向 +x */
  _aim(fighter, st, dir) {
    st.dir.copy(dir).setY(0).normalize()
    this._runLocal(fighter, st, () => {
      fighter.faceRight = true
      fighter.refreshFacing()
    }, false)
  }

  /**
   * 在格鬥邏輯的座標裡執行 fn：人物的轉向先換回格鬥邏輯裡的值（+x = st.dir）
   * 執行完把 x 的變化量換成沿著 st.dir 移動（isCollide：會被牆擋住），轉向換成世界方向
   * @returns {boolean} 這次移動有沒有被牆擋住
   */
  _runLocal(fighter, st, fn, isCollide = true) {
    const model = fighter.model
    const x0 = model.position.x
    model.rotation.y = st.localRot
    fn()
    st.localRot = model.rotation.y
    const dx = model.position.x - x0
    model.position.x = x0
    model.rotation.y = Math.atan2(st.dir.x, st.dir.z) + st.localRot - Math.PI / 2
    if (!dx) return false

    const step = st.dir.clone().multiplyScalar(dx)
    const length = step.length()
    if (isCollide) this.terrain.collide(model.position, step)
    model.position.add(step)
    return step.length() < length - 1e-6
  }

  /**
   * 鏡頭：注視點 = 跟隨的人腳底上方 followHeight（跳躍不跟著上下），鏡頭保持相對注視點的位置（滑鼠轉動 / 縮放照常）
   * 切換跟隨、剛進入時平滑過渡；鎖定對手時水平轉到跟隨的人背後
   */
  _updateCamera(delta) {
    const smooth = t => t * t * (3 - 2 * t)
    const fighter = this.fighters[this.followSlot]
    // 鏡頭由別人控制中（環繞鏡頭）：滑鼠的移動丟掉，鏡頭不動
    if (this.isCameraHeld?.()) {
      this.look.dx = 0
      this.look.dy = 0
      return
    }
    const { dx, dy } = this.look
    this.look.dx = 0
    this.look.dy = 0
    // 被攻擊後的轉向：移動滑鼠、時間到就停止
    const turn = this.attackerTurn
    if (turn && (Math.abs(dx) > 2 || (turn.time -= delta) <= 0)) this.attackerTurn = null
    if (this.isFirstPerson) {
      if (this.fpBlend?.isIn) this.fpBlend.t = Math.min(1, this.fpBlend.t + delta / this.firstPerson.transition)
      this._updateFirstPersonCamera(fighter, dx, dy, delta)
      return
    }
    if (this.fpBlend) {
      this._updateLeaveFirstPerson(fighter, dx, dy, delta)
      return
    }
    // 注視點高度跟著地面（平滑跟上，台階不會跳一下；跳躍不跟）
    this.cameraGroundY += (fighter.groundY - this.cameraGroundY) * Math.min(1, delta * this.floor.cameraSpeed)
    const aim = fighter.model.position.clone().setY(this.cameraGroundY + this.followHeight)
    let offset = this.camera.position.clone().sub(this.controls.target)

    const ob = this.offsetBlend
    if (ob) {
      ob.t = Math.min(1, ob.t + delta / this.enterTime)
      const k = smooth(ob.t)
      const length = THREE.MathUtils.lerp(ob.from.length(), ob.to.length(), k)
      offset = ob.from.clone().lerp(ob.to, k).setLength(length)
      if (ob.t >= 1) this.offsetBlend = null
    } else {
      if (this.isLockOn) offset = this._getLockOnOffset(fighter, offset, delta)
      else if (this.attackerTurn) offset = this._getLockOnOffset(fighter, offset, delta, this.attackerTurn.other, this.hitTurn.speed)
      offset = this._rotateOffset(offset, this.isLockOn ? 0 : dx, dy) // 滑鼠轉鏡頭（鎖定對手時只能上下）
    }

    const fb = this.followBlend
    if (fb) {
      fb.t = Math.min(1, fb.t + delta / this.switchTime)
      aim.lerpVectors(fb.from, aim, smooth(fb.t))
      if (fb.t >= 1) this.followBlend = null
    }
    this.controls.target.copy(aim)
    this.camera.position.copy(aim).add(offset)
  }

  /** 滑鼠轉鏡頭：繞注視點水平轉 dx、上下轉 dy（像素），垂直角度限制在 pitchRange */
  _rotateOffset(offset, dx, dy) {
    if (!dx && !dy) return offset
    const sph = new THREE.Spherical().setFromVector3(offset)
    sph.theta -= dx * this.lookSpeed
    sph.phi = THREE.MathUtils.clamp(sph.phi - dy * this.lookSpeed, ...this.pitchRange)
    return new THREE.Vector3().setFromSpherical(sph)
  }

  /** 第一人稱視角：滑鼠轉視角；鎖定對手時水平轉向對手（鏡頭位置在渲染前由 _placeFirstPersonCamera 放） */
  _updateFirstPersonCamera(fighter, dx, dy, delta) {
    const fp = this.fp
    const { maxPitch } = this.firstPerson
    if (this.isLockOn || this.attackerTurn) {
      const other = this.isLockOn ? this._getOpponent(fighter) : this.attackerTurn.other
      const to = other.model.position.clone().sub(fighter.model.position)
      const speed = this.isLockOn ? this.lockOnTurnSpeed * this._getLockOnNearRate(to) : this.hitTurn.speed
      const goal = Math.atan2(to.x, to.z)
      const diff = Math.atan2(Math.sin(goal - fp.yaw), Math.cos(goal - fp.yaw))
      fp.yaw += diff * Math.min(1, delta * speed)
      if (!this.isLockOn && Math.abs(diff) < 0.02) this.attackerTurn = null
    } else {
      fp.yaw -= dx * this.lookSpeed
    }
    fp.pitch = THREE.MathUtils.clamp(fp.pitch - dy * this.lookSpeed, -maxPitch, maxPitch)
  }

  /**
   * 倒地不起（死亡動畫）的視角抬升（弧度）：最後 deathRise.frames 幀從 0 平滑加到 deathRise.deg，停在最後一幀時維持
   * 依動畫播到第幾幀直接算（不是每幀累加，畫面更新率怎麼變都一樣），疊在 fp.pitch 上、不改它
   */
  _getDeathRise(fighter) {
    if (!fighter.isDying) return 0
    const { frames, deg } = this.firstPerson.deathRise
    const left = fighter.stateLength - 1 - fighter.stateFrame // 離最後一幀還有幾幀
    const t = THREE.MathUtils.clamp(1 - left / frames, 0, 1)
    return THREE.MathUtils.degToRad(deg) * smoothStep(t)
  }

  /**
   * 鎖定對手的鏡頭位置：只轉水平方向，轉到跟隨的人背後（對手 → 自己的方向）
   * 高度（俯角）與距離維持目前的值，滑鼠上下轉動、縮放照常；從目前方向慢慢轉過去，兩人重疊時不轉
   */
  _getLockOnOffset(fighter, offset, delta, other = this._getOpponent(fighter), speed = this.lockOnTurnSpeed) {
    const back = fighter.model.position.clone().sub(other.model.position).setY(0)
    const flat = Math.hypot(offset.x, offset.z)
    if (back.lengthSq() < 1e-4 || flat < 1e-4) return offset
    const from = Math.atan2(offset.x, offset.z)
    const goal = Math.atan2(back.x, back.z)
    const diff = Math.atan2(Math.sin(goal - from), Math.cos(goal - from))
    if (!this.isLockOn && Math.abs(diff) < 0.02) this.attackerTurn = null // 被攻擊後的轉向：轉到了
    if (this.isLockOn) speed *= this._getLockOnNearRate(back)
    const angle = from + diff * Math.min(1, delta * speed)
    return new THREE.Vector3(Math.sin(angle) * flat, offset.y, Math.cos(angle) * flat)
  }

  /** 鎖定對手的轉向速度倍率：離對手 lockOnNear.distance 公尺外 = 1，以內越近越慢（最慢 minRate）；toOther = 兩人之間的向量 */
  _getLockOnNearRate(toOther) {
    const { distance, minRate } = this.lockOnNear
    const dist = Math.hypot(toOther.x, toOther.z)
    return THREE.MathUtils.clamp(dist / distance, minRate, 1)
  }

  _getOpponent(fighter) {
    return Object.values(this.fighters).find(f => f !== fighter)
  }

  _getState(fighter) {
    const slot = Object.keys(this.fighters).find(k => this.fighters[k] === fighter)
    return this.states[slot]
  }

  /** 按鍵方向（以鏡頭為準）；沒按 = null */
  _getInputDir(keys, pressed) {
    const input = this.input.set(0, 0, 0)
    if (pressed.has(keys.forward)) input.add(this.forward)
    if (pressed.has(keys.back)) input.sub(this.forward)
    if (pressed.has(keys.right)) input.add(this.right)
    if (pressed.has(keys.left)) input.sub(this.right)
    return input.lengthSq() ? input.clone().normalize() : null
  }

  /**
   * AI 走動：記得對手（視野內看過）→ 一直朝對手當下的位置跑；否則跑一段、停一段，輪流（停 = null），每段隨機方向
   */
  _getWanderDir(fighter, st, delta) {
    const wander = st.wander
    const toOther = this._getOpponent(fighter).model.position.clone().sub(fighter.model.position).setY(0)
    if (this._isAware(st) && toOther.lengthSq() > 1e-6) return wander.dir.copy(toOther).normalize()
    wander.time -= delta
    if (wander.time <= 0) {
      wander.isMoving = !wander.isMoving
      const [min, max] = wander.isMoving ? this.wander.moveTime : this.wander.idleTime
      wander.time = THREE.MathUtils.randFloat(min, max)
      if (wander.isMoving) {
        const angle = Math.random() * Math.PI * 2
        wander.dir.set(Math.sin(angle), 0, Math.cos(angle))
      }
    }
    return wander.isMoving ? wander.dir : null
  }

  /** AI 撞到東西：轉 90° ~ 270° 換個方向繼續跑 */
  _turnAway(wander) {
    const angle = Math.atan2(wander.dir.x, wander.dir.z) + THREE.MathUtils.randFloat(Math.PI / 2, Math.PI * 1.5)
    wander.dir.set(Math.sin(angle), 0, Math.cos(angle))
    wander.isMoving = true
    wander.time = THREE.MathUtils.randFloat(...this.wander.moveTime)
  }

  /** 沒有跑步動畫的人物用走路代替 */
  _getRunKey(fighter, isSprint = false) {
    if (isSprint && fighter.actions[this.dashStyle.anim]) return this.dashStyle.anim
    return fighter.actions.run ? 'run' : 'walk'
  }

  /** 轉向並往 dir 跑一步；回傳是否有移動（整個被牆擋住 = false） */
  _move(fighter, dir, delta, speedRate = 1) {
    // 轉向移動方向（Mixamo 人物預設面向 +Z）：最短角度慢慢轉過去
    const model = fighter.model
    const goal = Math.atan2(dir.x, dir.z)
    const diff = Math.atan2(Math.sin(goal - model.rotation.y), Math.cos(goal - model.rotation.y))
    model.rotation.y += diff * Math.min(1, delta * this.turnSpeed)
    model.scale.x = Math.abs(model.scale.x)

    const step = this.terrain.collide(model.position, this.step.copy(dir).multiplyScalar(this.runSpeed * speedRate * delta))
    model.position.add(step)
    return step.lengthSq() > 0
  }

  /**
   * 卡進模型：膠囊體推出；推完還卡著（重疊超過 unstick.depth）連續 unstick.time 秒 → 放回最後一個安全位置
   * 沒卡著而且站在地上時，每 unstick.saveEvery 秒記一次安全位置
   */
  _unstick(fighter, st, delta) {
    const pos = fighter.model.position
    const terrain = this.terrain
    // 1. 穿牆：上一個畫面的位置 → 現在，中間有牆就停在牆前（擋牆半徑外）
    if (st.lastPos) {
      const move = pos.clone().sub(st.lastPos).setY(0)
      const length = move.length()
      const hit = length > 1e-4 ? terrain.castWall(st.lastPos, move) : null
      if (hit && hit.distance < length) {
        const allowed = Math.max(0, hit.distance - terrain.radius)
        pos.x = st.lastPos.x + (move.x / length) * allowed
        pos.z = st.lastPos.z + (move.z / length) * allowed
      }
    }
    // 2. 膠囊體推出
    const { depth } = terrain.depenetrate(pos, { height: fighter.characterHeight })
    // 3. 還是卡著，或站在地上卻找不到地板（空心的模型裡面）
    const isLost = !!terrain.env && !fighter.isAirborne && terrain.getFloor(pos.clone().setY(fighter.groundY)) == null
    const { depth: maxDepth, time, saveEvery } = this.unstick
    if (depth > maxDepth || isLost) {
      st.stuckTime += delta
      st.lastPos = pos.clone()
      if (st.stuckTime < time || !st.safe) return
      // 放回安全位置：站在那個地面上（空中的話從那裡往下落）
      pos.copy(st.safe.pos)
      fighter.groundY = st.safe.groundY
      st.stuckTime = 0
      st.lastPos = pos.clone()
      return
    }
    st.lastPos = pos.clone()
    st.stuckTime = 0
    st.safeTimer -= delta
    if (fighter.isAirborne || st.safeTimer > 0) return
    st.safe = { pos: pos.clone().setY(fighter.groundY), groundY: fighter.groundY }
    st.safeTimer = saveEvery
  }

  /**
   * 在地上的人：groundY 換成腳下地板的高度（離地高度 y 不變，例如被吸附浮空中）
   * 地板低了超過 stepDown（走出平台邊緣）→ 從當下高度落下；isSnap = 直接站上去（進入自由模式時）
   * 自由移動中走出邊緣：延續走路 / 跑步的水平速度（轉向移動方向，vx = 速度），落下途中可以用方向鍵操控（_steerAir）
   */
  _followGround(fighter, isSnap = false, st = null) {
    if (fighter.isAirborne) return
    const pos = fighter.model.position.clone().setY(fighter.groundY)
    const floor = this.terrain.getFloor(pos)
    if (floor == null) return
    if (!isSnap && floor < fighter.groundY - this.floor.stepDown) {
      const isFree = fighter.canAct
      fighter.startFall()
      const vel = st?.moveVel
      const speed = vel ? vel.length() : 0
      if (isFree && speed > 0.1) {
        this._aim(fighter, st, vel)
        fighter.vx = speed
        st.fallSpeed = speed
      }
      return
    }
    const y = fighter.y
    fighter.groundY = floor
    fighter.y = y
  }
}

const _ceilingFrom = new THREE.Vector3()

/** 先慢、中間快、再慢 */
function smoothStep(t) {
  return t * t * (3 - 2 * t)
}

/**
 * PlaneSpace：自由模式給 Combat 用的空間規則（介面見 combat.js）
 * 每個人的格鬥邏輯 +x = FreeMode 的 state.dir；位置在 x、z 平面上，擋牆、留在場景內都照 FreeMode 的碰撞
 */
class PlaneSpace {
  constructor(freeMode) {
    this.fm = freeMode
    this.noWall = Infinity
  }

  run(fighter, fn, isCollide = true) {
    return this.fm._runLocal(fighter, this.fm._getState(fighter), fn, isCollide)
  }

  forward(fighter) {
    return this.fm._getState(fighter).dir.clone().multiplyScalar(fighter.faceRight ? 1 : -1)
  }

  /** other 在 fighter 格鬥邏輯座標裡的 x：投影到 fighter 的 +x（dir）上 */
  localX(fighter, other) {
    const dir = this.fm._getState(fighter).dir
    return fighter.x + other.model.position.clone().sub(fighter.model.position).dot(dir)
  }

  /** 被打 / 被抓：交給格鬥邏輯，+x 對準攻擊方（面向攻擊方），擊退往 -x = 沿著攻擊方的正前方 */
  prepareTarget(target, attacker) {
    const st = this.fm._getState(target)
    this.fm._setEngine(target, st, true)
    this.fm._aim(target, st, this.forward(attacker).negate())
  }

  aimAt(fighter, other) {
    const to = other.model.position.clone().sub(fighter.model.position).setY(0)
    if (to.lengthSq() > 1e-6) this.fm._aim(fighter, this.fm._getState(fighter), to)
  }

  moveBy(fighter, step) {
    fighter.model.position.add(this.fm.terrain.collide(fighter.model.position, step))
  }

  clampPassEnd() {}

  /** 絕招：招式有 aimOpponent 時朝向對手，其餘維持自己的方向 */
  faceForSuper(fighter, opponent, key) {
    if (fighter.moves[key]?.aimOpponent) this.aimAt(fighter, opponent)
  }

  faceOpponents() {
    return false
  }

  /** 絕招凍結期間：放招的人推進碰到對手就停在對手外面（對手不動） */
  stopAtOpponent(fighter, opp) {
    this._push(fighter, opp, 1)
  }

  /** 推擠：推擠框（圓）重疊時各退一半；對手放絕招凍結中由放招的人全退；穿越中、吸附中、越過頭頂不推 */
  resolvePush([a, b]) {
    if (!a || !b || this.fm.combat.lock) return
    const combat = this.fm.combat
    const rateA = combat.isFrozenOther(a) ? 0 : combat.isFrozenOther(b) ? 1 : 0.5
    this._push(a, b, rateA)
  }

  checkWallBounce() {}

  /**
   * 對手背後撞到場景物體、擊退退不完：剩下的距離改成攻擊方往後退（同格鬥模式的牆角推回）
   * 擊退方向 = 攻擊方 → 對手（水平）；距離同格鬥模式：站著受擊 = knockVelocity / KNOCK_DECAY，追打飛走中 = 招式的 knockback
   */
  cornerPush(attacker, target, move) {
    let distance = 0
    if (target.knockVelocity) distance = Math.abs(target.knockVelocity) / KNOCK_DECAY
    else if (target.state === 'down' && move?.knockback) distance = Math.abs(move.knockback)
    if (!distance) return
    const dir = target.model.position.clone().sub(attacker.model.position).setY(0)
    if (dir.lengthSq() < 1e-8) return
    dir.normalize()
    const fm = this.fm
    const hit = fm.terrain.castWall(target.model.position, dir.clone().multiplyScalar(distance))
    const room = hit ? Math.max(0, hit.distance - fm.terrain.radius) : distance
    if (distance <= room) return
    // 攻擊方的格鬥邏輯 +x = 自己的 st.dir：往「離開對手」的方向退
    const st = fm.states[Object.keys(fm.fighters).find(slot => fm.fighters[slot] === attacker)]
    const side = st ? Math.sign(st.dir.dot(dir)) || 1 : 1
    attacker.pushVelocity = -side * (distance - room) * KNOCK_DECAY
  }

  /** a、b 重疊時分開：a 退 rateA、b 退其餘（都會擋牆） */
  _push(a, b, rateA) {
    if (a.isPassing || b.isPassing) return
    if (Math.abs(a.model.position.y - b.model.position.y) > a.characterHeight * this.fm.overheadRate) return // 世界高度差（含地面高低）
    const delta = b.model.position.clone().sub(a.model.position).setY(0)
    const dist = delta.length()
    const min = a.pushHalfWidth + b.pushHalfWidth
    if (dist >= min) return
    const normal = dist > 1e-4 ? delta.divideScalar(dist) : this.fm._getFacingDir(a)
    const overlap = min - dist
    a.model.position.add(this.fm.terrain.collide(a.model.position, normal.clone().multiplyScalar(-overlap * rateA)))
    b.model.position.add(this.fm.terrain.collide(b.model.position, normal.clone().multiplyScalar(overlap * (1 - rateA))))
  }
}
