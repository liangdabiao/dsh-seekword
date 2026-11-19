// 捕获生词 · 语言工具（从 SeekWord background.js 移植）：
// 语言归一化 / 人类可读名 / 脚本门控 / 停用词 / 证据匹配（词边界感知）。
// 只做确定性判断，供卡片机械校验与捕获检测使用——创作判断归 agent。

export const GLOSS_LANGS = ['zh_CN', 'zh_TW', 'en', 'ja', 'ko', 'ru', 'fr', 'de', 'es']

export function normalizeLang(code) {
  if (!code) return 'und'
  const c = String(code).toLowerCase().replace('_', '-')
  if (c.startsWith('en')) return 'en'
  if (c.startsWith('zh-cn') || c === 'zh-hans' || c === 'zh') return 'zh_CN'
  if (c.startsWith('zh-tw') || c === 'zh-hant') return 'zh_TW'
  if (c.startsWith('ja')) return 'ja'
  if (c.startsWith('ko')) return 'ko'
  if (c.startsWith('ru')) return 'ru'
  if (c.startsWith('fr')) return 'fr'
  if (c.startsWith('de')) return 'de'
  if (c.startsWith('es')) return 'es'
  return c
}

const HUMAN = {
  en: 'English', zh_CN: 'Chinese(Simplified)', zh_TW: 'Chinese(Traditional)',
  ja: 'Japanese', ko: 'Korean', ru: 'Russian', fr: 'French', de: 'German', es: 'Spanish',
}

export function humanLabelForLang(norm) {
  return HUMAN[norm] || norm || 'Unknown'
}

export const LATIN_LANGS = ['en', 'fr', 'de', 'es', 'ru']
export const isLatinLang = (lang) => LATIN_LANGS.includes(normalizeLang(lang))

// 拉丁/西里尔文字大小写不敏感去重；中日韩按原样
export function termKey(term, lang) {
  const s = String(term || '').trim()
  return isLatinLang(lang) ? s.toLowerCase() : s
}

// 脚本门控：term 的字符集必须匹配源语言
export function scriptOk(term, lang) {
  const s = String(term || '').trim()
  if (!s) return false
  const has = (re) => re.test(s)
  switch (normalizeLang(lang)) {
    case 'ja': return has(/[\u3040-\u30FF\u4E00-\u9FFF]/u)
    case 'ko': return has(/[\u1100-\u11FF\u3130-\u318F\uAC00-\uD7AF]/u)
    case 'zh_CN':
    case 'zh_TW': return has(/[\u4E00-\u9FFF]/u)
    case 'ru': return has(/[\u0400-\u04FF]/u)
    default: return true // en/fr/de/es 拉丁文字放行
  }
}

// 内置停用词/填充词（9 语言，从 SeekWord 提示词与后处理清单合并）
const STOPWORDS = {
  en: new Set(['uh', 'um', 'erm', 'like', 'you know', 'okay', 'ok', 'yeah', 'so', 'well',
    'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'at', 'is', 'are', 'was',
    'were', 'be', 'been', 'it', 'this', 'that', 'these', 'those', 'i', 'you', 'he', 'she',
    'we', 'they', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'can', 'could']),
  ja: new Set(['えっと', 'あの', 'まあ', 'うん', 'えー', 'その', 'なんか', 'やっぱり', 'ちょっと',
    '見る', '行く', 'もの', 'こと', 'これ', 'それ', 'あれ']),
  zh_CN: new Set(['嗯', '啊', '就是', '然后', '那个', '这个', '哎', '呢', '吧', '吗',
    '看', '说', '好', '想', '的', '了', '是', '在', '有', '我', '你', '他', '她', '我们']),
  zh_TW: new Set(['嗯', '啊', '就是', '然後', '那個', '這個', '欸', '呢', '吧', '嗎',
    '看', '說', '好', '想', '的', '了', '是', '在', '有', '我', '你', '他', '她', '我們']),
  ko: new Set(['어', '음', '그냥', '막', '그', '이', '저', '가다', '하다', '것', '수', '네', '아니']),
  ru: new Set(['ну', 'типа', 'как бы', 'вот', 'это', 'и', 'в', 'на', 'что', 'да', 'нет']),
  fr: new Set(['euh', 'bah', 'ben', 'du coup', 'voilà', 'quoi', 'le', 'la', 'les', 'un', 'une',
    'et', 'ou', 'mais', 'de', 'à', 'en', 'est', 'que', 'je', 'tu', 'il', 'elle', 'nous', 'vous']),
  de: new Set(['äh', 'ähm', 'also', 'halt', 'so', 'ja', 'nein', 'der', 'die', 'das', 'und',
    'oder', 'aber', 'ein', 'eine', 'ist', 'sind', 'ich', 'du', 'er', 'sie', 'es', 'wir']),
  es: new Set(['eh', 'pues', 'bueno', 'o sea', 'vale', 'ya', 'el', 'la', 'los', 'las', 'un',
    'una', 'y', 'o', 'pero', 'de', 'en', 'es', 'que', 'yo', 'tú', 'él', 'ella', 'nosotros']),
}

export function stopSet(lang) {
  return STOPWORDS[normalizeLang(lang)] || new Set()
}

export function isStopTerm(term, lang) {
  const s = String(term || '').trim()
  if (!s) return true
  const alnum = s.replace(/[^\p{L}\p{M}\p{N}]+/gu, '')
  if (!alnum) return true // 纯数字/标点（只保留字母数字后为空）
  const digitRatio = (s.replace(/[^0-9]/g, '').length) / s.length
  if (digitRatio > 0.5) return true // 数字占比过半
  return stopSet(lang).has(s.toLowerCase())
}

// 证据匹配：term 必须在原文出现过。
// 拉丁/西里尔 → Unicode 感知词边界正则（\p{L}\p{M}\p{N}'- 算词内字符）；中日韩 → substring。
export function evidenceHit(term, sourceText, lang) {
  const t = String(term || '').trim()
  const text = String(sourceText || '')
  if (!t || !text) return false
  if (!isLatinLang(lang)) return text.includes(t)
  try {
    const esc = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(`(^|[^\\p{L}\\p{M}\\p{N}'-])${esc}([^\\p{L}\\p{M}\\p{N}'-]|$)`, 'iu')
    return re.test(text)
  } catch {
    return text.toLowerCase().includes(t.toLowerCase())
  }
}

// 从文本猜测源语言（脚本占比投票；捕获时用于缺省 lang）
export function inferLangFromText(text) {
  const s = String(text || '')
  if (!s) return 'und'
  const count = (re) => (s.match(re) || []).length
  const han = count(/[\u4E00-\u9FFF]/gu)
  const kana = count(/[\u3040-\u30FF]/gu)
  const hangul = count(/[\uAC00-\uD7AF\u1100-\u11FF]/gu)
  const cyrillic = count(/[\u0400-\u04FF]/gu)
  const latin = count(/[A-Za-zÀ-ÿ]/gu)
  const cjk = han + kana
  if (kana > 0) return 'ja'
  if (hangul > 0 && hangul >= cjk - kana) return 'ko'
  if (cyrillic > 0 && cyrillic >= latin) return 'ru'
  if (han > 0) return 'zh_CN'
  if (latin > 0) return 'en'
  return 'und'
}
