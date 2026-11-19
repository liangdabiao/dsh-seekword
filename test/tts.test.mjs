// edge-tts 朗读：音色选择 / 缓存键 / 合成与失败回执（不真的调用 python，run 注入）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// store.js 在 import 时读 DSH_HOME，TTS 缓存目录跟着数据目录走
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'seekword-tts-'))
process.on('exit', () => { try { rmSync(process.env.DSH_HOME, { recursive: true, force: true }) } catch { /* ignore */ } })

const { voiceFor, cachePath, synthesize, MAX_TEXT, TTS_DIR } = await import('../lib/tts.js')

test('voiceFor：英语按口音选，其他语言不看口音', () => {
  assert.equal(voiceFor('en', 'us'), 'en-US-AriaNeural')
  assert.equal(voiceFor('en', 'uk'), 'en-GB-SoniaNeural')
  assert.equal(voiceFor('en', ''), 'en-US-AriaNeural')
  assert.equal(voiceFor('ja', 'uk'), 'ja-JP-NanamiNeural')
  assert.equal(voiceFor('zh_CN', 'us'), 'zh-CN-XiaoxiaoNeural')
  assert.equal(voiceFor('xx', 'us'), 'en-US-AriaNeural', '未知语言退回英语美音')
})

test('cachePath：同音色同文本稳定，不同文本/音色不同', () => {
  const a = cachePath('en-US-AriaNeural', 'hello')
  assert.equal(a, cachePath('en-US-AriaNeural', 'hello'))
  assert.notEqual(a, cachePath('en-US-AriaNeural', 'hello!'))
  assert.notEqual(a, cachePath('en-GB-SoniaNeural', 'hello'))
  assert.ok(a.endsWith('.mp3'))
  assert.ok(a.startsWith(TTS_DIR))
})

test('synthesize：合成落盘（注入 run 写文件），第二次走缓存不再调用 run', async () => {
  let calls = 0
  const run = async (voice, text, out) => {
    calls += 1
    assert.equal(voice, 'en-US-AriaNeural')
    assert.equal(text, 'resilient pipeline')
    writeFileSync(out, Buffer.from('ID3-fake-mp3-bytes'))
  }
  const first = await synthesize({ text: 'resilient pipeline', lang: 'en', run })
  assert.equal(first.ok, true)
  assert.equal(first.cached, false)
  assert.equal(calls, 1)
  assert.ok(existsSync(first.file))
  assert.equal(readFileSync(first.file, 'utf8'), 'ID3-fake-mp3-bytes')

  const second = await synthesize({ text: 'resilient  pipeline', lang: 'en', run })
  assert.equal(second.ok, true)
  assert.equal(second.cached, true)
  assert.equal(calls, 1, '空白归一后命中缓存，不应再合成')
})

test('synthesize：空文本 400、超长 400、合成失败 502', async () => {
  const empty = await synthesize({ text: '   ' })
  assert.equal(empty.ok, false)
  assert.equal(empty.status, 400)
  const long = await synthesize({ text: 'a'.repeat(MAX_TEXT + 1) })
  assert.equal(long.ok, false)
  assert.equal(long.status, 400)
  const boom = await synthesize({
    text: 'will fail',
    run: async () => { throw new Error('edge-tts 退出码 1: no network') },
  })
  assert.equal(boom.ok, false)
  assert.equal(boom.status, 502)
  assert.match(boom.error, /no network/)
})

test('synthesize：run 成功但没产出文件 → 502（不返回空音频）', async () => {
  const r = await synthesize({ text: 'silent run', run: async () => { /* 什么都不写 */ } })
  assert.equal(r.ok, false)
  assert.equal(r.status, 502)
  assert.match(r.error, /没有产出音频/)
})
