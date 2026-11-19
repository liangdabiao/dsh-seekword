// 捕获生词 · Host 半边（seekword 原生工具 + seekword 技能提供方 + 硬规则注入 + 面板数据面）。
// 生词筛选与制卡由会话模型按技能完成；工具负责捕获原文、存取卡片、机械校验、单词本与导出。
import Schema from '@deepseek-ai/schemastery'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSkillProvider } from '../lib/skills.js'
import { systemSection } from './systemPrompt.js'
import { registerApi } from '../lib/api.js'
import { captureContent } from '../lib/capture.js'
import { validateCards, validateCandidates } from '../lib/cards.js'
import { exportCardsCsv } from '../lib/export.js'
import {
  getSettings, saveSettings, saveContent, getSourceText, getMeta, saveCandidates,
  saveCards, getCards, listContents, resolveContent, deleteContent,
  listFavorites, toggleFavorite, getStats,
} from '../lib/store.js'

export const name = 'seekword' // = cordis.patch.yml 的 id

export const inject = ['tools', 'skills', 'systemPrompt', 'webServer', 'connection']

export const Config = Schema.object({
  injectRules: Schema.boolean().default(true).description('注入捕获生词工作流到系统提示'),
  proxyUrl: Schema.string().default('').description('HTTP(S) 代理（抓 YouTube/网页用），留空直连'),
})

function check(args, spec) {
  const problems = []
  for (const key of spec.required || []) {
    if (args?.[key] === undefined) problems.push(`缺少必填参数 ${key}`)
  }
  for (const [key, rule] of Object.entries(spec.properties || {})) {
    const value = args?.[key]
    if (value === undefined) continue
    if (rule.enum && !rule.enum.includes(value)) problems.push(`${key} 只能是 ${rule.enum.join(' / ')} 之一`)
  }
  for (const key of Object.keys(args || {})) {
    if (!spec.properties || !(key in spec.properties)) problems.push(`未知参数 ${key}`)
  }
  if (problems.length) throw new Error(`参数有误：${problems.join('；')}。`)
}

const str = (description, extra = {}) => ({ type: 'string', description, ...extra })
const num = (description, extra = {}) => ({ type: 'number', description, ...extra })
const arr = (description) => ({ type: 'array', description })
const obj = (description) => ({ type: 'object', description })
const text = (value) => [{ type: 'text', text: value }]

const OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['ok', 'summary'],
    properties: {
      ok: { type: 'boolean' },
      summary: { type: 'string', description: '给模型看的回执' },
      data: { type: 'string', description: '可选：原文片段/卡片清单/记录列表' },
      footer: { type: 'string', description: '可选：输出时需逐字附带的页脚' },
    },
  },
  render: (_args, value) => text([value.summary, value.data, value.footer].filter(Boolean).join('\n\n')),
}

const result = (ok, summary, data = '', footer = '') => ({ ok, summary, data, footer })

const MAX_TEXT = 58000
const READ_CHUNK = 9000 // read 单段默认字符数（agent 分段读原文用）

const SOURCE_LABEL = { text: '粘贴文本', youtube: 'YouTube 字幕', file: '本地文件', web: '网页' }

function buildFooter(meta, extra = '') {
  return `📖 捕获生词 · ${SOURCE_LABEL[meta.source] || meta.source} · 《${meta.title}》 · ${meta.card_count} 卡 · 记录 ${meta.content_id}${extra}`
}

// 单张卡片行（模型可读）
function cardLine(c, idx) {
  const pron = c.ipa || c.reading || ''
  const ex0 = Array.isArray(c.examples) && c.examples[0] ? c.examples[0].split('\n').join(' / ') : ''
  return `${idx}｜**${c.term}**｜${pron}｜${c.pos || ''}｜${c.definition || ''}${ex0 ? `｜例：${ex0}` : ''}${c.notes ? `｜注：${c.notes}` : ''}`
}

// ---------------------------------------------------------------------------
// 工具：seekword —— capture / read / save_candidates / save_cards / list /
//       wordbook / favorite / export / delete / stats
// ---------------------------------------------------------------------------
export const seekwordTool = {
  name: 'seekword',
  description:
    '捕获生词：把任意语言内容（粘贴文本 / YouTube 字幕 / 本地字幕文件 / 网页）先学再看——' +
    'capture 捕获原文 → read 分段读 → 按技能筛选生词 save_candidates → 对选定词制卡 save_cards → 面板学习/单词本/export CSV 导出。' +
    '生词筛选与卡片生成由你按 seekword 技能完成；工具负责捕获、存储、机械校验（回执 warnings 要如实转告用户）。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['action'],
    properties: {
      action: str('capture 捕获原文；read 读原文；save_candidates 存候选词；save_cards 存卡片；list 材料列表；wordbook 查单词本；favorite 收藏切换；export 导出 CSV；delete 删除材料；stats 总览', {
        enum: ['capture', 'read', 'save_candidates', 'save_cards', 'list', 'wordbook', 'favorite', 'export', 'delete', 'stats'],
      }),
      source: str('capture：来源通道', { enum: ['text', 'youtube', 'file', 'web'] }),
      textContent: str('capture(source=text)：原文全文（参数名 textContent，避免与回执 text 混淆）'),
      url: str('capture(source=youtube/web)：视频链接或 videoId / 网页 http(s) 链接'),
      path: str('capture(source=file)：本地 txt/md/srt/vtt/json3 文件路径'),
      title: str('capture：材料标题（缺省自动取）'),
      lang: str('capture：源语言代码（en/zh_CN/zh_TW/ja/ko/ru/fr/de/es，缺省自动检测）'),
      contentId: str('read/save_candidates/save_cards/favorite/delete/export：目标材料记录 id；wordbook/export 可缺省=最新一次'),
      offset: num('read：起始字符，默认 0'),
      limit: num('read：本次最多字符，默认 9000'),
      terms: arr('save_candidates：候选词数组 [{term, type}]（term 必须是原文表面形式）'),
      cards: arr('save_cards：卡片数组 [{term, reading, ipa, ipa_us, ipa_uk, pos, definition, examples, notes}]'),
      selected: arr('save_cards：用户最终选定的词列表（工具按它对齐补位，选 N 个得 N 卡）'),
      query: str('wordbook：搜索词（匹配生词/释义）'),
      onlyFavorite: str('wordbook/export："true" 只看收藏'),
      sourceFilter: str('wordbook：按来源过滤（text/youtube/file/web）'),
      limit: num('wordbook/list：最多返回条数'),
      term: str('favorite：要收藏/取消收藏的生词'),
      favorites: str('export："true" 导出收藏词卡'),
    },
  },
  output: OUTPUT,
  async execute(args, ctxConfig) {
    check(args, this.parameters)
    const cfg = ctxConfig || {}
    const settings = getSettings()
    const proxyUrl = String(cfg.proxyUrl || settings.proxy_url || process.env.SEEKWORD_PROXY || '').trim()

    // ── capture ──────────────────────────────────────────────────────────
    if (args.action === 'capture') {
      const captured = await captureContent({
        source: args.source,
        text: args.textContent,
        url: args.url,
        path: args.path,
        title: args.title,
        lang: args.lang,
      }, { proxyUrl })
      const meta = saveContent({
        title: captured.title,
        source: args.source,
        sourceUrl: captured.sourceUrl || '',
        lang: captured.lang,
        text: captured.text,
      })
      const preview = captured.text.slice(0, 1200)
      const summary =
        `已捕获入库（contentId=${meta.content_id}）。《${meta.title}》· ${SOURCE_LABEL[args.source]} · ${meta.lang} · ${meta.chars} 字符 / ${meta.lines} 行。` +
        `下一步：用 action="read"（offset/limit 分段）通读原文，再按 seekword 技能筛选规则挑生词，save_candidates 入库。`
      return result(true, summary,
        `【开头预览】\n${preview}${meta.chars > 1200 ? '\n…（用 action="read" 读完整原文）' : ''}`,
        buildFooter(meta))
    }

    // ── read ─────────────────────────────────────────────────────────────
    if (args.action === 'read') {
      const meta = resolveContent(args.contentId)
      const full = getSourceText(meta.content_id)
      const offset = Math.max(Number(args.offset) || 0, 0)
      const limit = Math.min(Math.max(Number(args.limit) || READ_CHUNK, 200), 30000)
      const chunk = full.slice(offset, offset + limit)
      if (!chunk) return result(false, `offset=${offset} 已超出原文长度（${full.length} 字符）。`)
      const remaining = full.length - (offset + chunk.length)
      const summary = `《${meta.title}》原文第 ${offset}-${offset + chunk.length} 字符${remaining > 0 ? `；还有 ${remaining} 字符未读，继续 action="read" offset=${offset + chunk.length}` : '；已读到结尾'}。筛选生词必须基于原文。`
      return result(true, summary, chunk.slice(0, MAX_TEXT), buildFooter(meta))
    }

    // ── save_candidates ──────────────────────────────────────────────────
    if (args.action === 'save_candidates') {
      const meta = resolveContent(args.contentId)
      const sourceText = getSourceText(meta.content_id)
      const { candidates, warnings } = validateCandidates(args.terms, {
        sourceText, lang: meta.lang, cap: 60,
      })
      if (!candidates.length) {
        return result(false, '候选词清洗后为空——terms 缺失或全是噪声。请按技能筛选规则从原文挑词再试。')
      }
      saveCandidates(meta.content_id, candidates)
      const lines = candidates.map((c, i) => `${i + 1}. ${c.term}（${c.type}）`)
      const summary =
        `已存 ${candidates.length} 个候选词（contentId=${meta.content_id}）。候选已出现在面板「学习」页，用户可勾选。` +
        `下一步：等用户选定词列表（或用户直接说"就学这几个"），对选定词按技能制卡规则生成卡片后 save_cards 入库，selected 传最终选定列表。` +
        (warnings.length ? `校验提示（如实转告用户）：\n- ${warnings.slice(0, 10).join('\n- ')}` : '')
      return result(true, summary, lines.join('\n'), buildFooter(meta))
    }

    // ── save_cards ───────────────────────────────────────────────────────
    if (args.action === 'save_cards') {
      const meta = resolveContent(args.contentId)
      const sourceText = getSourceText(meta.content_id)
      if (!Array.isArray(args.cards) || !args.cards.length) {
        return result(false, 'cards 缺失或为空——按技能制卡规则生成卡片数组再调。')
      }
      const { cards, warnings } = validateCards(args.cards, {
        sourceText, lang: meta.lang, selected: args.selected,
        glossLang: settings.gloss_lang, accent: settings.accent,
      })
      if (!cards.length) {
        return result(false, '卡片清洗后为空（全部缺 term？）。请检查 cards。')
      }
      // 与已有卡片合并去重（同一材料重复制卡不覆盖旧卡）
      const termKeyOf = (t) => (['en', 'fr', 'de', 'es', 'ru'].includes(meta.lang) ? String(t).toLowerCase().trim() : String(t).trim())
      const existing = getCards(meta.content_id)
      const seen = new Set(existing.map((c) => termKeyOf(c.term)))
      const fresh = cards.filter((c) => !seen.has(termKeyOf(c.term)))
      const dup = cards.length - fresh.length
      const merged = [...existing, ...fresh]
      saveCards(meta.content_id, merged)

      const lines = fresh.map((c, i) => cardLine(c, i + 1))
      const summary =
        `已入库 ${fresh.length} 张新卡片${dup ? `（${dup} 张与已有卡片重复，跳过）` : ''}，该材料现共 ${merged.length} 卡。` +
        `向用户输出：① 上方卡片清单表格（生词/读音音标/词性/释义，原样）→ ② 面板学习指引（侧栏「捕获生词 → 学习」翻卡：←/→ 切换、空格收藏；单词本页可导出 CSV）→ ③ 末尾逐字附页脚。` +
        (warnings.length ? `校验提示（如实转告用户）：\n- ${warnings.slice(0, 10).join('\n- ')}` : '')
      return result(true, summary, lines.join('\n').slice(0, MAX_TEXT), buildFooter({ ...meta, card_count: merged.length }))
    }

    // ── list ─────────────────────────────────────────────────────────────
    if (args.action === 'list') {
      const list = listContents({ limit: Math.min(Number(args.limit) || 30, 100) })
      if (!list.length) return result(false, '还没有捕获过内容。先 capture。')
      const lines = list.map((m) =>
        `${m.content_id}｜《${m.title}》｜${SOURCE_LABEL[m.source] || m.source}｜${m.lang}｜${m.chars} 字符｜候选 ${m.candidate_count}｜${m.card_count} 卡｜${m.created_day}`)
      return result(true, `共 ${list.length} 条材料（新→旧）。对材料操作传 contentId。`, lines.join('\n').slice(0, MAX_TEXT))
    }

    // ── wordbook ─────────────────────────────────────────────────────────
    if (args.action === 'wordbook') {
      const favoritesOnly = args.onlyFavorite === 'true' || args.onlyFavorite === true
      const q = String(args.query || '').toLowerCase().trim()
      const sourceFilter = args.sourceFilter || ''
      const limit = Math.min(Math.max(Number(args.limit) || 50, 1), 200)
      const rows = []
      const contents = listContents({ limit: 300 })
      for (const m of contents) {
        if (sourceFilter && m.source !== sourceFilter) continue
        for (const c of getCards(m.content_id)) {
          rows.push({ meta: m, card: c })
        }
      }
      let pool = favoritesOnly
        ? listFavorites().map((f) => ({ meta: { title: f.title, source: '', content_id: f.content_id }, card: { term: f.term, ...f.snapshot }, fav: true }))
        : rows
      if (q) {
        pool = pool.filter((r) =>
          String(r.card.term || '').toLowerCase().includes(q) ||
          String(r.card.definition || '').toLowerCase().includes(q))
      }
      const offset = Math.max(Number(args.offset) || 0, 0)
      const slice = pool.slice(offset, offset + limit)
      if (!slice.length) return result(false, `没有匹配的卡片（pool=${pool.length}${q ? `，query=${q}` : ''}${favoritesOnly ? '，仅收藏' : ''}）。`)
      const lines = slice.map((r, i) => `${offset + i + 1}｜${r.card.term}｜${r.card.ipa || r.card.reading || ''}｜${r.card.pos || ''}｜${r.card.definition || ''}｜《${r.meta.title}》`)
      return result(true,
        `第 ${offset + 1}-${offset + slice.length} 张 / 共 ${pool.length} 张卡片。用 favorite 可收藏；export 可导出 CSV。`,
        lines.join('\n').slice(0, MAX_TEXT))
    }

    // ── favorite ─────────────────────────────────────────────────────────
    if (args.action === 'favorite') {
      const meta = resolveContent(args.contentId)
      if (!args.term) return result(false, 'favorite 需要传 term（要收藏的生词）。')
      const inCards = getCards(meta.content_id).some((c) => c.term === args.term)
      const r = toggleFavorite(meta.content_id, args.term)
      const hint = r.favorited
        ? `已收藏「${args.term}」（${inCards ? '快照已存' : '该词还没有卡片，快照仅含词名——先制卡再收藏更完整'}）。`
        : `已取消收藏「${args.term}」。`
      return result(true, hint, '', buildFooter(meta))
    }

    // ── export ───────────────────────────────────────────────────────────
    if (args.action === 'export') {
      const fav = args.favorites === 'true' || args.favorites === true
      let cards
      let name
      if (fav) {
        cards = listFavorites().map((f) => ({ term: f.term, ...f.snapshot }))
        name = 'favorites'
        if (!cards.length) return result(false, '收藏为空。先 favorite。')
      } else {
        const meta = resolveContent(args.contentId)
        cards = getCards(meta.content_id)
        name = meta.title
        if (!cards.length) return result(false, `《${meta.title}》还没有卡片。先 save_cards。`)
      }
      const file = exportCardsCsv(cards, name)
      const summary =
        `已导出${fav ? '收藏词卡' : ''} ${cards.length} 张卡片 → ${file}（CSV 带 BOM，Excel 直接打开不乱码）。` +
        `把该路径告诉用户；桌面端 WebContentsView 会 deny window.open，不要把路径当成可点开的入口。`
      return result(true, summary, '', fav ? '📖 捕获生词 · 收藏导出 · ' + cards.length + ' 卡' : '')
    }

    // ── delete ───────────────────────────────────────────────────────────
    if (args.action === 'delete') {
      if (!args.contentId) return result(false, 'delete 需要传 contentId（用 list 查记录）。')
      const meta = getMeta(args.contentId)
      if (!meta) return result(false, `内容记录不存在：${args.contentId}。用 list 查看已有记录。`)
      const r = deleteContent(args.contentId)
      return r.ok
        ? result(true, `已删除《${meta.title}》（${meta.card_count} 卡）。收藏快照仍保留。`)
        : result(false, r.error)
    }

    // ── stats ────────────────────────────────────────────────────────────
    if (args.action === 'stats') {
      const s = getStats()
      const bySource = Object.entries(s.by_source).map(([k, v]) => `${SOURCE_LABEL[k] || k}:${v}`).join(' / ') || '无'
      const days = s.recent_days.map(([d, n]) => `${d}(${n})`).join('、') || '无'
      return result(true,
        `单词本总览：${s.contents} 条材料 / ${s.cards} 张卡片 / ${s.favorites} 张收藏。来源分布 ${bySource}。近 7 天：${days}。`,
        '',
        '📖 捕获生词 · 单词本总览')
    }

    throw new Error(`未知 action：${args.action}`)
  },
}

// ---------------------------------------------------------------------------
// 装配
// ---------------------------------------------------------------------------
export function apply(ctx, config) {
  const skillDirs = [join(dirname(fileURLToPath(import.meta.url)), '..', 'skills')]

  const toolWithConfig = { ...seekwordTool, execute(args) { return seekwordTool.execute(args, config) } }

  ctx.effect(() => ctx.tools.register(toolWithConfig), `${name}: tool`)
  ctx.effect(() => ctx.skills.registerProvider(() => createSkillProvider(skillDirs)), `${name}: skills`)
  if (config.injectRules !== false) {
    ctx.effect(() => ctx.systemPrompt.section(systemSection()), `${name}: workflow`)
  }
  ctx.effect(() => registerApi(ctx, { config }), `${name}: routes`)
}
