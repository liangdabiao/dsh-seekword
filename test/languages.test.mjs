// languages.test.mjs — 语言归一化/脚本门控/停用词/证据匹配
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeLang, humanLabelForLang, termKey, scriptOk, isStopTerm,
  evidenceHit, inferLangFromText, isLatinLang,
} from '../lib/languages.js'

test('normalizeLang 归一化各种写法', () => {
  assert.equal(normalizeLang('en-US'), 'en')
  assert.equal(normalizeLang('zh-cn'), 'zh_CN')
  assert.equal(normalizeLang('zh-Hant'), 'zh_TW')
  assert.equal(normalizeLang('zh'), 'zh_CN')
  assert.equal(normalizeLang('ja-JP'), 'ja')
  assert.equal(normalizeLang('ko'), 'ko')
  assert.equal(normalizeLang('ru_RU'), 'ru')
  assert.equal(normalizeLang(''), 'und')
  assert.equal(normalizeLang(null), 'und')
})

test('humanLabelForLang', () => {
  assert.equal(humanLabelForLang('en'), 'English')
  assert.equal(humanLabelForLang('zh_CN'), 'Chinese(Simplified)')
  assert.equal(humanLabelForLang('xyz'), 'xyz')
})

test('termKey 拉丁大小写不敏感/CJK 原样', () => {
  assert.equal(termKey('Word', 'en'), 'word')
  assert.equal(termKey('Word', 'ja'), 'Word')
  assert.ok(isLatinLang('fr') && !isLatinLang('ja'))
})

test('scriptOk 脚本门控', () => {
  assert.ok(scriptOk('こんにちは', 'ja'))
  assert.ok(scriptOk('漢字', 'ja'))
  assert.ok(!scriptOk('romaji', 'ja'))
  assert.ok(scriptOk('단어', 'ko'))
  assert.ok(!scriptOk('word', 'ko'))
  assert.ok(scriptOk('中文词', 'zh_CN'))
  assert.ok(!scriptOk('pinyin', 'zh_CN'))
  assert.ok(scriptOk('слово', 'ru'))
  assert.ok(!scriptOk('word', 'ru'))
  assert.ok(scriptOk('hello', 'en'))
})

test('isStopTerm 纯数字/标点/停用词', () => {
  assert.ok(isStopTerm('', 'en'))
  assert.ok(isStopTerm('12345', 'en'))
  assert.ok(isStopTerm('!!!', 'en'))
  assert.ok(isStopTerm('2026-01-01', 'en')) // 数字占比高
  assert.ok(isStopTerm('uh', 'en'))
  assert.ok(isStopTerm('えっと', 'ja'))
  assert.ok(isStopTerm('嗯', 'zh_CN'))
  assert.ok(!isStopTerm('catastrophic', 'en'))
})

test('evidenceHit 词边界感知', () => {
  const text = 'The catastrophic failure taught us a lesson. Scrutinize every detail!'
  assert.ok(evidenceHit('catastrophic', text, 'en'))
  assert.ok(evidenceHit('Catastrophic', text, 'en')) // 大小写不敏感
  assert.ok(!evidenceHit('catastroph', text, 'en')) // 词边界：部分词不命中
  assert.ok(!evidenceHit('ubiquitous', text, 'en'))
  assert.ok(evidenceHit('failure taught', text, 'en')) // 短语可命中
  // CJK substring
  assert.ok(evidenceHit('灾难', '这是一场灾难性的失败', 'zh_CN'))
  assert.ok(!evidenceHit('不存在', '这是一场灾难性的失败', 'zh_CN'))
})

test('inferLangFromText 脚本投票', () => {
  assert.equal(inferLangFromText('hello world this is english text'), 'en')
  assert.equal(inferLangFromText('これは日本語のテキストです'), 'ja')
  assert.equal(inferLangFromText('한국어 텍스트'), 'ko')
  assert.equal(inferLangFromText('这是中文文本'), 'zh_CN')
  assert.equal(inferLangFromText('Это русский текст'), 'ru')
  assert.equal(inferLangFromText(''), 'und')
})
