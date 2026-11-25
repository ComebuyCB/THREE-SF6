/**
 * 招式表（moveSet）：依分類分開寫，Fighter 建立時攤平成 fighter.moves[key]（key 不可重複）
 *   normal：地面普通攻擊
 *   tc：衍生攻擊（Target Combo），只能從其他招式接出來
 *   drive：動力系統（動力衝擊）
 *   air：空中攻擊；填 replaces: '地面招式 key' = 空中按那個鍵時改出這招（沒有 replaces 的空中招式照 key 出）
 *   special：必殺技（還沒有）
 *   super：超必殺（SA），自動加上 isSuper: true（出招時有鏡頭演出、消耗 SG）
 * 每招會自動加上 category（'normal' | 'tc' | 'drive' | 'air' | 'special' | 'super'）
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
 * chainCancel：預約。攻擊判定第 1 幀的前 chainEarly 幀 ~ 攻擊判定最後 1 幀之間（已經打中 / 被防禦就延長到這招結束），
 *   按任何攻擊鍵 / 絕招鍵 / 衝刺取消鍵都會記住，這招碰到對手（打中或被防禦）才觸發，揮空不觸發：
 *   - 攻擊 / 絕招：收招少 chainCancel 幀，收招結束直接出那一招
 *   - 衝刺取消：碰到對手時觸發
 * chainEarly：見 chainCancel，預設 5
 * chainMirror：命中後，下一次出同一招時鏡像（左右手交換），連續命中就左右輪流
 * 衍生攻擊（tc 分類的招式）：
 *   from：可以從哪些招式接出來（招式 key 陣列）；by：按哪些鍵接（按鍵對應的招式 key 陣列，任一個都可以），例如 ['heavy', 'medium']
 *     在 from 招式的預約時段（同 chainCancel 的時段）內按，那一招結束直接接出來
 *   on：'contact' = from 打中或被防禦都能衍生、'hit' = 只有打中；揮空一律不衍生
 *   cut：衍生時 from 的收招少幾幀（沒填 = from 的 chainCancel）
 *   能衍生、但沒有 chainCancel 的招式：其他攻擊鍵不能預約；絕招、cancelAttack 招式、衝刺取消照常可以預約
 * cancelAttack：跟絕招一樣可以取消普通攻擊：攻擊判定期間按 = 直接中斷出這招（不論有沒有打中）；前搖期間按 = 攻擊判定一到（第 1 幀判定完有沒有打中）就出；預約的優先順序：絕招 > 這種招式 > 普通攻擊
 * armor：{ to, hits } 霸體：第 1 ~ to 幀被非絕招攻擊打中時照常出招（不受擊），最多擋 hits 次，之後再被打照常受擊；傷害變成虛血
 * clash：打在對手也有 clash 的招式的霸體上時的演出，見 DI
 * hitstopTaken：出這招的期間被對手打中（含霸體擋下）時，頓幀乘上這個倍率（對手是絕招時本來就不頓幀）；對撞用 clash.hitstopRate
 * onTarget：{ attack, stand, block } 打到不同狀態的對手時覆蓋的數據：attack = 對手出招中、block = 被防禦、stand = 其他狀態
 * hitEffect：打中時的打擊特效種類（engine/fx/hitEffect.js：'hit' / 'heavy' / 'impact'）；沒填 = 一般 hit，絕招和 heavyHitEffect 是 heavy
 * hitEffectDelay：打擊特效在頓幀結束後再過幾幀（遊戲幀，放慢時跟著變慢）才出現；沒填 = 打中當下
 * hitAnim：對手受擊時改播這個動作（main.js anims 的 key，例如 'headHit'）；沒填 = 一般的 hit
 * crumple：{ delay, soundFrame } 打中站著的對手（不是打飛）：受擊動作播 delay 幀後接倒地動畫（main.js anims.death）；delay 沒填 = 受擊動作（hitAnim）整段播完
 *   整段算站立受擊（有受擊框、可以追打，身體受擊框維持站立高度），沒被追打就倒到底、再無敵起身；soundFrame = 倒地動畫第幾幀播倒地音效
 * closeUp：打中（不含防禦、霸體）時鏡頭拉近到攻擊方後下方特寫（main.js closeUp，格鬥模式才有）；把對手打飛時不特寫
 * slowMo：打中時遊戲放慢（main.js slowMo）；把對手打飛時不放慢
 * glow：{ color, strength, to, fade } 出招時全身發光：第 1 ~ to 幀亮著，之後 fade 幀淡出；strength 0 ~ 1
 * aura：{ color, to, fade, thickness } 出招時包在模型外圍的氣場（engine/render/aura.js：外殼光暈、火花，第 1 幀光環爆發），模型本身不變色
 *   亮到第 to 幀（不填 = 到招式結束前 fade 幀），再用 fade 幀淡出；thickness = 外殼離身體多遠（公尺，不填 = Aura 的預設 0.035）
 *   burstOnly = 沒有外殼，只在出招瞬間爆發一次（火花、光環、閃光；絕招凍結中也會馬上噴；to / fade / thickness 不用）；sparkLife = 火花壽命倍率
 *   絕招（super）沒寫 aura 時自動用 SUPER_AURA；寫 aura: null = 不要
 * desc：招式表（moveList.js）的說明
 * command：{ dir, button } 方向指令：下 → 前（'forward'）/ 下 → 後（'back'）+ 攻擊鍵（'light' / 'medium' / 'heavy'），見 motionInput.js
 * sgCost：（絕招）消耗幾格 SG，不足不能出；沒填 = 1
 * dgCost：出招消耗的 DG，不足就不能出
 * groundOnly：空中不能出
 * damageAs：傷害、連段補正照哪一招算（Combat gaugeRules.damage / scaling 的 key）；沒填 = 自己的 key
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
 * hitScaleY：攻擊判定球上下（Y 軸）拉長幾倍，變成橢圓球（例如 1.5）；沒填 = 正圓球
 * hitLimb：{ bones, width, extend } 攻擊判定改成沿著肢體方向的長方體（取代判定球）
 *   bones：由根部到末端的骨頭，每相鄰兩根一個長方體，最後一段再往外延伸 extend 公尺；截面寬 width 公尺
 *   腿：UpLeg（大腿根）→ Leg（膝蓋）→ Foot（腳踝）；手：Arm（肩）→ ForeArm（手肘）→ Hand（手腕），前面加 Left / Right
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
 * missCut：{ judge, after, jumpTo, length, soundAfter } 揮空時提早收招：第 judge 個攻擊判定（1 起算；'grab' = 抓取判定）結束時還沒打中 / 抓到（被防禦也算），
 *   照原動畫再播 after 幀（後續，沒填 = 0），然後跳到第 jumpTo 幀（幀數表編號）播到最後（結尾）；確定揮空起不再有攻擊判定
 *   播放順序：攻擊 → 後續 after 幀 → 結尾（jumpTo ~ 最後一幀）
 *   length：揮空時這招到第 length 幀就結束（幀數表編號）；可以只填這個、不填 jumpTo = 照原動畫播到那裡結束
 *   soundAfter：音效另外算，確定揮空後再播幾幀就中斷這招的音效（可以比 after 長，跳到結尾後繼續算）；沒填 = 音效不中斷
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
 * activeFrames：（holdUntilLand 招式）攻擊判定最多持續幾幀，之後到落地都沒有判定，動作接回跳躍動畫的後續；沒填 = 持續到落地
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
      startup: 7, recovery: 13, hitStun: 25, blockStun: 15, hitstop: 6,
      chainCancel: 5, chainMirror: true,
      knockback: 0.15,
      gauge: { hit: { dg: 600, oppDg: 0, sg: 300, oppSg: 100 }, block: { dg: 300, oppDg: -1000, sg: 150, oppSg: 100 } },
      hitBones: ['RightHand'],
    },
    // Punching_M 是右手出拳，手臂約第 12~17 幀伸直（裁掉前 9 幀後）
    medium: {
      name: '中攻擊',
      startup: 11, recovery: 13, hitStun: 30, blockStun: 17, hitstop: 7,
      chainCancel: 5, chainMirror: true,
      hitShake: 1, knockback: 0.375,
      gauge: { hit: { dg: 900, oppDg: 0, sg: 300, oppSg: 100 }, block: { dg: 450, oppDg: -2000, sg: 150, oppSg: 100 } },
      advance: { from: 1, to: 11, distance: 0.2 }, // 前搖期間（第 1 幀 ~ 攻擊判定前）往前 0.2 公尺 (0.375 - 0.2 = 0.175 擊退)
      hitBones: ['RightHand'],
    },
    // Punching_H 是左手出拳
    heavy: {
      name: '重攻擊',
      startup: 15, recovery: 13, hitStun: 35, blockStun: 20, hitstop: 8,
      hitShake: true, heavyHitEffect: true, knockback: 0.6,
      gauge: { hit: { dg: 1200, oppDg: 0, sg: 300, oppSg: 100 }, block: { dg: 600, oppDg: -3000, sg: 150, oppSg: 100 } },
      advance: { from: 1, to: 15, distance: 0.4 }, // 前搖期間（第 1 幀 ~ 攻擊判定前）往前 0.4 公尺 (0.6 - 0.4 = 0.2 擊退)
      hitBones: ['LeftHand'],
    },
  },

  // 衍生攻擊（TC）：只能從 from 的招式接出來，觸發條件寫在每一招裡（from / by / on / cut，見上方說明）
  tc: {
    // 重 → 重：Punching_H 鏡像（右手出拳）；鏡像是整個模型左右翻，判定骨頭照樣填 LeftHand
    TC_HH: {
      name: '重連擊', desc: '換另一隻手再打一拳', mirror: true,
      from: ['heavy'], by: ['heavy'], on: 'contact', cut: 6, // 重攻擊打中或被防禦 → 按重
      startup: 20, recovery: 15, hitStun: 35, blockStun: 20, hitstop: 8,
      hitShake: true, heavyHitEffect: true, knockback: 0.6,
      damageAs: 'heavy',
      gauge: { hit: { dg: 1200, oppDg: 0, sg: 300, oppSg: 100 }, block: { dg: 600, oppDg: -3000, sg: 150, oppSg: 100 } },
      advance: { from: 1, to: 20, distance: 0.4 },
      hitBones: ['LeftHand'],
    },
    // 重 → 重 → 重：MmaKick_H（裁掉前 22 幀後）右腳迴旋踢，第 20 幀發生，第 20 ~ 28 幀腳掃過前方
    // length：第 43 幀結束（28 + 收招 15）；動畫後面還有收腳、站穩（約第 50 幀右腳踩地）
    TC_HHH: {
      name: '重連擊2', desc: '右腳迴旋踢',
      from: ['TC_HH'], by: ['heavy'], on: 'hit', cut: 6, // 重連擊打中 → 按重
      length: 43, startup: 19, recovery: 15, hitStun: 35, blockStun: 20, hitstop: 8,
      hitShake: true, heavyHitEffect: true, knockback: 0.6, launch: { distance: 3 },
      damageAs: 'heavy',
      gauge: { hit: { dg: 1200, oppDg: 0, sg: 300, oppSg: 100 }, block: { dg: 600, oppDg: -3000, sg: 150, oppSg: 100 } },
      advance: { from: 1, to: 19, distance: 0.5 },
      hitLimb: { bones: ['RightLeg', 'RightFoot'], width: 0.25, extend: 0.12 },
    },
  },

  // 動力系統
  drive: {
    // 動力衝擊：前搖 35 幀有霸體（擋 2 次非絕招攻擊，第 3 次照常受擊）、第 36 ~ 41 幀攻擊判定（6 幀）、後搖 43 幀
    // 動作暫用 MmaKick_H（裁掉前 6 幀，第 36 ~ 41 幀剛好踢到）：換動作時改 main.js anims.DI、trimAnims.DI 與下面的 hitBones
    DI: {
      name: '動力衝擊', desc: '前搖可以擋下非絕招的攻擊（變成白血）；打中出招中的對手會倒地', groundOnly: true, cancelAttack: true, dgCost: 6000,
      length: 84, startup: 35, recovery: 43, hitStun: 75, blockStun: 46, hitstop: 10,
      armor: { to: 35, hits: 2 }, hitstopTaken: 2,
      aura: { color: 0xff9a2e, to: 41, fade: 20 }, // 外圍的氣場：啟動時光環 + 火花爆發，攻擊判定結束後淡出
      sounds: [{ name: 'DI', frame: 2 }], // 啟動音效（音量見 main.js sounds.DI）；一般招式第 1 幀的音效不會播（只有絕招按下的瞬間會），用第 2 幀
      // 打在對手的動力衝擊霸體上（雙方都出動力衝擊）：頓幀 × hitstopRate，雙方搖 shakes 次（幅度 amplitude 公尺）、鏡頭晃 camera 公尺
      clash: { hitstopRate: 3, shakes: 3, amplitude: 0.3, camera: 0.12 },
      closeUp: true, slowMo: true, // 打中：特寫鏡頭、放慢；對撞也會特寫（給用霸體接住的那一方）
      hitShake: true, heavyHitEffect: true, knockback: 1.5, cameraShake: 0.05,
      // 對手出招中 = 只擊退 0.2、接倒地動畫；站立（出招、防禦以外）= 擊飛；防禦 = 擊退 1.5
      // 打中出招中的對手（成功反擊）：火花換成誇張的 impact，受擊動作換成 headHit，整段播完再倒地
      // 特效等頓幀結束、慢動作開始後 3 幀才亮（慢動作中爆開的打擊感）
      onTarget: { attack: { knockback: 0.2, hitEffect: 'impact', hitEffectDelay: 3, hitAnim: 'headHit', crumple: { soundFrame: 70 } }, stand: { launch: { distance: 3 } }, block: { knockback: 1.5 } },
      gauge: { hit: { dg: 0, oppDg: 0, sg: 300, oppSg: 100 }, block: { dg: 0, oppDg: -3000, sg: 150, oppSg: 100 } },
      advance: { from: 9, to: 35, distance: 1 },
      hitBones: ['RightFoot'], hitScaleY: 1.5, // 判定球在腳踝，上下拉長 1.5 倍（打擊點在腳上）
    },
  },

  air: {
    // 空中重攻擊（MmaKick，20 幀）：第 10 幀發生，攻擊判定最多 20 幀（第 10 ~ 29 幀，先落地就提早結束），之後接回跳躍動畫的後續
    // MmaKick 是左腳踢出、右腳在下；判定是左小腿（膝蓋 → 腳踝再延伸到腳尖）
    airHeavy: {
      name: '空中重攻擊', replaces: 'heavy', // 空中按重拳出這招
      damageAs: 'heavy',
      startup: 9, recovery: 0, hitStun: 35, blockStun: 20, hitstop: 8,
      holdUntilLand: true, activeFrames: 20,
      hitShake: true, knockback: 0.3,
      gauge: { hit: { dg: 1200, oppDg: 0, sg: 300, oppSg: 100 }, block: { dg: 600, oppDg: -3000, sg: 150, oppSg: 100 } },
      hitLimb: { bones: ['LeftLeg', 'LeftFoot'], width: 0.25, extend: 0.12 },
    },
  },

  // 必殺技（還沒有）
  special: {},

  // 超必殺（SA）
  super: {
    kick_ball: {
      name: '浪子踢球', desc: '抓住面前的對手一腳踢飛，防禦不了；撞牆會反彈', command: { dir: 'back', button: 'light' }, sgCost: 1,
      length: 280, hits: [171], hitFrames: 30, hitStun: 30,
      grab: { from: 44, to: 49, range: 1, distance: 0.6, stunFrame: 10 },
      knockback: 0.5, launch: { distance: 10, height: 1.5, slow: 1.5, wallBounce: 1.5 },
      hitDamage: 4000,
      gauge: { hit: { dg: 0, oppDg: 0, sg: 0, oppSg: 0 }, block: { dg: 0, oppDg: 0, sg: 0, oppSg: 0 } },
      rootMotion: true,
      missCut: { judge: 'grab', length: 166 }, // 沒抓到：第 166 幀結束
      hitBones: ['LeftFoot', 'RightFoot'],
      sounds: [{ name: 'kick_ball_title', frame: 1 }],
    },
    monkey_yarn: {
      name: '猴子繞花線', desc: '往前旋身連打，打中擊飛', command: { dir: 'back', button: 'medium' }, sgCost: 2,
      startup: 17, recovery: 40, hitStun: 30,
      knockback: 0.25, launch: true,
      gauge: { hit: { dg: 0, oppDg: 0, sg: 0, oppSg: 0 }, block: { dg: 0, oppDg: 0, sg: 0, oppSg: 0 } },
      rootMotion: true,
    },
    // wind_step：動畫前 60 幀 2 倍速（main.js speedAnims），鏡頭拉遠時才往前跳，第 30 幀落地開始打
    wind_step: {
      name: '風擺柳碎步', desc: '跳到對手面前碎步連打 15 下', command: { dir: 'forward', button: 'medium' }, sgCost: 2, aimOpponent: true,
      hits: [30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160, 170], hitFrames: 2, hitStun: 60, blockStun: 30,
      knockback: 0.1, launch: { distance: 3 }, lock: { distance: 0.75 },
      hitDamage: 250,
      gauge: { hit: { dg: 0, oppDg: 0, sg: 0, oppSg: 0 }, block: { dg: 0, oppDg: 0, sg: 0, oppSg: 0 } },
      advance: { from: 1, to: 30, toOpponent: true, height: 0.2, afterFreeze: true },
      animStart: 'hold',
      sounds: [{ name: 'wind_step_title', frame: 1 }],
    },
    dog_bear: {
      name: '狗熊哆嗦毛', desc: '出招無敵，往前貼身連打 8 下，最後打上天', command: { dir: 'forward', button: 'heavy' }, sgCost: 3,
      length: 415, invincible: true, invincibleFrames: 15, // 出招到第一次攻擊判定都無敵（至少 15 幀）
      hits: [15, 65, 108, 151, 196, 238, 284, 325], hitFrames: 10, hitStun: 60, blockStun: 30,
      knockback: 0.1, launch: { distance: 3, height: 3, slow: 1.5 }, lock: { distance: 0.75 },
      gauge: { hit: { dg: 0, oppDg: 0, sg: 0, oppSg: 0 }, block: { dg: 0, oppDg: 0, sg: 0, oppSg: 0 } },
      advance: { from: 1, to: 10, distance: 2 }, rootMotion: true,
      animStart: 'zoomOut',
      cameraShake: [0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.08, 0.2],
      sounds: [{ name: 'dog_bear_title', frame: 1 }, { name: 'dog_bear', frame: 5, delay: 0.35 }], cutSounds: true,
    },
    shake_head: {
      name: '搖頭晃腦', desc: '出招無敵，第 1 下打中後連打，最後一下把對手打飛', command: { dir: 'back', button: 'heavy' }, sgCost: 3,
      invincible: true, // 出招到第一次攻擊判定都無敵
      hits: [9, 50, 96, 146, 186, 226, 276, 320, [378, 408]], hitFrames: 10, hitStun: 80, blockStun: 50,
      knockback: 0.1, launch: { distance: 8, wallBounce: 1 },
      lock: { distance: 0.75, juggle: { fromHit: 8, maxFrame: 20, maxHeight: 1, minFrame: 60, minHeight: 0.6, animHold: 60, animRestart: 2 } },
      hitDamage: 400, hitDamages: [-1, -1, -1, -1, -1, -1, -1, -1, 1000], // 最後一下 1000
      gauge: { hit: { dg: 0, oppDg: 0, sg: 0, oppSg: 0 }, block: { dg: 0, oppDg: 0, sg: 0, oppSg: 0 } },
      advance: { from: 2, to: 418, distance: 1.5 },
      missCut: { judge: 1, after: 60, jumpTo: 347, soundAfter: 62 }, // 第 1 下沒打中：再播 15 幀後跳到第 350 幀播完；音效揮空後 18 幀中斷
      hitBones: ['RightHand'], hitRadius: 0.25, // 攻擊判定球放大（預設 0.18）
      animStart: 'zoomOut', faceCamera: true,
      cameraShake: [0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.1, 0.8],
      hitCamera: { angle: 60, height: 0.2, lookAhead: { x: 0.3, y: -0.3 } },
      sounds: [{ name: 'shake_head_title', frame: 1 }, { name: 'shake_head', frame: 4, delay: 0.35 }], cutSounds: true,
    },
    dodge_step: {
      name: '閃身步', desc: '穿過對手到背後，打中就轉身再穿，最後一下擊飛', command: { dir: 'forward', button: 'light' }, sgCost: 1,
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

export const MOVE_CATEGORIES = ['normal', 'tc', 'drive', 'air', 'special', 'super']

/** 絕招預設的氣場（招式沒寫 aura 時）：沒有外殼，出招瞬間爆發一次（火花、光環、閃光）；顏色同絕招演出照在人物身上的聚光燈 */
export const SUPER_AURA = { color: 0xffc040, burstOnly: true, sparkLife: 1.5 }

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
 * 招式表 → Fighter 用的 { moves, airMoves, derives }
 *   moves：所有招式攤平（每招各自複製一份，改動不會影響其他人物），加上 category；super 的加上 isSuper
 *   airMoves：地面招式 key → 空中招式 key （來自 air 招式的 replaces）
 *   derives：招式 key → 能衍生的招式 [{ to, by, on, cut }]（來自 tc 招式的 from）
 */
export function flattenMoveSet(moveSet) {
  const moves = {}
  const airMoves = {}
  const derives = {}
  MOVE_CATEGORIES.forEach(category => {
    Object.entries(moveSet?.[category] || {}).forEach(([key, move]) => {
      if (moves[key]) console.warn(`招式 key 重複：${key}`)
      moves[key] = { ...structuredClone(move), category, ...(category === 'super' && { isSuper: true }) }
      if (category === 'super' && move.aura === undefined) moves[key].aura = { ...SUPER_AURA } // 絕招預設有氣場
      if (category === 'air' && move.replaces) airMoves[move.replaces] = key
      if (category === 'tc') move.from?.forEach(from => (derives[from] ??= []).push({ to: key, by: move.by ?? [], on: move.on ?? 'contact', cut: move.cut }))
    })
  })
  return { moves, airMoves, derives }
}
