// cards.test.mjs — 卡片规范化与机械校验
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeExamples, applyIpaRules, localizePos, normalizeCard, validateCards, validateCandidates,
} from '../lib/cards.js'

test('normalizeExamples：每组两行/剥列表符号/截到4组', () => {
  const out = normalizeExamples([
    '- He mitigated the risk.\n- 他降低了风险。',
    'Extra line one\nExtra line two\nThird line ignored',
    { src: 'Object form.', dst: '对象形式。' },
  ])
  assert.equal(out.length, 3)
  assert.equal(out[0], 'He mitigated the risk.\n他降低了风险。')
  assert.equal(out[1], 'Extra line one\nExtra line two')
  assert.equal(out[2], 'Object form.\n对象形式。')
  assert.equal(normalizeExamples('not-array').length, 0)
  assert.equal(normalizeExamples([]).length, 0)
})

test('applyIpaRules：en 主音标+去斜杠+清 reading', () => {
  const c1 = applyIpaRules({ term: 'word', reading: 'x', ipa: '', ipa_us: '/wɝːd/', ipa_uk: '/wɜːd/' }, 'en', 'us')
  assert.equal(c1.ipa, 'wɝːd')
  assert.equal(c1.ipa_us, 'wɝːd')
  assert.equal(c1.reading, '')
  const c2 = applyIpaRules({ term: 'word', ipa: '/kept/', ipa_us: '', ipa_uk: '' }, 'en', 'uk')
  assert.equal(c2.ipa, 'kept') // 已有 ipa 原样（去斜杠）
})

test('applyIpaRules：中日韩清 ipa 留 reading；reading=term 去冗余', () => {
  const c = applyIpaRules({ term: 'あめ', reading: 'あめ', ipa: '/ame/', ipa_us: 'x' }, 'ja', 'us')
  assert.equal(c.ipa, '')
  assert.equal(c.ipa_us, '')
  assert.equal(c.reading, '') // 与 term 相同 → 去冗余
  const c2 = applyIpaRules({ term: '雨', reading: 'あめ', ipa: '/x/' }, 'ja', 'us')
  assert.equal(c2.reading, 'あめ')
  const c3 = applyIpaRules({ term: 'слово', reading: 'x', ipa: '/ˈslovə/' }, 'ru', 'us')
  assert.equal(c3.reading, '')
  assert.equal(c3.ipa, 'ˈslovə')
})

test('localizePos：英文 POS → 中文（简/繁）', () => {
  assert.equal(localizePos({ pos: 'adjective' }, 'zh_CN').pos, '形容词')
  assert.equal(localizePos({ pos: 'noun' }, 'zh_TW').pos, '名詞')
  assert.equal(localizePos({ pos: '动词' }, 'zh_CN').pos, '动词') // 已是中文
  assert.equal(localizePos({ pos: 'noun' }, 'en').pos, 'noun') // 非中文释义不映射
})

test('normalizeCard 字段兜底+trim', () => {
  const c = normalizeCard({ term: '  term1  ', definition: ' d ', examples: 'bad' }, { lang: 'en', glossLang: 'zh_CN', accent: 'us' })
  assert.equal(c.term, 'term1')
  assert.equal(c.definition, 'd')
  assert.deepEqual(c.examples, [])
  assert.equal(c.reading, '')
  assert.equal(c.notes, '')
})

test('validateCards：去重/缺 term/证据 warn/selected 对齐', () => {
  const src = 'The catastrophic failure taught us. Scrutinized logs revealed the culprit.'
  const { cards, warnings } = validateCards([
    { term: 'catastrophic', definition: '灾难性的' },
    { term: 'CATASTROPHIC', definition: '重复' },
    { term: '', definition: 'x' },
    { term: 'notpresent', definition: '不在原文' },
    { term: 'scrutinized', definition: '细看' },
  ], { sourceText: src, lang: 'en' })
  assert.equal(cards.length, 3)
  assert.ok(warnings.some((w) => w.includes('notpresent')))

  const aligned = validateCards(
    [{ term: 'catastrophic', definition: 'a' }, { term: 'scrutinized', definition: 'b' }],
    { sourceText: src, lang: 'en', selected: ['scrutinized', 'ghost', 'catastrophic'] },
  )
  assert.equal(aligned.cards.length, 3)
  assert.equal(aligned.cards[0].term, 'scrutinized') // 按选择顺序
  assert.equal(aligned.cards[1].notes, 'insufficient_context')
  assert.equal(aligned.cards[2].term, 'catastrophic')
})

test('validateCandidates：纯数字丢/去重/evidence warn/cap', () => {
  const src = 'catastrophic failure and ubiquitous sensors everywhere indeed'
  const { candidates, warnings } = validateCandidates([
    { term: 'catastrophic' }, 'catastrophic', { term: '123456' },
    { term: 'ghostword' }, { term: 'ubiquitous', type: 'word' },
    { term: 'failure and ubiquitous', type: 'phrase' },
  ], { sourceText: src, lang: 'en', cap: 3 })
  assert.deepEqual(candidates.map((c) => c.term), ['catastrophic', 'ghostword', 'ubiquitous'])
  assert.ok(warnings.some((w) => w.includes('ghostword')))
  // type 推断：含空格 → phrase
  const inf = validateCandidates([{ term: 'three word phrase' }], { lang: 'en' })
  assert.equal(inf.candidates[0].type, 'phrase')
})
