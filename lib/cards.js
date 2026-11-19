// 捕获生词 · 卡片机械校验与规范化（从 SeekWord background.js postProcess* 移植）。
// 创作判断（筛选/释义/例句）归 agent+技能；这里只做确定性护栏：
// 字段兜底 / 例句两行规范化 / IPA 语言规则强制 / POS 中文映射 / 去重 / 证据核对（warn 不阻塞）。
import { normalizeLang, termKey, isLatinLang, scriptOk, isStopTerm, evidenceHit } from './languages.js'

const CARD_FIELDS = ['term', 'reading', 'ipa', 'ipa_us', 'ipa_uk', 'pos', 'definition', 'notes']

const POS_ZH = {
  noun: '名词', verb: '动词', adjective: '形容词', adverb: '副词', preposition: '介词',
  conjunction: '连词', pronoun: '代词', interjection: '叹词', particle: '助词', phrase: '短语',
  idiom: '惯用语', 'auxiliary verb': '助动词', numeral: '数词', 'modal verb': '情态动词',
}
const POS_ZH_TW = {
  名词: '名詞', 动词: '動詞', 形容词: '形容詞', 副词: '副詞', 介词: '介詞',
  连词: '連詞', 代词: '代詞', 叹词: '嘆詞', 助词: '助詞', 短语: '短語', 惯用语: '慣用語',
  数词: '數詞',
}

function cleanStr(v) {
  return String(v ?? '')
    .replace(/^\s*[-*•·\d]+[.)、]?\s*/, '') // 去行首列表符号
    .replace(/[/|]+$/, '')
    .trim()
}

// 例句规范化：每组恰好两行（源语 + 释义翻译），不含发音行
export function normalizeExamples(examples) {
  const out = []
  for (const ex of Array.isArray(examples) ? examples : []) {
    if (typeof ex === 'string') {
      const lines = ex.split(/\r?\n|\s*\/\/\s*/).map(cleanStr).filter(Boolean).slice(0, 2)
      if (lines.length) out.push(lines.join('\n'))
    } else if (ex && typeof ex === 'object') {
      const src = cleanStr(ex.src ?? ex.source ?? ex.en ?? ex.example ?? '')
      const dst = cleanStr(ex.dst ?? ex.translation ?? ex.zh ?? ex.gloss ?? '')
      if (src) out.push(dst ? `${src}\n${dst}` : src)
    }
  }
  return out.slice(0, 4)
}

// IPA 语言规则强制：en 补 ipa（主口音）；中日韩清空 ipa 留 reading；俄法德西清 reading 留 ipa
export function applyIpaRules(card, lang, accent) {
  const l = normalizeLang(lang)
  const s = (v) => String(v ?? '').replace(/^\/|\/$/g, '').trim() // 去包裹斜杠
  if (l === 'en') {
    card.ipa_us = s(card.ipa_us)
    card.ipa_uk = s(card.ipa_uk)
    if (!card.ipa) card.ipa = accent === 'uk' ? (card.ipa_uk || card.ipa_us) : (card.ipa_us || card.ipa_uk)
    else card.ipa = s(card.ipa)
    card.reading = ''
  } else if (l === 'zh_CN' || l === 'zh_TW' || l === 'ja' || l === 'ko') {
    card.ipa = ''
    card.ipa_us = ''
    card.ipa_uk = ''
    card.reading = s(card.reading)
    // reading 与 term 完全相同时去冗余（日文汉字词常见）
    if (card.reading && card.reading === card.term) card.reading = ''
  } else if (l === 'ru' || l === 'fr' || l === 'de' || l === 'es') {
    card.reading = ''
    card.ipa_us = ''
    card.ipa_uk = ''
    card.ipa = s(card.ipa)
  }
  return card
}

// POS 中文映射（释义语言为中文时）
export function localizePos(card, glossLang) {
  const g = normalizeLang(glossLang)
  if (g === 'zh_CN' || g === 'zh_TW') {
    const key = String(card.pos || '').trim().toLowerCase()
    const mapped = POS_ZH[key]
    if (mapped) card.pos = g === 'zh_TW' ? (POS_ZH_TW[mapped] || mapped) : mapped
  }
  return card
}

// 单张卡规范化：字段兜底 + trim + 例句 + IPA/POS 规则
export function normalizeCard(raw, { lang = 'und', glossLang = 'zh_CN', accent = 'us' } = {}) {
  const card = {}
  for (const f of CARD_FIELDS) card[f] = cleanStr(raw?.[f])
  if (raw?.grammar && typeof raw.grammar === 'object' && Object.keys(raw.grammar).length) card.grammar = raw.grammar
  card.term = String(raw?.term ?? '').trim()
  card.examples = normalizeExamples(raw?.examples)
  applyIpaRules(card, lang, accent)
  localizePos(card, glossLang)
  return card
}

// 卡片批校验：去重 / 证据核对（warn） / 可选按 selected 对齐补位。
// 返回 { cards, warnings } —— 只报不拦（宁可漏报不可误报）。
export function validateCards(rawCards, { sourceText = '', lang = 'und', selected = null, ...opts } = {}) {
  const warnings = []
  const cards = []
  const seen = new Set()
  for (const raw of Array.isArray(rawCards) ? rawCards : []) {
    const card = normalizeCard(raw, { lang, ...opts })
    if (!card.term) { warnings.push('有一张卡片缺 term，已丢弃'); continue }
    if (!card.definition) warnings.push(`「${card.term}」缺 definition，建议补齐`)
    const key = termKey(card.term, lang)
    if (seen.has(key)) { warnings.push(`「${card.term}」重复，已合并跳过`); continue }
    seen.add(key)
    cards.push(card)
  }

  if (sourceText) {
    for (const c of cards) {
      if (!evidenceHit(c.term, sourceText, lang)) {
        warnings.push(`「${c.term}」未在原文中找到（词边界匹配），请核对是否原文原词`)
      } else if (!scriptOk(c.term, lang)) {
        warnings.push(`「${c.term}」字符集与源语言不符`)
      } else if (isStopTerm(c.term, lang)) {
        warnings.push(`「${c.term}」疑似填充词/功能词`)
      }
    }
  }

  // 按选择对齐：选了 N 个就出 N 张、顺序一致，缺的补 insufficient_context 占位
  if (Array.isArray(selected) && selected.length) {
    const map = new Map(cards.map((c) => [termKey(c.term, lang), c]))
    const aligned = []
    for (const term of selected) {
      const found = map.get(termKey(term, lang))
      if (found) aligned.push(found)
      else {
        warnings.push(`「${term}」没有对应卡片，已补 insufficient_context 占位`)
        aligned.push({ term: String(term), reading: '', ipa: '', ipa_us: '', ipa_uk: '', pos: '', definition: '', examples: [], notes: 'insufficient_context' })
      }
    }
    return { cards: aligned, warnings }
  }

  return { cards, warnings }
}

// 候选词机械清洗：纯噪声丢弃 + 去重；evidence/stopword 只 warn（创作判断归 agent）
export function validateCandidates(items, { sourceText = '', lang = 'und', cap = 60 } = {}) {
  const warnings = []
  const seen = new Set()
  const out = []
  for (const it of Array.isArray(items) ? items : []) {
    const term = String(typeof it === 'string' ? it : it?.term || '').trim()
    if (!term) continue
    if (isStopTerm(term, lang)) continue // 纯数字/标点/高数字占比：机械事故，直接丢
    const key = termKey(term, lang)
    if (seen.has(key)) continue
    seen.add(key)
    const type = typeof it === 'object' && (it.type === 'phrase' || it.type === 'word') ? it.type
      : (/\s/.test(term) || term.length > (isLatinLang(lang) ? 14 : 6) ? 'phrase' : 'word')
    out.push({ term, type })
    if (sourceText && !evidenceHit(term, sourceText, lang)) warnings.push(`「${term}」未在原文找到（词边界匹配）`)
    if (out.length >= cap) break
  }
  return { candidates: out, warnings }
}
