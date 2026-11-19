// 捕获生词 · 数据层。
//   $DSH_HOME/seekword/
//   ├── settings.json      gloss_lang / accent / max_cards
//   ├── favorites.json     [ {content_id, term, snapshot, saved_at} ]（词卡快照）
//   ├── index.json         [ {content_id} ]（新→旧）
//   └── contents/<id>/
//       ├── meta.json      标题/来源/语言/字数/卡片数
//       ├── source.txt     原文（每行一句）
//       ├── candidates.json [ {term, type} ]（agent 筛选结果，断点续跑）
//       └── cards.json     [ card... ]
// 原子写（tmp + rename）与 xhs-darkhorse/geo-analyzer 同款。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, normalize } from 'node:path'

export const DATA_DIR = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'seekword')
const CONTENTS_DIR = join(DATA_DIR, 'contents')
const INDEX_FILE = join(CONTENTS_DIR, 'index.json')
const FAV_FILE = join(DATA_DIR, 'favorites.json')
const SETTINGS_FILE = join(DATA_DIR, 'settings.json')

const nowIso = () => new Date().toISOString()
const today = () => new Date().toISOString().slice(0, 10)

function readJson(file, fallback = null) {
  if (!existsSync(file)) return fallback
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return fallback }
}

function writeJson(file, value, mkdirAt = CONTENTS_DIR) {
  mkdirSync(mkdirAt, { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8')
  renameSync(tmp, file)
}

function writeFile(file, content) {
  mkdirSync(CONTENTS_DIR, { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, String(content ?? ''), 'utf8')
  renameSync(tmp, file)
  return file
}

// ── 设置 ───────────────────────────────────────────────────────────────
export function getSettings() {
  const s = readJson(SETTINGS_FILE, {}) || {}
  return {
    gloss_lang: s.gloss_lang || 'zh_CN',
    accent: s.accent === 'uk' ? 'uk' : 'us',
    max_cards: Number(s.max_cards) || 30,
    proxy_url: String(s.proxy_url || '').trim(),
  }
}

export function saveSettings(patch) {
  const next = { ...getSettings(), ...patch, updated_at: nowIso() }
  writeJson(SETTINGS_FILE, next, DATA_DIR)
  return next
}

// ── 内容记录 ───────────────────────────────────────────────────────────
function contentDir(id) {
  const safe = String(id).replace(/[^\p{L}\p{N}_-]+/gu, '')
  if (!safe || safe !== String(id)) throw new Error('非法内容 id')
  const dir = join(CONTENTS_DIR, safe)
  if (normalize(dir) !== normalize(join(CONTENTS_DIR, safe))) throw new Error('非法内容 id')
  return dir
}

export function createContentId(title) {
  const ts = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const slug = String(title).replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'material'
  return `${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}-${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}${String(ts.getMilliseconds()).padStart(3, '0')}-${slug}`
}

export function saveContent({ title, source, sourceUrl, lang, text }) {
  const id = createContentId(title)
  const dir = contentDir(id)
  mkdirSync(dir, { recursive: true })
  writeFile(join(dir, 'source.txt'), text)
  const meta = {
    content_id: id,
    title: String(title || '未命名材料').slice(0, 120),
    source, // text | youtube | file | web
    source_url: sourceUrl || '',
    lang: lang || 'und',
    chars: text.length,
    lines: text.split(/\r?\n/).filter((l) => l.trim()).length,
    created_at: nowIso(),
    created_day: today(),
    card_count: 0,
    candidate_count: 0,
  }
  writeJson(join(dir, 'meta.json'), meta)
  const index = getContentIndex().filter((i) => i.content_id !== id)
  index.unshift({ content_id: id })
  writeJson(INDEX_FILE, index.slice(0, 300))
  return meta
}

function getContentIndex() {
  return readJson(INDEX_FILE, []) || []
}

export function getMeta(contentId) {
  return readJson(join(contentDir(contentId), 'meta.json'))
}

export function getSourceText(contentId) {
  const file = join(contentDir(contentId), 'source.txt')
  return existsSync(file) ? readFileSync(file, 'utf8') : ''
}

export function saveCandidates(contentId, candidates) {
  writeJson(join(contentDir(contentId), 'candidates.json'), candidates)
  const meta = getMeta(contentId)
  if (meta) writeJson(join(contentDir(contentId), 'meta.json'), { ...meta, candidate_count: candidates.length })
}

export function getCandidates(contentId) {
  return readJson(join(contentDir(contentId), 'candidates.json'), []) || []
}

export function saveCards(contentId, cards) {
  writeJson(join(contentDir(contentId), 'cards.json'), cards)
  const meta = getMeta(contentId)
  if (meta) writeJson(join(contentDir(contentId), 'meta.json'), { ...meta, card_count: cards.length })
}

export function getCards(contentId) {
  return readJson(join(contentDir(contentId), 'cards.json'), []) || []
}

export function listContents({ limit = 50 } = {}) {
  const out = []
  for (const item of getContentIndex().slice(0, limit)) {
    const meta = getMeta(item.content_id)
    if (meta) out.push(meta)
  }
  return out
}

export function resolveContent(contentId) {
  if (contentId) {
    const meta = getMeta(contentId)
    if (!meta) throw new Error(`内容记录不存在：${contentId}。用 list 查看已有记录。`)
    return meta
  }
  const [latest] = listContents({ limit: 1 })
  if (!latest) throw new Error('还没有捕获过内容。先 capture。')
  return latest
}

export function deleteContent(contentId) {
  const dir = contentDir(contentId)
  if (!existsSync(dir)) return { ok: false, error: `内容记录不存在: ${contentId}` }
  rmSync(dir, { recursive: true, force: true })
  writeJson(INDEX_FILE, getContentIndex().filter((i) => i.content_id !== contentId))
  // 收藏快照保留（收集即沉淀），只标记源已删
  return { ok: true }
}

// ── 收藏（词卡快照，源删除不影响） ─────────────────────────────────────
export function listFavorites() {
  return readJson(FAV_FILE, []) || []
}

export function isFavorited(contentId, term) {
  const norm = (s) => String(s || '').toLowerCase().trim()
  return listFavorites().some((f) => f.content_id === contentId && norm(f.term) === norm(term))
}

export function toggleFavorite(contentId, term) {
  const norm = (s) => String(s || '').toLowerCase().trim()
  const list = listFavorites().filter((f) => !(f.content_id === contentId && norm(f.term) === norm(term)))
  const existed = list.length < listFavorites().length
  let added = false
  if (!existed) {
    const meta = getMeta(contentId)
    const card = getCards(contentId).find((c) => norm(c.term) === norm(term))
    list.unshift({
      content_id: contentId,
      title: meta?.title || '',
      term,
      snapshot: card || { term },
      saved_at: nowIso(),
    })
    added = true
  }
  writeJson(FAV_FILE, list.slice(0, 2000), DATA_DIR)
  return { favorited: added }
}

// ── 总览统计 ───────────────────────────────────────────────────────────
export function getStats() {
  const contents = listContents({ limit: 300 })
  let cards = 0
  let favCards = listFavorites().length
  const bySource = {}
  const byDay = {}
  for (const m of contents) {
    cards += m.card_count || 0
    bySource[m.source] = (bySource[m.source] || 0) + 1
    byDay[m.created_day] = (byDay[m.created_day] || 0) + 1
  }
  return {
    contents: contents.length,
    cards,
    favorites: favCards,
    by_source: bySource,
    recent_days: Object.entries(byDay).sort((a, b) => (a[0] < b[0] ? 1 : -1)).slice(0, 7),
  }
}
