// 捕获生词 · CSV 导出（\ufeff BOM，Excel 兼容；与 SeekWord exportCSV 同字段口径）。
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from './store.js'

const CSV_FIELDS = ['term', 'reading', 'ipa', 'ipa_us', 'ipa_uk', 'pos', 'definition', 'notes', 'examples']

function csvCell(v) {
  const s = Array.isArray(v) ? v.join('\n') : String(v ?? '')
  return `"${s.replace(/"/g, '""')}"`
}

export function cardsToCsv(cards) {
  const rows = [CSV_FIELDS.join(',')]
  for (const c of cards) {
    rows.push(CSV_FIELDS.map((f) => csvCell(c[f] ?? (f === 'examples' ? [] : ''))).join(','))
  }
  return `\ufeff${rows.join('\r\n')}\r\n`
}

export function exportCardsCsv(cards, baseName) {
  const safe = String(baseName || 'seekword').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60) || 'seekword'
  const dir = join(DATA_DIR, 'exports')
  mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().slice(0, 10)
  const file = join(dir, `${safe}-${stamp}.csv`)
  writeFileSync(file, cardsToCsv(cards), 'utf8')
  return file
}
