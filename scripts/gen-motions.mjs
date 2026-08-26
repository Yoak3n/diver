// Diver 桌宠：为 Hiyori 生成情绪动作（motion3.json）
//
// 用法：node scripts/gen-motions.mjs
//
// 设计说明：
//   - 动作文件与官方示例同格式（30fps，线性段为主），段/点计数由脚本按
//     pixi-live2d-display（cubism4.es.js parse()）的规则自动计算：
//       每条曲线：起始点 1 个 + 每段终点（linear/stepped=1，bezier=3）
//       TotalSegmentCount = 所有曲线段数之和
//       TotalPointCount   = 所有曲线点数之和
//   - 参数取值范围参考 Hiyori 官方动作与 Cubism 标准参数范围，全部保守取值，
//     超出范围的值会被 Cubism 引擎 clamp，不会损坏模型。
//   - Loop=false：情绪动作一次性播放，播完自动回到 Idle。

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const OUT_DIR = join(ROOT, 'public', 'pet', 'models', 'Hiyori', 'motions')
mkdirSync(OUT_DIR, { recursive: true })

// ---------- 曲线构建器 ----------
// 输入：[[time, value], ...] 关键帧列表；输出 Segments 数组（全部线性段）
// 段格式：[t0, v0, type(0=linear), t1, v1, type, t2, v2, ...]
function linearSegments(keyframes) {
  const segs = []
  const first = keyframes[0]
  segs.push(first[0], first[1]) // 起始点（无 type）
  for (let i = 1; i < keyframes.length; i++) {
    const k = keyframes[i]
    segs.push(0, k[0], k[1]) // 段：type=0(linear), time, value
  }
  return segs
}

// 计算 Meta 计数（与 cubism4.es.js parse() 完全一致）
function computeMeta(curves, duration, loop = false) {
  let totalSeg = 0
  let totalPts = 0
  for (const c of curves) {
    const s = c.Segments
    let pos = 0
    totalPts += 1 // 起始点
    pos += 2
    while (pos < s.length) {
      const type = s[pos]
      totalSeg += 1
      if (type === 0 || type === 2 || type === 3) {
        totalPts += 1
        pos += 3
      } else if (type === 1) {
        totalPts += 3
        pos += 7
      } else {
        throw new Error(`未知段类型: ${type}`)
      }
    }
  }
  return {
    Duration: duration,
    Fps: 30,
    Loop: loop,
    AreBeziersRestricted: false,
    CurveCount: curves.length,
    TotalSegmentCount: totalSeg,
    TotalPointCount: totalPts,
    UserDataCount: 0,
    TotalUserDataSize: 0,
  }
}

function buildMotion(name, duration, curves, loop = false) {
  const meta = computeMeta(curves, duration, loop)
  const motion = { Version: 3, Meta: meta, Curves: curves }
  writeFileSync(join(OUT_DIR, name), JSON.stringify(motion), 'utf8')
  console.log(`[gen-motions] ${name} → segs=${meta.TotalSegmentCount} pts=${meta.TotalPointCount} dur=${duration}s loop=${loop}`)
}

// ---------- 参数曲线辅助 ----------
const P = (id, keyframes) => ({ Target: 'Parameter', Id: id, Segments: linearSegments(keyframes) })

// ================= 1. Happy 开心（招手雀跃） =================
// 眼睛笑、嘴角上扬、脸颊红、歪头、右臂挥动两次
buildMotion(
  'Hiyori_happy01.motion3.json',
  2.4,
  [
    P('ParamEyeLSmile', [[0, 0], [0.2, 0.85], [0.6, 1], [2.4, 0.85]]),
    P('ParamEyeRSmile', [[0, 0], [0.2, 0.85], [0.6, 1], [2.4, 0.85]]),
    P('ParamMouthForm', [[0, 0], [0.25, 1], [0.7, 0.75], [2.4, 0.7]]),
    P('ParamCheek', [[0, 0], [0.35, 0.7], [0.9, 0.5], [2.4, 0.45]]),
    P('ParamAngleZ', [[0, 0], [0.4, 6], [0.9, 3], [1.4, 5], [2.4, 3]]),
    P('ParamArmLA', [[0, -10], [0.35, -22], [0.8, -20], [1.25, -23], [1.7, -10], [2.2, -10], [2.4, -10]]),
    P('ParamArmRA', [[0, -10], [0.4, 6], [1.0, 4], [1.6, 7], [2.4, 4]]),
    P('ParamBodyAngleY', [[0, 0], [0.3, 3], [0.7, 0], [1.1, 3], [1.5, 0], [2.4, 0.5]]),
    P('ParamHairAhoge', [[0, 0], [0.3, 4], [0.8, 2], [1.3, 5], [2.4, 2]]),
  ],
)

// ================= 2. Sad 难过（低头垂肩） =================
// 低头、眉毛下垂、嘴角下垂、肩耸、眼微闭
buildMotion(
  'Hiyori_sad01.motion3.json',
  3.0,
  [
    P('ParamAngleX', [[0, 0], [0.8, 10], [1.4, 12], [3.0, 10]]),
    P('ParamBrowLY', [[0, 0], [0.6, -0.8], [1.2, -0.6], [3.0, -0.65]]),
    P('ParamBrowRY', [[0, 0], [0.6, -0.8], [1.2, -0.6], [3.0, -0.65]]),
    P('ParamMouthForm', [[0, 0], [0.6, -0.55], [1.2, -0.4], [3.0, -0.45]]),
    P('ParamEyeLOpen', [[0, 1], [0.6, 0.55], [1.2, 0.65], [3.0, 0.6]]),
    P('ParamEyeROpen', [[0, 1], [0.6, 0.55], [1.2, 0.65], [3.0, 0.6]]),
    P('ParamShoulder', [[0, 0], [1.0, 0.45], [1.8, 0.4], [3.0, 0.42]]),
    P('ParamBodyAngleX', [[0, 0], [0.8, 3], [1.6, 4], [3.0, 3.5]]),
    P('ParamArmLA', [[0, -10], [0.8, -6], [1.6, -7], [3.0, -6.5]]),
    P('ParamArmRA', [[0, -10], [0.8, -6], [1.6, -7], [3.0, -6.5]]),
  ],
)

// ================= 3. Angry 生气（皱眉瞪眼） =================
// 眉尾上扬内聚、抿嘴、身体前倾、肩耸、双手握拳下沉
buildMotion(
  'Hiyori_angry01.motion3.json',
  2.2,
  [
    P('ParamBrowLAngle', [[0, 0], [0.25, 14], [0.7, 12], [2.2, 13]]),
    P('ParamBrowRAngle', [[0, 0], [0.25, 14], [0.7, 12], [2.2, 13]]),
    P('ParamBrowLY', [[0, 0], [0.25, 0.5], [0.7, 0.4], [2.2, 0.45]]),
    P('ParamBrowRY', [[0, 0], [0.25, 0.5], [0.7, 0.4], [2.2, 0.45]]),
    P('ParamMouthForm', [[0, 0], [0.25, -0.65], [0.7, -0.5], [2.2, -0.55]]),
    P('ParamAngleZ', [[0, 0], [0.35, -4], [0.9, -2.5], [2.2, -3]]),
    P('ParamBodyAngleX', [[0, 0], [0.35, -5], [1.0, -4], [2.2, -4.5]]),
    P('ParamShoulder', [[0, 0], [0.45, 0.65], [1.0, 0.55], [2.2, 0.6]]),
    P('ParamArmLA', [[0, -10], [0.35, -16], [0.9, -13], [2.2, -14]]),
    P('ParamArmRA', [[0, -10], [0.35, -16], [0.9, -13], [2.2, -14]]),
  ],
)

// ================= 4. Surprised 惊讶（瞪眼张嘴后仰） =================
// 眼大睁、嘴张开、眉上扬、头/身后仰、呆毛竖起、双手上举
buildMotion(
  'Hiyori_surprised01.motion3.json',
  1.4,
  [
    P('ParamEyeLOpen', [[0, 1], [0.15, 1], [0.5, 1], [1.4, 0.95]]),
    P('ParamEyeROpen', [[0, 1], [0.15, 1], [0.5, 1], [1.4, 0.95]]),
    P('ParamMouthOpenY', [[0, 0], [0.18, 0.95], [0.5, 0.7], [1.4, 0.55]]),
    P('ParamBrowLY', [[0, 0], [0.18, 0.95], [0.5, 0.8], [1.4, 0.7]]),
    P('ParamBrowRY', [[0, 0], [0.18, 0.95], [0.5, 0.8], [1.4, 0.7]]),
    P('ParamAngleY', [[0, 0], [0.25, -10], [0.6, -6], [1.4, -5]]),
    P('ParamBodyAngleY', [[0, 0], [0.25, -4], [0.6, -3], [1.4, -2.5]]),
    P('ParamHairAhoge', [[0, 0], [0.25, 8], [0.6, 5], [1.4, 4]]),
    P('ParamArmLA', [[0, -10], [0.25, -18], [0.6, -15], [1.4, -13]]),
    P('ParamArmRA', [[0, -10], [0.25, -18], [0.6, -15], [1.4, -13]]),
  ],
)

// ================= 5. Shy 害羞（脸红低头） =================
// 脸颊红、低头、眼向上瞟、手捧脸、轻微扭捏
buildMotion(
  'Hiyori_shy01.motion3.json',
  2.6,
  [
    P('ParamCheek', [[0, 0], [0.5, 1], [1.2, 0.9], [2.6, 0.75]]),
    P('ParamAngleX', [[0, 0], [0.6, 7], [1.2, 9], [2.6, 7]]),
    P('ParamAngleZ', [[0, 0], [0.4, 3], [1.0, 5], [1.6, 3], [2.2, 5], [2.6, 4]]),
    P('ParamEyeBallY', [[0, 0], [0.5, 0.5], [1.2, 0.6], [2.6, 0.5]]),
    P('ParamEyeLSmile', [[0, 0], [0.5, 0.6], [1.2, 0.7], [2.6, 0.6]]),
    P('ParamEyeRSmile', [[0, 0], [0.5, 0.6], [1.2, 0.7], [2.6, 0.6]]),
    P('ParamMouthForm', [[0, 0], [0.5, 0.5], [1.2, 0.4], [2.6, 0.4]]),
    P('ParamArmLA', [[0, -10], [0.6, -4], [1.2, -6], [2.6, -5]]),
    P('ParamArmRA', [[0, -10], [0.6, -4], [1.2, -6], [2.6, -5]]),
  ],
)

// ================= 6. Nod 点头赞同（认真回应） =================
// 头部点头两下、眉平、眼神专注
buildMotion(
  'Hiyori_nod01.motion3.json',
  1.8,
  [
    P('ParamAngleX', [[0, 0], [0.25, 6], [0.5, 0], [0.75, 6], [1.0, 0], [1.8, 0]]),
    P('ParamAngleY', [[0, 0], [0.25, 3], [0.5, 0], [0.75, 3], [1.0, 0], [1.8, 0]]),
    P('ParamEyeBallX', [[0, 0], [0.3, 0.1], [0.7, -0.05], [1.2, 0.08], [1.8, 0]]),
    P('ParamEyeLOpen', [[0, 1], [0.3, 0.9], [0.8, 0.95], [1.8, 1]]),
    P('ParamEyeROpen', [[0, 1], [0.3, 0.9], [0.8, 0.95], [1.8, 1]]),
    P('ParamMouthForm', [[0, 0], [0.3, 0.35], [0.8, 0.3], [1.8, 0.3]]),
    P('ParamBodyAngleY', [[0, 0], [0.25, 2], [0.5, 0], [0.75, 2], [1.0, 0], [1.8, 0]]),
  ],
)

// ================= 7. Wave 挥手道别 =================
// 右手举起左右挥动、微笑
buildMotion(
  'Hiyori_wave01.motion3.json',
  2.6,
  [
    P('ParamArmRA', [[0, -10], [0.35, 14], [0.7, 10], [1.1, 15], [1.5, 10], [1.9, 15], [2.3, 10], [2.6, 12]]),
    P('ParamHandR', [[0, -1], [0.35, 0.6], [0.7, 0.4], [1.1, 0.7], [1.5, 0.4], [1.9, 0.7], [2.3, 0.4], [2.6, 0.5]]),
    P('ParamArmLA', [[0, -10], [0.5, -12], [1.2, -11], [2.6, -11]]),
    P('ParamEyeLSmile', [[0, 0], [0.4, 0.7], [1.0, 0.8], [2.6, 0.7]]),
    P('ParamEyeRSmile', [[0, 0], [0.4, 0.7], [1.0, 0.8], [2.6, 0.7]]),
    P('ParamMouthForm', [[0, 0], [0.4, 0.7], [1.0, 0.6], [2.6, 0.6]]),
    P('ParamCheek', [[0, 0], [0.6, 0.5], [1.4, 0.4], [2.6, 0.4]]),
    P('ParamAngleZ', [[0, 0], [0.5, 4], [1.2, 2], [2.0, 4], [2.6, 2]]),
  ],
)

console.log('[gen-motions] 完成')
