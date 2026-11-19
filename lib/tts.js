// 朗读：用 edge-tts（Python edge_tts 7.x，微软 Edge 在线语音，无需 key）合成 mp3，本地缓存。
// 浏览器内置语音（Web Speech）音质很差，只作为「edge-tts 不可用/无网」时的兜底（面板侧调用）。
// 语速/音色按语言 + 口音选；同一个文本只合成一次，落盘到 <数据目录>/tts/。
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from './store.js'

export const TTS_DIR = join(DATA_DIR, 'tts')

const VOICES = {
  'en:us': 'en-US-AriaNeural',
  'en:uk': 'en-GB-SoniaNeural',
  'ja:': 'ja-JP-NanamiNeural',
  'ko:': 'ko-KR-SunHiNeural',
  'ru:': 'ru-RU-SvetlanaNeural',
  'fr:': 'fr-FR-DeniseNeural',
  'de:': 'de-DE-KatjaNeural',
  'es:': 'es-ES-ElviraNeural',
  'zh_CN:': 'zh-CN-XiaoxiaoNeural',
  'zh_TW:': 'zh-TW-HsiaoChenNeural',
}

/** 语言 + 口音 → edge 音色。英语按 accent 分美/英，其他语言不看 accent。 */
export function voiceFor(lang, accent) {
  const l = String(lang || 'en').trim()
  const a = String(accent || '').trim().toLowerCase()
  if (l === 'en') return VOICES[`en:${a === 'uk' ? 'uk' : 'us'}`]
  return VOICES[`${l}:`] || VOICES['en:us']
}

export const MAX_TEXT = 400

/** 缓存文件名：音色 + 文本的 sha1，同一句只合成一次。 */
export function cachePath(voice, text) {
  const hash = createHash('sha1').update(`${voice}\u0000${text}`).digest('hex')
  return join(TTS_DIR, `${hash}.mp3`)
}

function pythonCmd() {
  if (process.env.SEEKWORD_PYTHON) return process.env.SEEKWORD_PYTHON
  return process.platform === 'win32' ? 'python' : 'python3'
}

function runEdgeTts(voice, text, outFile, { timeoutMs = 30000 } = {}) {
  const args = ['-m', 'edge_tts', '--voice', voice, '--text', text, '--write-media', outFile]
  return new Promise((resolve, reject) => {
    const child = spawn(pythonCmd(), args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* ignore */ }
      reject(new Error('edge-tts 合成超时'))
    }, timeoutMs)
    child.stderr.on('data', (d) => { stderr += d.toString() })
    child.on('error', (err) => { clearTimeout(timer); reject(err) })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(String(stderr).trim().slice(-300) || `edge-tts 退出码 ${code}`))
    })
  })
}

/**
 * 合成（带缓存）。返回 { ok, file, cached } / { ok:false, error }。
 * options.run 可注入（测试用）：(voice, text, outFile) => Promise<void>
 */
export async function synthesize({ text, lang = 'en', accent = 'us', run } = {}) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim()
  if (!clean) return { ok: false, error: '没有要朗读的文本', status: 400 }
  if (clean.length > MAX_TEXT) return { ok: false, error: `文本太长（上限 ${MAX_TEXT} 字符）`, status: 400 }
  const voice = voiceFor(lang, accent)
  const file = cachePath(voice, clean)
  try {
    if (existsSync(file) && statSync(file).size > 0) return { ok: true, file, cached: true, voice }
  } catch { /* 缓存目录异常就照常合成 */ }

  try { mkdirSync(TTS_DIR, { recursive: true }) } catch { /* ignore */ }
  const tmp = `${file}.${process.pid}.tmp`
  const exec = run || ((v, t, out) => runEdgeTts(v, t, out))
  try {
    await exec(voice, clean, tmp)
    if (!existsSync(tmp) || statSync(tmp).size === 0) throw new Error('edge-tts 没有产出音频')
    renameSync(tmp, file)
    return { ok: true, file, cached: false, voice }
  } catch (err) {
    try { rmSync(tmp, { force: true }) } catch { /* ignore */ }
    return { ok: false, error: String((err && err.message) || err), status: 502 }
  }
}

/** 清空缓存（面板/维护用）。 */
export function clearTtsCache() {
  try { rmSync(TTS_DIR, { recursive: true, force: true }); return true } catch { return false }
}
