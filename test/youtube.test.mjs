// youtube.test.mjs — videoId 解析/字幕格式解析/选轨
import test from 'node:test'
import assert from 'node:assert/strict'
import { extractVideoId, parseJson3, parseSrv3, parseVtt, chooseTrack } from '../lib/youtube.js'

test('extractVideoId 各种链接形态', () => {
  assert.equal(extractVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ')
  assert.equal(extractVideoId('https://youtu.be/dQw4w9WgXcQ'), 'dQw4w9WgXcQ')
  assert.equal(extractVideoId('https://www.youtube.com/shorts/dQw4w9WgXcQ'), 'dQw4w9WgXcQ')
  assert.equal(extractVideoId('https://www.youtube.com/live/dQw4w9WgXcQ?feature=share'), 'dQw4w9WgXcQ')
  assert.equal(extractVideoId('https://www.youtube.com/embed/dQw4w9WgXcQ'), 'dQw4w9WgXcQ')
  assert.equal(extractVideoId('dQw4w9WgXcQ'), 'dQw4w9WgXcQ')
  assert.equal(extractVideoId('not a url'), null)
  assert.equal(extractVideoId(''), null)
})

test('parseJson3 events→行文本', () => {
  const t = parseJson3({ events: [
    { segs: [{ utf8: 'Hello ' }, { utf8: 'world' }] },
    { segs: [{ utf8: 'Second line' }] },
    { noSegs: true },
  ] })
  assert.equal(t, 'Hello world\nSecond line')
  assert.equal(parseJson3(null), '')
})

test('parseSrv3 text 标签+实体', () => {
  const t = parseSrv3('<transcript><text start="0">A &amp; B&lt;x&gt;</text><text start="1">Line <c>two</c></text></transcript>')
  assert.equal(t, 'A & B<x>\nLine two')
})

test('parseVtt 剥时间戳/NOTE/标签，空行分块合并', () => {
  const vtt = '\uFEFFWEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\n<c>Hello</c> world\n\nNOTE meta\n\n00:00:03.000 --> 00:00:04.000\nSecond cue\n'
  assert.equal(parseVtt(vtt), 'Hello world\nSecond cue')
  assert.equal(parseVtt(''), '')
})

test('chooseTrack：排除翻译轨/优先非 asr/尊重语言偏好', () => {
  const tracks = [
    { baseUrl: 'https://x/?tlang=zh', languageCode: 'en' },
    { baseUrl: 'https://x/asr', languageCode: 'en', kind: 'asr' },
    { baseUrl: 'https://x/ja', languageCode: 'ja' },
    { baseUrl: 'https://x/en-orig', languageCode: 'en' },
  ]
  assert.equal(chooseTrack(tracks, {}).languageCode, 'ja') // 非翻译轨里第一个非 asr
  assert.equal(chooseTrack(tracks, { lang: 'en' }).baseUrl, 'https://x/en-orig')
  assert.equal(chooseTrack([], {}), null)
  const allTranslated = [{ baseUrl: 'https://x/?tlang=zh', languageCode: 'en' }]
  assert.equal(chooseTrack(allTranslated, {}).baseUrl.includes('tlang'), true) // 全翻译轨时兜底第一条
})
