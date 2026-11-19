// 捕获生词 · YouTube 字幕提取（从 SeekWord background.js/content.js 移植到 Node）。
// 无 Key 多客户端 InnerTube 降级：IOS → ANDROID_VR → MWEB（youtubei.googleapis.com /player），
// captionTracks 选轨（排除翻译轨、优先非 asr 原始轨）→ timedtext 按 fmt=json3 → srv3 → vtt 抓取解析；
// 兜底：/next 取 transcript token → /get_transcript。
// 支持可选 CONNECT 隧道代理（国内直连 youtube 不可达时在面板设置 proxy_url）。
import http from 'node:http'
import https from 'node:https'
import { TLSSocket } from 'node:tls'

// 测试接缝：smoke 用本地假 InnerTube 服务器时注入 SEEKWORD_YT_API
const YT_API = process.env.SEEKWORD_YT_API || 'https://youtubei.googleapis.com/youtubei/v1'
const TIMEOUT = 25000

// 客户端指纹会随时间失效；失效时对照 yt-dlp 近期提交更新 clientVersion/UA
const YT_CLIENT_PROFILES = [
  {
    name: 'ios',
    clientName: 'IOS',
    clientVersion: '20.10.4',
    clientNameHeader: '5',
    userAgent: 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)',
    context: { deviceMake: 'Apple', deviceModel: 'iPhone16,2', platform: 'MOBILE', osName: 'iOS', osVersion: '18.3.2.22D82' },
  },
  {
    name: 'android_vr',
    clientName: 'ANDROID_VR',
    clientVersion: '1.62.20',
    clientNameHeader: '28',
    userAgent: 'com.google.android.apps.youtube.vr.oculus/1.62.20 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
    context: { deviceMake: 'Oculus', deviceModel: 'Quest 3', platform: 'MOBILE', osName: 'Android', osVersion: '12L', androidSdkVersion: 32 },
  },
  {
    name: 'mweb',
    clientName: 'MWEB',
    clientVersion: '2.20251209.01.00',
    clientNameHeader: '2',
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    context: { platform: 'MOBILE', osName: 'iOS', osVersion: '17.5.1' },
  },
]

function connectTunnel(proxyUrl, targetHost, targetPort, timeout) {
  return new Promise((resolve, reject) => {
    const proxy = new URL(proxyUrl)
    const req = http.request({
      host: proxy.hostname,
      port: Number(proxy.port) || 80,
      method: 'CONNECT',
      path: `${targetHost}:${targetPort}`,
      headers: { host: `${targetHost}:${targetPort}` },
      timeout,
    })
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); reject(new Error(`proxy CONNECT ${res.statusCode}`)); return }
      resolve(socket)
    })
    req.on('timeout', () => req.destroy(new Error('proxy connect timeout')))
    req.on('error', reject)
    req.end()
  })
}

// GET/POST 通用传输（文本返回；支持可选 CONNECT 隧道代理）
export function httpFetch(url, { method = 'GET', headers = {}, body = null, proxyUrl = '', timeout = TIMEOUT } = {}) {
  const u = new URL(url)
  const isHttp = u.protocol === 'http:'
  const port = Number(u.port) || (isHttp ? 80 : 443)
  const transport = isHttp ? http : https
  const payload = body ? Buffer.from(body, 'utf8') : null
  const opts = {
    host: u.hostname,
    port,
    method,
    path: `${u.pathname}${u.search}`,
    headers: {
      'accept-language': 'en-US,en;q=0.9',
      ...(payload ? { 'content-length': payload.length } : {}),
      ...headers,
    },
  }
  return new Promise((resolve, reject) => {
    const finish = (socket) => {
      const req = transport.request(socket ? { ...opts, socket, agent: false } : { ...opts, agent: false }, (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => resolve({
          status: res.statusCode,
          contentType: res.headers['content-type'] || '',
          text: Buffer.concat(chunks).toString('utf8'),
        }))
      })
      req.on('error', reject)
      req.setTimeout(timeout, () => req.destroy(new Error(`请求超时（${timeout}ms）`)))
      if (payload) req.write(payload)
      req.end()
    }
    if (proxyUrl && !isHttp) {
      connectTunnel(proxyUrl, u.hostname, port, timeout)
        .then((socket) => finish(new TLSSocket(socket, { servername: u.hostname })))
        .catch(reject)
    } else {
      finish()
    }
  })
}

// ── videoId 解析：?v= / /shorts/ / /live/ / youtu.be / 裸 id ────────────
export function extractVideoId(input) {
  const s = String(input || '').trim()
  if (/^[\w-]{11}$/.test(s)) return s
  try {
    const u = new URL(s.startsWith('http') ? s : `https://${s}`)
    const v = u.searchParams.get('v')
    if (v && /^[\w-]{11}$/.test(v)) return v
    const m = u.pathname.match(/^\/(?:shorts|live|embed|v)\/([\w-]{11})/)
    if (m) return m[1]
    if (u.hostname === 'youtu.be') {
      const id = u.pathname.slice(1)
      if (/^[\w-]{11}$/.test(id)) return id
    }
  } catch { /* 非 URL */ }
  return null
}

// ── InnerTube /player 多客户端 ─────────────────────────────────────────
async function callPlayer(videoId, profile, proxyUrl) {
  const body = JSON.stringify({
    context: {
      client: { clientName: profile.clientName, clientVersion: profile.clientVersion, hl: 'en', gl: 'US', ...profile.context },
      user: { lockedSafetyMode: false },
      request: { useSsl: true },
    },
    videoId,
    contentCheckOk: true,
    racyCheckOk: true,
  })
  return httpFetch(`${YT_API}/player?prettyPrint=false`, {
    method: 'POST',
    proxyUrl,
    headers: {
      'content-type': 'application/json',
      accept: '*/*',
      'user-agent': profile.userAgent,
      'x-youtube-client-name': profile.clientNameHeader,
      'x-youtube-client-version': profile.clientVersion,
      origin: 'https://www.youtube.com',
    },
    body,
  })
}

// 逐客户端尝试，返回第一个带 captionTracks 的响应；单客户端 ERROR 不跳过整体
async function fetchPlayerDirect(videoId, proxyUrl) {
  const failures = []
  for (const c of YT_CLIENT_PROFILES) {
    try {
      const res = await callPlayer(videoId, c, proxyUrl)
      if (res.status !== 200) { failures.push(`${c.name}: http ${res.status}`); continue }
      let data
      try { data = JSON.parse(res.text) } catch { failures.push(`${c.name}: 非 JSON 响应`); continue }
      const st = data?.playabilityStatus?.status
      if (st && st !== 'OK') { failures.push(`${c.name}: ${st}`); continue }
      const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks
      if (Array.isArray(tracks) && tracks.length) return { tracks, title: data?.videoDetails?.title || '', failures }
      failures.push(`${c.name}: OK 但无字幕轨`)
    } catch (e) {
      failures.push(`${c.name}: ${e?.message || e}`)
    }
  }
  return { tracks: [], title: '', failures }
}

// ── 选轨：排除翻译轨（tlang=），尊重语言偏好，优先非 asr 原始轨 ────────
export function chooseTrack(tracks, { lang = '' } = {}) {
  if (!Array.isArray(tracks) || !tracks.length) return null
  const safe = tracks.filter((t) => !/[?&]tlang=/.test(String(t.baseUrl || '')))
  const pool = safe.length ? safe : tracks
  if (lang) {
    const want = String(lang).toLowerCase()
    const byExact = pool.find((t) => String(t.languageCode || '').toLowerCase() === want && (!t.kind || t.kind !== 'asr'))
    if (byExact) return byExact
    const byPrefix = pool.find((t) => String(t.languageCode || '').toLowerCase().startsWith(want.slice(0, 2)) && (!t.kind || t.kind !== 'asr'))
    if (byPrefix) return byPrefix
    const byAny = pool.find((t) => String(t.languageCode || '').toLowerCase().startsWith(want.slice(0, 2)))
    if (byAny) return byAny
  }
  return pool.find((t) => !t.kind || t.kind !== 'asr') || pool[0] || null
}

// ── 字幕解析：json3 / srv3 / vtt ───────────────────────────────────────
export function parseJson3(json) {
  if (!json || !Array.isArray(json.events)) return ''
  const parts = []
  for (const ev of json.events) {
    if (!ev.segs) continue
    const line = ev.segs.map((sg) => sg.utf8).join('').replace(/\s+/g, ' ').trim()
    if (line) parts.push(line)
  }
  return parts.join('\n')
}

export function parseSrv3(xml) {
  if (!xml) return ''
  const out = []
  for (const m of String(xml).matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)) {
    const line = m[1]
      .replace(/<[^>]+>/g, '') // 先剥标记，再解实体（否则解码出的 <x> 会被误剥）
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ').trim()
    if (line) out.push(line)
  }
  return out.join('\n')
}

export function parseVtt(vtt) {
  if (!vtt) return ''
  const lines = String(vtt).replace(/^\uFEFF/, '').split(/\r?\n/)
  const out = []
  let buf = []
  const flush = () => {
    const s = buf.join(' ').replace(/\s+/g, ' ').trim()
    if (s) out.push(s)
    buf = []
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) { flush(); continue }
    if (i === 0 && /^WEBVTT/i.test(line)) continue
    if (/^NOTE(\s|$)/i.test(line)) continue
    if (/^\d+$/.test(line)) continue
    if (/^\d{2}:\d{2}:\d{2}[.,]\d{3}\s+--\s*>/.test(line) || /^\d{2}:\d{2}[.,]\d{3}\s+--\s*>/.test(line)) continue
    const text = line.replace(/<[^>]+>/g, '').trim()
    if (text) buf.push(text)
  }
  flush()
  return out.join('\n')
}

// 本地 .srt 文件解析（capture file 通道用）
export function parseSrt(text) {
  return parseVtt(text) // 结构同 VTT（序号行 + 时间戳 + 文本），同解析器处理
}

function appendParam(url, key, value) {
  return `${url}${url.includes('?') ? '&' : '?'}${encodeURIComponent(key)}=${encodeURIComponent(value)}`
}

// 按格式降级抓一条字幕轨
async function fetchTrackText(track, proxyUrl) {
  const base = String(track?.baseUrl || '')
  if (!base) return ''
  const ct = String(track?.languageCode || '')
  for (const fmt of ['json3', 'srv3', 'vtt']) {
    try {
      const res = await httpFetch(appendParam(base, 'fmt', fmt), {
        proxyUrl,
        headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36', origin: 'https://www.youtube.com', referer: 'https://www.youtube.com/' },
      })
      if (res.status !== 200 || !res.text) continue
      const isJson = res.contentType.includes('json') || res.text.trimStart().startsWith('{')
      if (fmt === 'json3' || isJson) {
        try { const t = parseJson3(JSON.parse(res.text)); if (t) return t } catch { /* 尝试下一格式 */ }
      }
      if (fmt === 'srv3') { const t = parseSrv3(res.text); if (t) return t }
      const t = parseVtt(res.text)
      if (t) return t
    } catch { /* 尝试下一格式 */ }
  }
  return ''
}

// ── 兜底：/next 取 transcript token → /get_transcript ──────────────────
function extractTranscriptToken(nextData) {
  const panels = nextData?.engagementPanels
  if (!Array.isArray(panels)) return null
  for (const p of panels) {
    const list = p?.engagementPanelSectionListRenderer
    if (list?.panelIdentifier !== 'engagement-panel-searchable-transcript') continue
    const content = list?.content
    const direct = content?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token
      || content?.continuationItemRenderer?.continuationEndpoint?.getTranscriptEndpoint?.params
    if (direct) return direct
    const items = content?.sectionListRenderer?.contents
    if (Array.isArray(items)) {
      for (const item of items) {
        const menu = item?.transcriptRenderer?.footer?.transcriptFooterRenderer?.languageMenu?.sortFilterSubMenuRenderer?.subMenuItems
        if (Array.isArray(menu) && menu.length) {
          const chosen = menu.find((i) => i?.selected) || menu[0]
          const token = chosen?.continuation?.reloadContinuationData?.continuation
          if (token) return token
        }
      }
    }
  }
  return null
}

function transcriptSegmentsToLines(data) {
  const segs = data?.actions?.[0]?.updateEngagementPanelAction?.content?.transcriptRenderer?.content
    ?.transcriptSearchPanelRenderer?.body?.transcriptSegmentListRenderer?.initialSegments
  if (!Array.isArray(segs)) return []
  const lines = []
  for (const seg of segs) {
    const r = seg?.transcriptSegmentRenderer
    if (!r) continue
    let text = r.snippet?.simpleText
    if (!text && Array.isArray(r.snippet?.runs)) text = r.snippet.runs.map((x) => x.text).join('')
    if (!text) text = r.snippet?.text || ''
    text = String(text).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()
    if (text) lines.push(text)
  }
  return lines.join('\n')
}

async function fetchViaTranscript(videoId, proxyUrl, lang) {
  const profile = YT_CLIENT_PROFILES[0]
  const ctx = { client: { clientName: profile.clientName, clientVersion: profile.clientVersion, hl: 'en', gl: 'US', ...profile.context } }
  const headers = {
    'content-type': 'application/json',
    'user-agent': profile.userAgent,
    'x-youtube-client-name': profile.clientNameHeader,
    'x-youtube-client-version': profile.clientVersion,
    origin: 'https://www.youtube.com',
  }
  const nextRes = await httpFetch(`${YT_API}/next?prettyPrint=false`, {
    method: 'POST', proxyUrl, headers,
    body: JSON.stringify({ context: ctx, videoId }),
  })
  if (nextRes.status !== 200) throw new Error(`next http ${nextRes.status}`)
  const token = extractTranscriptToken(JSON.parse(nextRes.text))
  if (!token) throw new Error('next 无 transcript token')
  const trRes = await httpFetch(`${YT_API}/get_transcript?prettyPrint=false`, {
    method: 'POST', proxyUrl, headers,
    body: JSON.stringify({ context: ctx, params: token }),
  })
  if (trRes.status !== 200) throw new Error(`get_transcript http ${trRes.status}`)
  const lines = transcriptSegmentsToLines(JSON.parse(trRes.text))
  if (!lines) throw new Error('get_transcript 无内容')
  return { text: lines, via: 'get_transcript', lang: lang || '' }
}

// ── 主入口：抓取 YouTube 字幕 ──────────────────────────────────────────
export async function fetchYoutubeCaptions(input, { proxyUrl = '', lang = '' } = {}) {
  const videoId = extractVideoId(input)
  if (!videoId) return { ok: false, error: '无法从输入解析出 videoId（支持youtu.be/watch?v=/shorts/裸 id）' }

  const diag = []
  // ① 多客户端 /player → captionTracks → timedtext
  const player = await fetchPlayerDirect(videoId, proxyUrl)
  diag.push(...(player.failures || []))
  if (player.tracks.length) {
    const track = chooseTrack(player.tracks, { lang })
    if (track) {
      const text = await fetchTrackText(track, proxyUrl)
      if (text) {
        return {
          ok: true,
          videoId,
          title: player.title,
          text,
          lang: track.languageCode || '',
          trackKind: track.kind || '',
          via: 'timedtext',
          diag,
        }
      }
      diag.push(`timedtext 全格式失败（${track.languageCode}）`)
    } else {
      diag.push('无可选字幕轨')
    }
  }

  // ② get_transcript 兜底
  try {
    const t = await fetchViaTranscript(videoId, proxyUrl, lang)
    return { ok: true, videoId, title: player.title, text: t.text, lang: t.lang, via: t.via, diag }
  } catch (e) {
    diag.push(`get_transcript: ${e?.message || e}`)
  }

  return {
    ok: false,
    videoId,
    error: `此视频没有可取到的字幕。诊断：${diag.join(' | ')}`,
  }
}
