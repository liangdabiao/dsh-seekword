// 面板数据面：/seekword 前缀路由（材料/卡片/收藏/设置/CSV 导出/静态页面）。
// 「生成卡片」走 agent：面板 postMessage 给 client.js 开新对话；面板自身只做确定性读写。
import { createReadStream, existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { extname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DATA_DIR, getSettings, saveSettings, getMeta, getSourceText, getCandidates,
  getCards, listContents, deleteContent, listFavorites, toggleFavorite, getStats, saveContent,
} from './store.js'
import { captureContent } from './capture.js'
import { exportCardsCsv } from './export.js'
import { openExternal } from './open.js'

const BASE = '/seekword'
const LAB = fileURLToPath(new URL('../lab/', import.meta.url))

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2',
}

function json(res, statusCode, value) {
  res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

export function requestRejection(ctx, req) {
  const connection = ctx.get('connection')
  if (typeof connection?.requestRejection !== 'function') return false // dsh 0.2.x 宿主已 token 鉴权
  return connection.requestRejection({ headers: req.headers })
}

function safeFile(dir, rel) {
  if (!dir || String(rel).split('/').some((p) => p.startsWith('.'))) return null
  let base
  try { base = realpathSync(dir) } catch { return null }
  const file = normalize(join(base, rel))
  if (!file.startsWith(base + sep) || !existsSync(file)) return null
  const real = realpathSync(file)
  return real.startsWith(base + sep) && statSync(real).isFile() ? real : null
}

function serveFile(req, res, file) {
  res.writeHead(200, {
    'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
    'content-length': statSync(file).size,
    'cache-control': 'no-cache',
  })
  if (req.method === 'HEAD') return res.end()
  createReadStream(file).pipe(res)
}

function readJson(req, max = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const origin = req.headers.origin
    if (req.method !== 'POST') return reject(Object.assign(new Error('method'), { status: 405 }))
    if (!/^application\/json\b/.test(req.headers['content-type'] || '')) return reject(Object.assign(new Error('type'), { status: 415 }))
    if (origin && origin.replace(/^https?:\/\//, '') !== req.headers.host) return reject(Object.assign(new Error('origin'), { status: 403 }))
    let size = 0
    const chunks = []
    req.on('data', (c) => { size += c.length; if (size > max) req.destroy(); else chunks.push(c) })
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) } catch (e) { reject(Object.assign(e, { status: 400 })) } })
    req.on('error', reject)
  })
}

function readVersion() {
  try { return JSON.parse(readFileSync(join(LAB, '..', 'package.json'), 'utf8')).version } catch { return '' }
}

function resolveContentMeta(contentId) {
  if (contentId) {
    const meta = getMeta(contentId)
    if (!meta) throw Object.assign(new Error(`内容记录不存在：${contentId}`), { status: 404 })
    return meta
  }
  const [latest] = listContents({ limit: 1 })
  if (!latest) throw Object.assign(new Error('还没有捕获过内容'), { status: 404 })
  return latest
}

export function registerApi(ctx, hooks = {}) {
  return ctx.webServer.register({
    kind: 'prefix',
    path: BASE,
    async handler(req, res) {
      try {
        const rejection = requestRejection(ctx, req)
        if (typeof rejection === 'number') return json(res, rejection, { error: '未授权' })

        const url = new URL(req.url, 'http://x')
        if (!url.pathname.startsWith(BASE + '/') && url.pathname !== BASE) return json(res, 404, { error: 'not found' })
        const path = decodeURIComponent(url.pathname.slice(BASE.length)) || '/'

        // ---- API ----
        if (path === '/api/catalog' && req.method === 'GET') {
          const settings = getSettings()
          return json(res, 200, {
            version: readVersion(),
            dataDir: DATA_DIR,
            stats: getStats(),
            contents: listContents({ limit: 100 }),
            favorites_count: listFavorites().length,
            settings: {
              gloss_lang: settings.gloss_lang,
              accent: settings.accent,
              max_cards: settings.max_cards,
              proxy_url: settings.proxy_url || '',
            },
          })
        }

        if (path === '/api/capture' && req.method === 'POST') {
          try {
            const body = await readJson(req)
            const settings = getSettings()
            const captured = await captureContent({
              source: String(body.source || ''),
              text: body.text,
              url: body.url,
              path: body.path,
              title: body.title,
              lang: body.lang,
            }, { proxyUrl: String(body.proxy_url || settings.proxy_url || hooks.config?.proxyUrl || '').trim() })
            const meta = saveContent({
              title: captured.title,
              source: String(body.source),
              sourceUrl: captured.sourceUrl || '',
              lang: captured.lang,
              text: captured.text,
            })
            return json(res, 200, { ok: true, meta })
          } catch (e) { return json(res, e.status || 400, { ok: false, error: e.message }) }
        }

        const cMatch = path.match(/^\/api\/contents\/([^/]+)(\/.*)?$/)
        if (cMatch) {
          const contentId = cMatch[1]
          const sub = cMatch[2] || ''
          const meta = getMeta(contentId)
          if (!meta) return json(res, 404, { error: `内容记录不存在: ${contentId}` })

          if (!sub && req.method === 'GET') {
            return json(res, 200, {
              meta,
              source_text: getSourceText(contentId),
              candidates: getCandidates(contentId),
              cards: getCards(contentId),
              favorites: listFavorites().filter((f) => f.content_id === contentId).map((f) => f.term),
            })
          }
          if (!sub && req.method === 'DELETE') return json(res, 200, deleteContent(contentId))
        }

        if (path === '/api/cards' && req.method === 'GET') {
          // 单词本：跨材料卡片流（content_id / q / fav / source 过滤）
          const q = (url.searchParams.get('q') || '').toLowerCase().trim()
          const fav = url.searchParams.get('fav') === '1'
          const source = url.searchParams.get('source') || ''
          const contentId = url.searchParams.get('content_id') || ''
          const limit = Math.min(Number(url.searchParams.get('limit')) || 500, 2000)
          const favSet = new Map(listFavorites().map((f) => [`${f.content_id}|${String(f.term).toLowerCase()}`, f]))
          const rows = []
          for (const m of contentId ? [getMeta(contentId)].filter(Boolean) : listContents({ limit: 300 })) {
            if (source && m.source !== source) continue
            for (const c of getCards(m.content_id)) {
              const key = `${m.content_id}|${String(c.term).toLowerCase()}`
              const favEntry = favSet.get(key)
              if (fav && !favEntry) continue
              if (q && !String(c.term).toLowerCase().includes(q) && !String(c.definition || '').toLowerCase().includes(q)) continue
              rows.push({ ...c, content_id: m.content_id, title: m.title, source: m.source, lang: m.lang, favorite: Boolean(favEntry) })
            }
          }
          if (fav) {
            // 收藏视图补上"源已删/无卡"的纯词名收藏
            for (const f of listFavorites()) {
              const key = `${f.content_id}|${String(f.term).toLowerCase()}`
              if (rows.some((r) => `${r.content_id}|${String(r.term).toLowerCase()}` === key)) continue
              rows.push({ term: f.term, ...f.snapshot, content_id: f.content_id, title: f.title || '', source: '', lang: '', favorite: true, orphan: true })
            }
          }
          return json(res, 200, { total: rows.length, cards: rows.slice(0, limit) })
        }

        if (path === '/api/favorite' && req.method === 'POST') {
          try {
            const body = await readJson(req)
            const meta = resolveContentMeta(body.content_id)
            if (!body.term) return json(res, 400, { ok: false, error: '缺少 term' })
            const r = toggleFavorite(meta.content_id, String(body.term))
            return json(res, 200, { ok: true, ...r })
          } catch (e) { return json(res, e.status || 400, { ok: false, error: e.message }) }
        }

        if (path === '/api/open' && req.method === 'POST') {
          try {
            const body = await readJson(req)
            const target = await openExternal(body.url)
            return json(res, 200, { ok: true, url: target })
          } catch (e) { return json(res, 400, { ok: false, error: e.message }) }
        }

        if (path === '/api/settings' && req.method === 'GET') {
          const s = getSettings()
          return json(res, 200, { settings: { ...s, proxy_url: s.proxy_url || '' } })
        }
        if (path === '/api/settings' && req.method === 'POST') {
          try {
            const body = await readJson(req)
            const patch = {}
            const GLOSS = ['zh_CN', 'zh_TW', 'en', 'ja', 'ko', 'ru', 'fr', 'de', 'es']
            if (body.gloss_lang !== undefined) {
              if (!GLOSS.includes(body.gloss_lang)) return json(res, 400, { ok: false, error: `gloss_lang 只能是 ${GLOSS.join(' / ')}` })
              patch.gloss_lang = body.gloss_lang
            }
            if (body.accent !== undefined) {
              if (!['us', 'uk'].includes(body.accent)) return json(res, 400, { ok: false, error: 'accent 只能是 us / uk' })
              patch.accent = body.accent
            }
            if (body.max_cards !== undefined) {
              const n = Number(body.max_cards)
              if (!Number.isInteger(n) || n < 5 || n > 60) return json(res, 400, { ok: false, error: 'max_cards 取值 5-60' })
              patch.max_cards = n
            }
            if (body.proxy_url !== undefined) patch.proxy_url = String(body.proxy_url).trim()
            saveSettings(patch) // proxy_url 也写进 settings，供工具代理共用
            return json(res, 200, { ok: true, settings: getSettings() })
          } catch (e) { return json(res, e.status || 400, { ok: false, error: e.message }) }
        }

        if (path === '/api/export' && req.method === 'GET') {
          const fav = url.searchParams.get('fav') === '1'
          let cards
          let name
          if (fav) {
            cards = listFavorites().map((f) => ({ term: f.term, ...f.snapshot }))
            name = 'favorites'
          } else {
            const meta = resolveContentMeta(url.searchParams.get('content_id'))
            cards = getCards(meta.content_id)
            name = meta.title
          }
          if (!cards.length) return json(res, 404, { error: fav ? '收藏为空' : '该材料还没有卡片' })
          const file = exportCardsCsv(cards, name)
          const body = readFileSync(file, 'utf8')
          res.writeHead(200, {
            'content-type': 'text/csv; charset=utf-8',
            'content-disposition': `attachment; filename="seekword-${name.replace(/[^\p{L}\p{N}]+/gu, '_').slice(0, 40)}.csv"`,
            'cache-control': 'no-store',
          })
          return res.end(req.method === 'HEAD' ? undefined : body)
        }

        // ---- 静态页面（lab/）----
        const rel = path === '/' ? 'index.html' : path.slice(1)
        const file = safeFile(LAB, rel)
        if (file) return serveFile(req, res, file)
        // SPA 兜底：只对正常页面路径回 index（穿越/可疑路径一律 404）
        const index = safeFile(LAB, 'index.html')
        if (index && !path.startsWith('/api/') && !rel.includes('..') && /^[^\0]*$/u.test(rel)) {
          return serveFile(req, res, index)
        }
        return json(res, 404, { error: 'not found' })
      } catch (e) {
        return json(res, e.status || 500, { error: e.message })
      }
    },
  })
}
