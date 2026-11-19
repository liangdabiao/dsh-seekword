// 捕获生词 · 多来源捕获：text / youtube / file / web。
// web 通道做最基础的可读性提取（剥 script/style/nav/footer → 按块聚合正文），复杂排版交 agent 自己读；
// file 支持 txt / md / srt / vtt / json3 字幕文件。
import { readFileSync } from 'node:fs'
import { extname } from 'node:path'
import { httpFetch, fetchYoutubeCaptions, parseJson3, parseVtt, parseSrt } from './youtube.js'
import { inferLangFromText } from './languages.js'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const STRIP_BLOCKS = /<(script|style|noscript|svg|iframe|form|nav|footer|header|aside)\b[\s\S]*?<\/\1>/gi
const BLOCK_TAGS = /<\/?(p|div|section|article|h[1-6]|li|tr|br|blockquote|pre|figure|figcaption|td|th)\b[^>]*>/gi

// 基础 HTML → 正文文本（每行一句）
export function htmlToText(html) {
  let s = String(html || '')
  s = s.replace(/<!--[\s\S]*?-->/g, '')
  s = s.replace(STRIP_BLOCKS, ' ')
  s = s.replace(BLOCK_TAGS, '\n')
  s = s.replace(/<[^>]+>/g, ' ')
  s = s.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_m, d) => { try { return String.fromCodePoint(Number(d)) } catch { return '' } })
  const lines = s.split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean)
  // 连续重复的短行（导航/菜单噪声）去重
  const seen = new Set()
  const out = []
  for (const l of lines) {
    const key = l.length < 40 ? l.toLowerCase() : ''
    if (key && seen.has(key)) continue
    if (key) seen.add(key)
    out.push(l)
  }
  return out.join('\n')
}

function extractTitle(html) {
  const m = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  return m ? m[1].replace(/\s+/g, ' ').trim().slice(0, 120) : ''
}

function decodeIfBom(text) {
  return String(text || '').replace(/^\uFEFF/, '')
}

// ── 各通道实现 ─────────────────────────────────────────────────────────
async function captureWeb({ url, proxyUrl = '' }) {
  const res = await httpFetch(url, {
    proxyUrl,
    headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' },
  })
  if (res.status !== 200) throw new Error(`网页请求失败：HTTP ${res.status}`)
  const ct = res.contentType
  const html = decodeIfBom(res.text)
  if (/application\/pdf/i.test(ct)) throw new Error('PDF 链接暂不支持直接解析，请在本地转文本后用 text/file 通道捕获')
  const text = ct.includes('json') ? JSON.stringify(JSON.parse(html), null, 1) : htmlToText(html)
  if (text.replace(/\s/g, '').length < 80) throw new Error('网页正文太短（<80 非空白字符）——页面可能需要登录/渲染，请直接粘贴文本')
  return { text, title: extractTitle(html), lang: inferLangFromText(text) }
}

function captureFile({ path }) {
  const ext = extname(String(path || '')).toLowerCase()
  let raw = readFileSync(path, 'utf8')
  raw = decodeIfBom(raw)
  let text
  if (ext === '.srt') text = parseSrt(raw)
  else if (ext === '.vtt') text = parseVtt(raw)
  else if (ext === '.json3' || ext === '.json') {
    try { text = parseJson3(JSON.parse(raw)) } catch { text = raw }
  } else text = raw
  text = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join('\n')
  if (!text.trim()) throw new Error('文件内容为空')
  return { text, title: '', lang: inferLangFromText(text) }
}

// ── 主入口 ─────────────────────────────────────────────────────────────
export async function captureContent(args, { proxyUrl = '' } = {}) {
  const source = args.source
  if (source === 'text') {
    const text = String(args.text || '').trim()
    if (!text) throw new Error('text 通道需要非空 text')
    if (text.length < 40) throw new Error('文本太短（<40 字符），构不成有效的学习材料')
    return {
      text,
      title: String(args.title || '').trim() || `${text.slice(0, 24).replace(/\s+/g, ' ')}…`,
      lang: args.lang || inferLangFromText(text),
    }
  }
  if (source === 'youtube') {
    if (!args.url) throw new Error('youtube 通道需要 url（视频链接或 videoId）')
    const r = await fetchYoutubeCaptions(args.url, { proxyUrl, lang: args.lang || '' })
    if (!r.ok) throw new Error(r.error)
    return {
      text: r.text,
      title: String(args.title || '').trim() || (r.title || `YouTube ${r.videoId}`),
      lang: args.lang || r.lang || inferLangFromText(r.text),
      sourceUrl: String(args.url),
      videoId: r.videoId,
      via: r.via,
    }
  }
  if (source === 'file') {
    if (!args.path) throw new Error('file 通道需要 path（本地 txt/md/srt/vtt/json3 文件）')
    const r = captureFile({ path: args.path })
    return {
      text: r.text,
      title: String(args.title || '').trim() || String(args.path).replace(/[\\/]/g, '/').split('/').pop(),
      lang: args.lang || r.lang,
    }
  }
  if (source === 'web') {
    if (!args.url) throw new Error('web 通道需要 url（http/https 网页链接）')
    if (!/^https?:\/\//i.test(String(args.url))) throw new Error('web 通道 url 必须以 http(s):// 开头')
    const r = await captureWeb({ url: args.url, proxyUrl })
    return {
      text: r.text,
      title: String(args.title || '').trim() || r.title || args.url,
      lang: args.lang || r.lang,
      sourceUrl: String(args.url),
    }
  }
  throw new Error(`未知来源：${source}（text / youtube / file / web 之一）`)
}
