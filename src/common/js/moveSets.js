/**
 * 招式表（moveSet）：依分類分開寫，Fighter 建立時攤平成 fighter.moves[key]（key 不可重複）
 *   normal：地面普通攻擊
 *   air：空中攻擊；填 replaces: '地面招式 key' = 空中按那個鍵時改出這招（沒有 replaces 的空中招式照 key 出）
 *   special：必殺技（還沒有）
 *   super：超必殺（SA），自動加上 isSuper: true（出招時有鏡頭演出、消耗 SG）
 * 每招會自動加上 category（'normal' | 'air' | 'special' | 'super'）
 *
 * 不同人物 / P1、P2 用不同招式：
 *   1. 用 extendMoveSet(BASE_MOVE_SET, { super: { kick_ball: { hitDamage: 5000 }, wind_step: null } }) 做出新的招式表
 *      （同 key 的招式只覆蓋有寫的屬性；寫 null = 拿掉那招；新 key = 新增招式）
 *   2. 傳給 new Fighter({ moveSet })，或在 main.js characters 的人物設定加 moveSet
 *   3. 或繼承：class MyFighter extends Fighter { static moveSet = extendMoveSet(Fighter.moveSet, { ... }) }
 *
 * 招式數據（幀）：總幀數 = 動畫長度；前搖 startup、收招 recovery，中間全部是攻擊判定
 * hitStun：命中後對手的硬直幀數
 * hitstop：命中 / 被防禦時雙方停頓幾幀（頓幀）；沒填用 main.js 的 hitstopFrames；絕招命中一律不頓幀（被防禦照常）
 *   參考：輕拳 6、中拳 7、重拳 8
 * hitShake：命中時被打中的人在頓幀期間搖晃；true = 搖 main.js hitShake.cycles 次，數字 = 搖幾次
 * chainCancel：預約。攻擊判定第 1 幀的前 chainEarly 幀 ~ 攻擊判定最後 1 幀之間，
 *   按任何攻擊鍵 / 絕招鍵 / 衝刺取消鍵都會記住，這招碰到對手（打中或被防禦）才觸發，揮空不觸發：
 *   - 攻擊 / 絕招：收招少 chainCancel 幀，收招結束直接出那一招
 *   - 衝刺取消：碰到對手時觸發
 * chainEarly：見 chainCancel，預設 5
 * chainMirror：命中後，下一次出同一招時鏡像（左右手交換），連續命中就左右輪流
 * knockback：擊退距離（公尺）：被打中 / 被防禦時往後滑多遠（對手背貼牆時改成攻擊方往後退）；空中被普通攻擊打中時是飛走距離
 * hitInterval：多段攻擊，每幾幀算一段，每段最多命中一次；沒填 = 整段只命中一次
 * hitFrames：多段攻擊每段開頭有攻擊判定的幀數，其餘是段與段之間的空檔；沒填 = 整段都有判定
 * hits：手動指定每段的發生幀（1 起算，同幀數表的編號），每段持續 hitFrames 幀；有填時不看 startup / recovery / hitInterval
 *   也可以寫成 [開始, 結束]（含結束幀）個別指定長度，例如 [50, 60]
 *   第一段之前 = 前搖、段與段之間 = 空檔（顯示成前搖）、最後一段結束後 = 收招
 * hitDamage：（絕招）每一擊的通用傷害；沒填用 Combat gaugeRules.superDamage（普通拳的傷害在 Combat gaugeRules.damage）
 * hitDamages：（絕招）每一段個別的傷害，順序同 hits，例如 [800, -1, 1200]；-1 或沒寫到的段 = 用 hitDamage
 * gauge：每一擊的量條增減（點）{ hit: { dg, oppDg, sg, oppSg }, block: { … } }
 *   hit = 擊中、block = 被防禦；dg / sg = 自己、oppDg / oppSg = 對手；負數 = 扣；沒填的欄位 = 0
 * blockStun：被防禦時對手的防禦硬直幀數；沒填用人物的 blockStun
 * hitRadius：攻擊判定球半徑（公尺）；沒填用人物的 hitRadius
 * hitLimb：{ from, to, width, extend } 攻擊判定改成沿著肢體方向的長方體（取代判定球）
 *   從 from 骨頭到 to 骨頭，再往外延伸 extend 公尺；截面寬 width 公尺
 * sounds：招式音效 [{ name, frame, delay }]：name = main.js sounds 的 key；frame = 第幾幀播（幀數表編號，沒填 = 1）；delay = 再延遲幾秒（現實時間）
 *   絕招的第 1 幀 = 按下絕招的瞬間（鏡頭演出開始、畫面定格時）
 * grab：{ from, to, range, distance, stunFrame } 招式第 from ~ to 幀，對手在地面且距離 range 公尺內時把對手吸過來，
 *   保持 distance 公尺；對手進入受擊硬直，受擊動畫播到第 stunFrame 幀停住，直到被打飛或招式結束（無視防禦）
 *   抓取不算命中；之後的攻擊判定照判定球判斷
 * yaw：出招期間人物額外轉幾度（繞 Y 軸，正值 = 從面向方向往左轉）；mirror：出招期間左右鏡像
 * faceCamera：出招期間人物一律面向鏡頭；面向右時鏡像、面向左時照原樣（動畫的側向位移跟著畫面方向）
 * dashThrough：{ from, to, gap, missEnd, lastNoPass } 第 from ~ to 幀快速往前穿過對手，停在對手另一側 gap 公尺（穿越期間不推擠）
 *   lastNoPass：repeatOnHit 最後一次不穿越，衝到對手面前（推擠框貼齊）
 *   lastDistance：repeatOnHit 最後一次改成往前衝固定距離（公尺），不照對手位置
 *   這段沒碰到對手（打中或被防禦）的話，第 to + missEnd 幀後直接結束招式
 * length：招式只用到第幾幀（動畫後面不播）
 * firstPassDelay：repeatOnHit 第一次動畫多播前面幾幀（招式數據照第二次起的幀數，第一次自動往後挪）
 * aimOpponent：自由模式（freeMode.js）放招時朝向對手，而不是自己目前面向的方向
 * repeatOnHit：{ at, times } 打中時，第 at 幀後轉身、從頭再出一次同招，最多出 times 次（最後一次才 launch）
 *   沒打中那次就照 length 結束
 * advance：{ from, to, distance, height } 招式第 from ~ to 幀（幀數表編號，1 起算）平均往前移動 distance 公尺
 *   height：同時往上跳成拋物線，最高 height 公尺，第 to 幀剛好落地（不算空中狀態，被打斷時直接回到地面）
 *   afterFreeze：絕招演出凍結期間（拉近 + 停留）不移動，從鏡頭拉遠（遊戲恢復）的第一幀起到第 to 幀走完 distance
 *   toOpponent：不看 distance，開始移動的那一幀量到對手的距離，一路衝到對手面前（停在 lock.distance，沒有就推擠框貼齊），不限距離
 * invincible：true = 從出招到第一次攻擊判定（含抓取判定）出現前全程無敵；沒填 = 沒有無敵
 * invincibleFrames：這招前幾幀無敵，不會因為攻擊判定開始而提早結束（要比 invincible 更長時才填）
 * rootMotion：攻擊判定期間套用動畫本身的前後位移
 * launch：最後一段命中時把對手打飛（飛走 → 起身）；true = 全照飛走動畫，或填物件 { distance, height, slow, reverse, wallBounce }：
 *   distance：飛多遠（公尺）；沒填 = 照飛走動畫本身的位移
 *   height：額外往上飛成拋物線，最高 height 公尺（腳底離地），飛走動畫第 flyLandFrame 幀落回地面；沒填 = 照動畫
 *   slow：飛走動畫放慢倍率（1.5 = 飛走時間變 1.5 倍、動畫也慢 1.5 倍）；飛行距離 / 高度不變，起身動作照原速；沒填 = 1
 *   reverse：打飛方向反過來（對手先轉身再往後飛）
 *   wallBounce：撞到邊界牆（或兩人最遠距離）時反彈，數字 = 反彈力度（剩下的飛行距離 × 倍率往回飛）；沒填或 0 = 不反彈
 *     例：distance 6、wallBounce 0.75，一開始就貼牆 → 往回飛 6 × 0.75 = 4.5 公尺
 * cameraShake：命中時鏡頭晃動幅度（公尺，參考 0.02 ~ 0.1），被防禦不晃；長度見 main.js cameraShake
 *   絕招沒填 = 每段 main.js cameraShake.superAmplitude（絕招命中不頓幀，改用晃鏡頭）；一般招式沒填 = 不晃
 *   數字 = 每一段都晃；陣列 = 依段數（hits 的順序）個別設定，0 或沒填的段不晃，例：[0, 0.03, 0, 0.08]
 * isSuper：絕招，出招時有鏡頭演出；GUI「招式選取」只列出絕招
 * animStart：絕招從演出的哪個時間點開始播（之前停在第 1 幀，招式幀數也不推進）
 *   'zoomIn' 鏡頭拉近時（預設）/ 'hold' 凍結停留時 / 'zoomOut' 鏡頭拉遠時（遊戲恢復）/ 'after' 鏡頭拉遠後
 *   拉近、停留期間播的部分只是凍結中的動畫（不做命中判定，幀數表畫成綠色虛線）
 * lock：命中後把對手吸附在面前，直到被打飛或招式結束；true = 預設，或填物件 { distance, juggle }：
 *   distance：吸附時對手與攻擊方的距離（公尺，兩人中心）；沒填 = 推擠框剛好貼齊
 *   juggle：{ fromHit, maxFrame, maxHeight, minFrame, minHeight, animHold, animRestart } 吸附中浮空挨打：
 *     fromHit：第幾段攻擊判定（1 起算，同 hits 的順序）打中時開始浮空；之前的段照一般吸附挨打。沒填 = 1
 *     浮空後對手播飛走動畫（x 不飛走），高度跟著飛走動畫的幀數走（腳底離地，公尺）：
 *     動畫第 maxFrame 幀到最高 maxHeight → 第 minFrame 幀落到最低 minHeight → 之後停在 minHeight
 *     之後每下從動畫第 animRestart 幀重播：從當下高度再往上彈到 maxHeight、再落回 minHeight（animRestart ≥ maxFrame 時只往下落）
 *     動畫播到第 animHold 幀停住；最後一下打飛時從空中飛走（launch.height 有填就先往上飛），招式沒打飛就結束時直接落下
 * hitCamera：第 1 段攻擊判定打中（不是被防禦）時，鏡頭拉近到攻擊方後方斜角拍攝，打飛那一下拉回一般鏡頭
 *   true = 用 main.js hitCamera 的預設值；填物件可個別覆蓋：{ angle, height, lookAhead: { x, y }, blendIn, blendOut }（沒填的用預設）
 * heavyHitEffect：命中時用重擊特效（火花較多、噴較遠）；絕招一律是重擊特效
 * holdUntilLand：空中出招時，動畫播完停在最後一幀，直到落地（接落地硬直）才結束；發生後攻擊判定一直持續到落地
 * hitBones：攻擊判定掛在哪些骨頭，沒填用預設的雙手
 * cutSounds：招式被中斷（受擊、被打飛等，不是正常播完）時，這招的音效一起停掉
 * noRearHand：雙手判定時，往前方向（面向）後面那隻手不算攻擊判定（每幀依兩手位置決定）
 * key 要和 main.js anims 的 key 相同（動畫長度 = 總幀數）
 */
export const BASE_MOVE_SET = {
  // 每招依序分組：名稱 / 幀數 / 命中效果 / 傷害與量條 / 移動 / 判定 / 演出與音效
  normal: {
    // startup = 發生幀 - 1（快打的「發生 10F」= 第 10 幀第一次有攻擊判定）
    // Punching_L 是右手出拳
    light: {
      name: '輕攻擊',
      startup: 10, recovery: 11, hitStun: 25, blockStun: 15, hitstop: 6,
      chainCancel: 5, chainMirror: true,
      knockback: 0.125,
      gauge: { hit: { dg: 600, oppDg: 0, sg: 300, oppSg: 100 }, block: { dg: 300, oppDg: -1000, sg: 150, oppSg: 100 } },
      hitBones: ['RightHand'],
    },
    // Punching_M 是右手出拳，手臂約第 16~21 幀伸直（裁掉前 5 幀後）
    medium: {
      name: '中攻擊',
      startup: 15, recovery: 13, hitStun: 30, blockStun: 17, hitstop: 7,
      chainCancel: 5, chainMirror: true,
      hitShake: 1, knockback: 0.35,
      gauge: { hit: { dg: 900, oppDg: 0, sg: 300, oppSg: 100 }, block: { dg: 450, oppDg: -2000, sg: 150, oppSg: 100 } },
      advance: { from: 1, to: 15, distance: 0.2 }, // 前搖期間（第 1 幀 ~ 攻擊判定前）往前 0.1 公尺
      hitBones: ['RightHand'],
    },
    // Punching_H 是左手出拳
    heavy: {
      name: '重攻擊',
      startup: 20, recovery: 15, hitStun: 35, blockStun: 20, hitstop: 8,
      chainCancel: 6, chainMirror: true,
      hitShake: true, heavyHitEffect: true, knockback: 0.6,
      gauge: { hit: { dg: 1200, oppDg: 0, sg: 300, oppSg: 100 }, block: { dg: 600, oppDg: -3000, sg: 150, oppSg: 100 } },
      advance: { from: 1, to: 20, distance: 0.4 }, // 前搖期間（第 1 幀 ~ 攻擊判定前）往前 0.2 公尺
      hitBones: ['LeftHand'],
    },
  },

  air: {
    // 空中重攻擊（MmaKick，20 幀）：第 10 幀發生，攻擊判定持續到落地
    // MmaKick 是左腳踢出、右腳在下；判定是左小腿（膝蓋 → 腳踝再延伸到腳尖）
    airHeavy: {
      name: '空中重攻擊', replaces: 'heavy', // 空中按重拳出這招
      startup: 9, recovery: 0, hitStun: 35, blockStun: 20, hitstop: 8,
      holdUntilLand: true,
      hitShake: true, knockback: 0.3,
      gauge: { hit: { dg: 1200, oppDg: 0, sg: 300, oppSg: 100 }, block: { dg: 600, oppDg: -3000, sg: 150, oppSg: 100 } },
      hitLimb: { from: 'LeftLeg', to: 'LeftFoot', width: 0.25, extend: 0.12 },
    },
  },

  // 必殺技（還沒有）
  special: {},

  // 超必殺（SA）
  super: {
    kick_ball: {
      name: '浪子踢球',
      length: 280, hits: [171], hitFrames: 30, hitStun: 30,
      grab: { from: 44, to: 49, range: 1, distance: 0.6, stunFrame: 10 },
      knockback: 0.5, launch: { distance: 10, height: 1.5, slow: 1.5, wallBounce: 1.5 },
      hitDamage: 4000,
      gauge: { hit: { dg: 0, oppDg: 0, sg: 0, oppSg: 0 }, block: { dg: 0, oppDg: 0, sg: 0, oppSg: 0 } },
      rootMotion: true,
      hitBones: ['LeftFoot', 'RightFoot'],
      sounds: [{ name: 'kick_ball_title', frame: 1 }],
    },
    monkey_turn: {
      name: '猴子繞花線',
      startup: 17, recovery: 40, hitStun: 30,
      knockback: 0.25, launch: true,
      gauge: { hit: { dg: 0, oppDg: 0, sg: 0, oppSg: 0 }, block: { dg: 0, oppDg: 0, sg: 0, oppSg: 0 } },
      rootMotion: true,
    },
    // wind_step：動畫前 60 幀 2 倍速（main.js speedAnims），鏡頭拉遠時才往前跳，第 30 幀落地開始打
    wind_step: {
      name: '風擺柳碎步', aimOpponent: true,
      hits: [30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160, 170], hitFrames: 2, hitStun: 60, blockStun: 30,
      knockback: 0.1, launch: { distance: 3 }, lock: { distance: 0.75 },
      hitDamage: 250,
      gauge: { hit: { dg: 0, oppDg: 0, sg: 0, oppSg: 0 }, block: { dg: 0, oppDg: 0, sg: 0, oppSg: 0 } },
      advance: { from: 1, to: 30, toOpponent: true, height: 0.2, afterFreeze: true },
      animStart: 'hold',
      sounds: [{ name: 'wind_step_title', frame: 1 }],
    },
    dog_bear: {
      name: '狗熊哆嗦毛',
      length: 415, invincible: true, invincibleFrames: 15, // 出招到第一次攻擊判定都無敵（至少 15 幀）
      hits: [15, 65, 108, 151, 196, 238, 284, 325], hitFrames: 10, hitStun: 60, blockStun: 30,
      knockback: 0.1, launch: { distance: 3, height: 3, slow: 1.5 }, lock: { distance: 0.75 },
      gauge: { hit: { dg: 0, oppDg: 0, sg: 0, oppSg: 0 }, block: { dg: 0, oppDg: 0, sg: 0, oppSg: 0 } },
      advance: { from: 1, to: 10, distance: 2 }, rootMotion: true,
      animStart: 'zoomOut',
      cameraShake: [0.03, 0.03, 0.03, 0.03, 0.03, 0.03, 0.03, 0.08],
      sounds: [{ name: 'dog_bear_title', frame: 1 }, { name: 'dog_bear', frame: 5, delay: 0.35 }], cutSounds: true,
    },
    shake_head: {
      name: '搖頭晃腦',
      invincible: true, // 出招到第一次攻擊判定都無敵
      hits: [9, 50, 96, 146, 186, 226, 276, 320, [378, 408]], hitFrames: 10, hitStun: 80, blockStun: 50,
      knockback: 0.1, launch: { distance: 8, wallBounce: 1 },
      lock: { distance: 0.75, juggle: { fromHit: 8, maxFrame: 20, maxHeight: 1, minFrame: 60, minHeight: 0.6, animHold: 60, animRestart: 2 } },
      hitDamage: 400, hitDamages: [-1, -1, -1, -1, -1, -1, -1, -1, 1000], // 最後一下 1000
      gauge: { hit: { dg: 0, oppDg: 0, sg: 0, oppSg: 0 }, block: { dg: 0, oppDg: 0, sg: 0, oppSg: 0 } },
      advance: { from: 2, to: 418, distance: 1.5 },
      hitBones: ['RightHand'], hitRadius: 0.25, // 攻擊判定球放大（預設 0.18）
      animStart: 'zoomOut', faceCamera: true,
      cameraShake: [0.03, 0.03, 0.03, 0.03, 0.03, 0.03, 0.03, 0.05, 0.5],
      hitCamera: { angle: 60, height: 0.2, lookAhead: { x: 0.3, y: -0.3 } },
      sounds: [{ name: 'shake_head_title', frame: 1 }, { name: 'shake_head', frame: 2, delay: 0.35 }], cutSounds: true,
    },
    dodge_step: {
      name: '閃身步',
      length: 40, hits: [[5, 14]], hitStun: 45,
      // lastDamage：最後一次固定這個傷害（不吃 damageCut）；卡片「+1 次」多出來的次數插在最後一次之前
      // damageCut：第 after 次之後、最後一次之前（= 升級多出來的次數）每多一次傷害 -step，最多 -max
      firstPassDelay: 48, repeatOnHit: { at: 30, times: 4, lastDamage: 2000, damageCut: { after: 3, step: 50, max: 300 } },
      knockback: 0, launch: { distance: 4, reverse: true },
      gauge: { hit: { dg: 0, oppDg: 0, sg: 0, oppSg: 0 }, block: { dg: 0, oppDg: 0, sg: 0, oppSg: 0 } },
      dashThrough: { from: 5, to: 14, gap: 0.8, lastDistance: 4 },
      hitBones: ['LeftHand', 'RightHand', 'Spine2'], noRearHand: true,
      faceCamera: true,
      sounds: [{ name: 'dodge_step_title', frame: 1 }],
    },
  },
}

export const MOVE_CATEGORIES = ['normal', 'air', 'special', 'super']

/**
 * 以 base 為底套上 patch，回傳新的招式表（不改動 base）
 * patch 的格式同招式表：{ 分類: { 招式 key: 要覆蓋的屬性 | null } }；null = 拿掉那招
 */
export function extendMoveSet(base, patch = {}) {
  const result = {}
  MOVE_CATEGORIES.forEach(category => {
    const moves = { ...structuredClone(base?.[category] || {}) }
    Object.entries(patch?.[category] || {}).forEach(([key, value]) => {
      if (value === null) delete moves[key]
      else moves[key] = { ...moves[key], ...structuredClone(value) }
    })
    result[category] = moves
  })
  return result
}

/**
 * 招式表 → Fighter 用的 { moves, airMoves }
 *   moves：所有招式攤平（每招各自複製一份，改動不會影響其他人物），加上 category；super 的加上 isSuper
 *   airMoves：地面招式 key → 空中招式 key（來自 air 招式的 replaces）
 */
export function flattenMoveSet(moveSet) {
  const moves = {}
  const airMoves = {}
  MOVE_CATEGORIES.forEach(category => {
    Object.entries(moveSet?.[category] || {}).forEach(([key, move]) => {
      if (moves[key]) console.warn(`招式 key 重複：${key}`)
      moves[key] = { ...structuredClone(move), category, ...(category === 'super' && { isSuper: true }) }
      if (category === 'air' && move.replaces) airMoves[move.replaces] = key
    })
  })
  return { moves, airMoves }
}
