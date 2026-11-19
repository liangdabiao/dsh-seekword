// 面板真实 DOM 流程测试（jsdom）：四个渠道填值 → 点「分析」→ 交接草稿进对话。
// 这一层专门抓「静态检查看不出、只有真 DOM 才暴露」的 bug：
//   例：网页 tab 与 YouTube tab 共用 id，querySelector 读到另一个 tab 的空输入框 → 明明填了链接还说「先填链接」。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { Writable } from 'node:stream'
import { JSDOM } from 'jsdom'

// 隔离数据目录：面板测试绝不碰真实单词本（store.js 在 import 时读 DSH_HOME）
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'seekword-panel-'))
process.on('exit', () => { try { rmSync(process.env.DSH_HOME, { recursive: true, force: true }) } catch { /* ignore */ } })

const { registerApi } = await import('../lib/api.js')
const { saveContent, saveCandidates, saveCards, listFavorites, getSettings, listLearned } = await import('../lib/store.js')

const routes = {}
// 假 workspaceRegistry：验证「分析」会把插件独立工作区 id 一并交给对话
const fakeWorkspaceRegistry = { create: async (path, title) => ({ id: 'ws-plugin-1', path, title }) }
registerApi(
  { get: (name) => (name === 'workspaceRegistry' ? fakeWorkspaceRegistry : undefined), webServer: { register: (r) => { routes[r.path] = r.handler } } },
  { config: {}, picker: async () => ({ ok: false, cancelled: true }) },
)

// 把 fetch 直接接到 /seekword 路由处理器上（不起服务器）
function apiFetch(url, opts = {}) {
  const reqObj = new EventEmitter()
  reqObj.method = String(opts.method || 'GET').toUpperCase()
  reqObj.url = String(url)
  const headers = { host: 'panel.test' }
  const body = opts.body === undefined ? undefined : String(opts.body)
  if (body !== undefined) {
    headers['content-type'] = 'application/json'
    headers.origin = 'https://panel.test'
  }
  reqObj.headers = headers
  const chunks = []
  const resObj = new Writable({ write(c, _e, cb) { chunks.push(c); cb() } })
  resObj.statusCode = 0
  resObj.writeHead = (code) => { resObj.statusCode = code }
  const finished = new Promise((resolve) => {
    const origEnd = resObj.end.bind(resObj)
    resObj.end = (...args) => { origEnd(...args); resolve() }
  })
  const running = routes['/seekword'](reqObj, resObj)
  if (body !== undefined) reqObj.emit('data', Buffer.from(body))
  reqObj.emit('end')
  return Promise.resolve(running).then(() => finished).then(() => {
    const text = Buffer.concat(chunks).toString('utf8')
    const status = resObj.statusCode || 200
    return { ok: status < 400, status, text: () => text, json: async () => JSON.parse(text) }
  })
}

async function waitFor(fn, { timeout = 4000, interval = 15 } = {}) {
  const start = Date.now()
  for (;;) {
    let value
    try { value = fn() } catch { value = false }
    if (value) return value
    if (Date.now() - start > timeout) throw new Error('waitFor 超时')
    await new Promise((r) => setTimeout(r, interval))
  }
}

const htmlSource = readFileSync(new URL('../lab/index.html', import.meta.url), 'utf8')
const appSource = readFileSync(new URL('../lab/app.js', import.meta.url), 'utf8')

async function mount() {
  const dom = new JSDOM(htmlSource, { url: 'https://panel.test/seekword/', runScripts: 'outside-only', pretendToBeVisual: true })
  const { window } = dom
  const sent = []
  // 伪装成嵌在 dsh 页面里的 iframe：parent 有 postMessage，用来截获交接草稿
  Object.defineProperty(window, 'parent', { value: { postMessage: (d) => sent.push(d) }, configurable: true })
  window.fetch = (u, o) => apiFetch(u, o)
  Object.defineProperty(window.navigator, 'clipboard', { value: { writeText: async () => {} }, configurable: true })
  // 语音桩：Audio 记录要播放的 /api/tts 地址；Web Speech 只作为兜底
  const played = []
  window.Audio = function (url) {
    this.url = url
    this.pause = () => {}
    this.play = () => { played.push(url); return Promise.resolve() }
  }
  const spoken = []
  window.SpeechSynthesisUtterance = function (text) { this.text = text }
  window.speechSynthesis = {
    cancel() {},
    getVoices: () => [],
    speak(u) { spoken.push({ text: u.text, lang: u.lang || '' }) },
  }
  window.confirm = () => true
  window.eval(appSource)
  const doc = window.document
  await waitFor(() => doc.querySelector('#cap-path'))
  return { window, doc, sent, played, spoken }
}

const toastText = (doc) => doc.getElementById('toast').textContent || ''
const goBtn = (doc, field) => doc.querySelector(`[data-field="${field}"] .cap-go`)
function typeInto(window, el, value) {
  el.value = value
  el.dispatchEvent(new window.Event('input', { bubbles: true }))
}
async function openTab(doc, tab) {
  const before = doc.querySelector('#cap-tabs')
  doc.querySelector(`button[data-tab="${tab}"]`).click()
  // 等真渲染完成（节点被替换）再断言，否则读到的是旧 DOM
  await waitFor(() => doc.querySelector('#cap-tabs') && doc.querySelector('#cap-tabs') !== before)
  return doc.querySelector(`[data-field="${tab}"]`)
}
// 关窗前先停掉 2s 轮询，否则定时器会在测试结束后继续跑并报 unhandledRejection
async function teardown(window, doc) {
  try { doc.getElementById('waiting-cancel')?.click() } catch { /* ignore */ }
  await new Promise((r) => setTimeout(r, 30))
  try { window.close() } catch { /* ignore */ }
}

test('网页 tab：填了链接点「分析」→ 草稿带该链接（不再误报「先填链接」）', async () => {
  const { window, doc, sent } = await mount()
  await openTab(doc, 'web')
  typeInto(window, doc.querySelector('#cap-url-web'), 'https://r36s.org/articles/guide-wifi-setup')
  goBtn(doc, 'web').click()
  await waitFor(() => sent.length > 0)
  assert.equal(sent[0].type, 'seekword:refresh')
  assert.match(sent[0].prompt, /https:\/\/r36s\.org\/articles\/guide-wifi-setup/)
  assert.match(sent[0].prompt, /source="web"/)
  assert.ok(!toastText(doc).includes('先填链接'), `toast 不该报错：${toastText(doc)}`)
  await teardown(window, doc)
})

test('YouTube tab：填链接点「分析」→ 草稿带链接 + source=youtube', async () => {
  const { window, doc, sent } = await mount()
  await openTab(doc, 'youtube')
  typeInto(window, doc.querySelector('#cap-url-yt'), 'https://www.youtube.com/watch?v=abc12345678')
  goBtn(doc, 'youtube').click()
  await waitFor(() => sent.length > 0)
  assert.match(sent[0].prompt, /youtube\.com\/watch\?v=abc12345678/)
  assert.match(sent[0].prompt, /source="youtube"/)
  await teardown(window, doc)
})

test('文件 tab：填路径点「分析」→ 草稿带绝对路径 + source=file', async () => {
  const { window, doc, sent } = await mount()
  typeInto(window, doc.querySelector('#cap-path'), 'D:\\资料\\article.pdf')
  goBtn(doc, 'file').click()
  await waitFor(() => sent.length > 0)
  assert.match(sent[0].prompt, /D:\\资料\\article\.pdf/)
  assert.match(sent[0].prompt, /source="file"/)
  await teardown(window, doc)
})

test('粘贴文本 tab：贴原文点「分析」→ 草稿带原文全文 + source=text', async () => {
  const { window, doc, sent } = await mount()
  await openTab(doc, 'text')
  const body = 'The curator examined the manuscript with unusual candor before concluding that the provenance remained dubious.'
  typeInto(window, doc.querySelector('#cap-text'), body)
  goBtn(doc, 'text').click()
  await waitFor(() => sent.length > 0)
  assert.match(sent[0].prompt, /source="text"/)
  assert.ok(sent[0].prompt.includes(body), '草稿里应包含原文全文')
  await teardown(window, doc)
})

test('空值/非法值都给出对应提示，且不发草稿', async () => {
  const { window, doc, sent } = await mount()
  // 网页 tab 空链接
  await openTab(doc, 'web')
  goBtn(doc, 'web').click()
  await waitFor(() => toastText(doc).includes('先填链接'))
  // 网页 tab 非 http 链接
  typeInto(window, doc.querySelector('#cap-url-web'), 'ftp://example.com/a')
  goBtn(doc, 'web').click()
  await waitFor(() => toastText(doc).includes('http(s)'))
  // 文件 tab 非绝对路径
  await openTab(doc, 'file')
  typeInto(window, doc.querySelector('#cap-path'), 'article.txt')
  goBtn(doc, 'file').click()
  await waitFor(() => toastText(doc).includes('绝对路径'))
  // 粘贴 tab 空原文
  await openTab(doc, 'text')
  goBtn(doc, 'text').click()
  await waitFor(() => toastText(doc).includes('先粘贴原文'))
  assert.equal(sent.length, 0, '非法输入不该发出任何草稿')
  await teardown(window, doc)
})

test('切 tab 不丢已填内容（链接与原文各自保留）', async () => {
  const { window, doc } = await mount()
  await openTab(doc, 'web')
  typeInto(window, doc.querySelector('#cap-url-web'), 'https://example.com/article')
  await openTab(doc, 'text')
  typeInto(window, doc.querySelector('#cap-text'), 'some pasted text')
  await openTab(doc, 'web')
  assert.equal(doc.querySelector('#cap-url-web').value, 'https://example.com/article')
  assert.equal(doc.querySelector('#cap-url-yt').value, 'https://example.com/article', '链接在两个 tab 之间共用草稿')
  await openTab(doc, 'text')
  assert.equal(doc.querySelector('#cap-text').value, 'some pasted text')
  await teardown(window, doc)
})

test('交接后：清空输入 + 出现「等待 agent 入库」进度条', async () => {
  const { window, doc, sent } = await mount()
  await openTab(doc, 'web')
  typeInto(window, doc.querySelector('#cap-url-web'), 'https://example.com/article')
  goBtn(doc, 'web').click()
  await waitFor(() => sent.length > 0)
  assert.equal(doc.querySelector('#cap-url-web').value, '')
  const bar = await waitFor(() => doc.getElementById('waiting-bar'))
  assert.match(bar.textContent, /等待 agent 入库/)
  await teardown(window, doc)
})

test('四个渠道的输入框 id 唯一（防止 querySelector 读错 tab）', async () => {
  const { window, doc } = await mount()
  assert.equal(doc.querySelectorAll('#cap-url').length, 0, '不应该再有共用的 #cap-url')
  assert.equal(doc.querySelectorAll('#cap-url-yt').length, 1)
  assert.equal(doc.querySelectorAll('#cap-url-web').length, 1)
  assert.equal(doc.querySelectorAll('#cap-path').length, 1)
  assert.equal(doc.querySelectorAll('#cap-text').length, 1)
  assert.equal(doc.querySelectorAll('.cap-go').length, 4)
  await teardown(window, doc)
})

test('重复渲染不叠加监听：点一次「分析生词」只发一份草稿', async () => {
  const m = saveContent({
    title: '重复渲染测试材料',
    source: 'text',
    sourceUrl: '',
    lang: 'en',
    text: 'A sentence long enough to pass the minimum length check while testing duplicate listeners on the home page.',
  })
  const { window, doc, sent } = await mount()
  await openTab(doc, 'text')
  await openTab(doc, 'file')
  await openTab(doc, 'web')
  await waitFor(() => doc.querySelector(`button[data-act="analyze"][data-id="${m.content_id}"]`))
  doc.querySelector(`button[data-act="analyze"][data-id="${m.content_id}"]`).click()
  await waitFor(() => sent.length > 0)
  await new Promise((r) => setTimeout(r, 80))
  assert.equal(sent.length, 1, `一次点击只该发一份草稿，实际发了 ${sent.length} 份`)
  await teardown(window, doc)
})

test('学习页：勾选候选 → 点「② 生成卡片」→ 草稿带所选词', async () => {
  const m = saveContent({
    title: '候选制卡测试材料',
    source: 'text',
    sourceUrl: '',
    lang: 'en',
    text: 'The archivist uncovered a peculiar ledger while cataloguing the estate, annotating each entry in a meticulous hand.',
  })
  saveCandidates(m.content_id, [{ term: 'peculiar', type: 'word' }, { term: 'meticulous', type: 'word' }])
  const { window, doc, sent } = await mount()
  window.location.hash = `#/learn?id=${encodeURIComponent(m.content_id)}`
  await waitFor(() => doc.querySelector('#cand-go'))
  assert.equal(doc.querySelectorAll('.cand').length, 2)
  doc.querySelector('#cand-go').click()
  await waitFor(() => sent.length > 0)
  assert.match(sent[0].prompt, /peculiar/)
  assert.match(sent[0].prompt, /meticulous/)
  assert.match(sent[0].prompt, /save_cards/)
  await teardown(window, doc)
})

test('单词本：点收藏 → 写进收藏', async () => {
  const m = saveContent({
    title: '单词本测试材料',
    source: 'text',
    sourceUrl: '',
    lang: 'en',
    text: 'A resilient pipeline tolerates a temporary failure and resumes where it left off in the run.',
  })
  saveCards(m.content_id, [{
    term: 'resilient', ipa_us: 'rɪˈzɪliənt', ipa_uk: 'rɪˈzɪliənt', pos: 'adjective',
    definition: '有韧性的', examples: ['A resilient pipeline tolerates a failure.\n有韧性的流水线能容忍失败。'], notes: '',
  }])
  const before = listFavorites().length
  const { window, doc } = await mount()
  window.location.hash = '#/wordbook'
  const btn = await waitFor(() => doc.querySelector('[data-wbfav]'))
  btn.click()
  await waitFor(() => listFavorites().length > before)
  await teardown(window, doc)
})

test('设置：改释义语言 → 落库', async () => {
  const { window, doc } = await mount()
  window.location.hash = '#/settings'
  const select = await waitFor(() => doc.querySelector('#set-gloss'))
  await waitFor(() => select.options.length > 0)
  select.value = 'ja'
  select.dispatchEvent(new window.Event('change', { bubbles: true }))
  await waitFor(() => getSettings().gloss_lang === 'ja')
  // 还原，别影响其他用例
  const s = await waitFor(() => doc.querySelector('#set-gloss'))
  s.value = 'zh_CN'
  s.dispatchEvent(new window.Event('change', { bubbles: true }))
  await waitFor(() => getSettings().gloss_lang === 'zh_CN')
  await teardown(window, doc)
})
test('闪卡：释义与例句直接显示（不用点开），只有生词与英文例句有朗读', async () => {
  const m = saveContent({
    title: '闪卡显示测试材料',
    source: 'text',
    sourceUrl: '',
    lang: 'en',
    text: 'The archivist uncovered a peculiar ledger while cataloguing the estate, annotating each entry in a meticulous hand.',
  })
  saveCards(m.content_id, [{
    term: 'peculiar',
    ipa_us: 'pɪˈkjuːliər',
    ipa_uk: 'pɪˈkjuːliə',
    pos: 'adjective',
    definition: '奇怪的；独特的',
    examples: [
      'She noticed a peculiar ledger on the shelf.\n她在书架上注意到一本奇怪的账簿。',
      'The smell was peculiar to this room.\n这种气味是这间屋子特有的。',
    ],
    notes: '常与 smell / habit 搭配',
  }])
  const { window, doc, played, spoken } = await mount()
  window.location.hash = `#/learn?id=${encodeURIComponent(m.content_id)}`
  await waitFor(() => doc.querySelector('#flash'))
  const flash = doc.querySelector('#flash')
  // 释义/例句/备注无需任何点击就可见
  assert.match(flash.textContent, /奇怪的；独特的/)
  assert.match(flash.textContent, /She noticed a peculiar ledger/)
  assert.match(flash.textContent, /这种气味是这间屋子特有的/)
  assert.match(flash.textContent, /常与 smell/)
  assert.ok(!/点击翻转/.test(flash.textContent), '不应再有「点击翻转看释义」')
  // 朗读按钮：生词 1 个 + 每条例句 1 个（只读英文原句，译文不读）
  const speakers = flash.querySelectorAll('[data-tts]')
  assert.equal(speakers.length, 1 + 2)
  assert.equal(flash.querySelectorAll('.examples span [data-tts]').length, 0, '中文译文不该有朗读按钮')
  // 点英文例句：走宿主 edge-tts（/api/tts），不是浏览器语音
  flash.querySelectorAll('.examples [data-tts]')[0].click()
  assert.equal(played.length, 1)
  assert.match(played[0], /^\/seekword\/api\/tts\?/)
  assert.match(played[0], /lang=en/)
  assert.match(played[0], new RegExp(`text=${encodeURIComponent('She noticed a peculiar ledger on the shelf.').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
  assert.equal(spoken.length, 0, '不该退回浏览器语音')
  // 点生词
  flash.querySelector('.flash-top [data-tts]').click()
  assert.equal(played.length, 2)
  assert.match(played[1], new RegExp(`text=${encodeURIComponent('peculiar')}`))
  await teardown(window, doc)
})

test('闪卡：edge-tts 播不出来时回退浏览器语音', async () => {
  const m = saveContent({
    title: '朗读兜底测试材料',
    source: 'text',
    sourceUrl: '',
    lang: 'en',
    text: 'A resilient pipeline tolerates a temporary failure and resumes where it left off in the run cycle.',
  })
  saveCards(m.content_id, [{
    term: 'resilient', ipa_us: 'rɪˈzɪliənt', ipa_uk: 'rɪˈzɪliənt', pos: 'adjective',
    definition: '有韧性的', examples: ['A resilient pipeline tolerates a failure.\n有韧性的流水线能容忍失败。'], notes: '',
  }])
  const { window, doc, spoken } = await mount()
  // 让 Audio 直接拒绝（等同于 /api/tts 502）
  window.Audio = function () {
    this.pause = () => {}
    this.play = () => Promise.reject(new Error('no audio'))
  }
  window.location.hash = `#/learn?id=${encodeURIComponent(m.content_id)}`
  await waitFor(() => doc.querySelector('#flash'))
  doc.querySelector('.flash-top [data-tts]').click()
  await waitFor(() => spoken.length > 0)
  assert.equal(spoken[0].text, 'resilient')
  assert.equal(spoken[0].lang, 'en-US')
  await teardown(window, doc)
})

test('闪卡：点卡片不再翻转（释义恒定可见）', async () => {
  const m = saveContent({
    title: '闪卡点击测试材料',
    source: 'text',
    sourceUrl: '',
    lang: 'en',
    text: 'A resilient pipeline tolerates a temporary failure and resumes where it left off in the run cycle.',
  })
  saveCards(m.content_id, [{
    term: 'resilient', ipa_us: 'rɪˈzɪliənt', ipa_uk: 'rɪˈzɪliənt', pos: 'adjective',
    definition: '有韧性的', examples: ['A resilient pipeline tolerates a failure.\n有韧性的流水线能容忍失败。'], notes: '',
  }])
  const { window, doc } = await mount()
  window.location.hash = `#/learn?id=${encodeURIComponent(m.content_id)}`
  await waitFor(() => doc.querySelector('#flash'))
  const before = doc.querySelector('#flash').textContent
  doc.querySelector('#flash').click()
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(doc.querySelector('#flash').textContent, before, '点卡片不该改变内容')
  assert.match(doc.querySelector('#flash').textContent, /有韧性的/)
  await teardown(window, doc)
})
  test('单词本：每行有朗读与「学会了」，材料来源列被替换掉', async () => {
  const m = saveContent({
    title: '单词本行操作测试',
    source: 'text',
    sourceUrl: '',
    lang: 'en',
    text: 'A resilient pipeline tolerates a temporary failure and resumes where it left off in the run cycle again.',
  })
  saveCards(m.content_id, [{
    term: 'resilient', ipa_us: 'rɪˈzɪliənt', pos: 'adjective',
    definition: '有韧性的', examples: ['A resilient pipeline.\n有韧性的流水线。'], notes: '',
  }])
  const { window, doc, played } = await mount()
  window.location.hash = '#/wordbook'
  const learnBtn = await waitFor(() => doc.querySelector('[data-wblearn="resilient"]'))
  const head = doc.querySelector('#wb-table thead').textContent
  assert.ok(!head.includes('材料'), `表头不该再有材料列：${head}`)
  // 该行有朗读按钮，点了走宿主 edge-tts
  const rowTts = learnBtn.closest('tr').querySelector('[data-tts]')
  assert.ok(rowTts, '该行应有朗读按钮')
  rowTts.click()
  await waitFor(() => played.length > 0)
  assert.match(played[0], /^\/seekword\/api\/tts\?/)
  assert.match(played[0], new RegExp(`text=${encodeURIComponent('resilient')}`))
  // 点「学会了」：该行从单词本消失
  learnBtn.click()
  await waitFor(() => listLearned().some((l) => l.term === 'resilient'))
  await waitFor(() => !doc.querySelector('[data-wblearn="resilient"]'))
  await teardown(window, doc)
})

test('分析走插件独立工作区：草稿带上 workspaceId', async () => {
  const { window, doc, sent } = await mount()
  // /api/workspace 先给出工作区 id
  const ws = await apiFetch('/seekword/api/workspace')
  const wsBody = await ws.json()
  assert.equal(wsBody.ok, true)
  assert.equal(wsBody.workspaceId, 'ws-plugin-1')
  assert.ok(wsBody.path)
  // 点「分析」→ 草稿消息里必须带同一个 id
  await openTab(doc, 'web')
  typeInto(window, doc.querySelector('#cap-url-web'), 'https://example.com/article')
  goBtn(doc, 'web').click()
  await waitFor(() => sent.length > 0)
  assert.equal(sent[0].type, 'seekword:refresh')
  assert.equal(sent[0].workspaceId, 'ws-plugin-1', '草稿应带上插件工作区 id')
  await teardown(window, doc)
})

test('学会了：卡片离开学习与单词本，进「学会了」栏目，撤销能放回', async () => {
  const m = saveContent({
    title: '学会了流程测试',
    source: 'text',
    sourceUrl: '',
    lang: 'en',
    text: 'A peculiar ledger and a meticulous hand were found together in the estate archive last spring.',
  })
  saveCards(m.content_id, [
    { term: 'peculiar', ipa_us: 'pɪˈkjuːliər', pos: 'adjective', definition: '奇怪的', examples: ['A peculiar ledger.\n一本奇怪的账簿。'], notes: '' },
    { term: 'meticulous', ipa_us: 'məˈtɪkjələs', pos: 'adjective', definition: '一丝不苟的', examples: ['A meticulous hand.\n一丝不苟的笔迹。'], notes: '' },
  ])
  const { window, doc } = await mount()
  window.location.hash = `#/learn?id=${encodeURIComponent(m.content_id)}`
  await waitFor(() => doc.querySelector('#flash'))
  assert.equal(doc.querySelector('.flash .term').textContent.trim(), 'peculiar')
  // 点「学会了」：词归档，卡片切换到下一张
  doc.querySelector('#learned-btn').click()
  await waitFor(() => listLearned().some((l) => l.term === 'peculiar'))
  await waitFor(() => doc.querySelector('.flash .term')?.textContent.trim() === 'meticulous')
  // 学习页只剩 1 张卡
  assert.match(doc.querySelector('.learn-bar .idx')?.textContent || '', /1 \/ 1/)
  // 单词本里也不再有它
  const wb = await apiFetch('/seekword/api/cards')
  const rows = (await wb.json()).cards
  assert.ok(!rows.some((c) => c.term === 'peculiar'), '学会了不该留在单词本')
  assert.ok(rows.some((c) => c.term === 'meticulous'))
  // 「学会了」栏目里有它（带快照释义）
  window.location.hash = '#/learned'
  const restoreBtn = await waitFor(() => doc.querySelector('[data-restore="peculiar"]'))
  assert.match(doc.body.textContent, /奇怪的/)
  // 撤销：回到单词本
  restoreBtn.click()
  await waitFor(() => !listLearned().some((l) => l.term === 'peculiar'))
  await waitFor(() => !doc.querySelector('[data-restore="peculiar"]'))
  await teardown(window, doc)
})

test('材料列表：点「① 分析生词」→ 发出带 contentId 的草稿', async () => {
  const withCands = saveContent({
    title: '面板流程测试材料',
    source: 'text',
    sourceUrl: '',
    lang: 'en',
    text: 'The archivist uncovered a peculiar ledger while cataloguing the estate. Every entry was annotated in a meticulous hand.',
  })
  saveCandidates(withCands.content_id, [{ term: 'peculiar', type: 'word' }])
  // 没有候选的材料 = 待分析状态，会出「① 分析生词」按钮
  const fresh = saveContent({
    title: '未分析材料',
    source: 'text',
    sourceUrl: '',
    lang: 'en',
    text: 'A sentence long enough to pass the minimum length check for capture while testing the analyze button.',
  })
  const { window, doc, sent } = await mount()
  await waitFor(() => doc.querySelector(`button[data-act="analyze"][data-id="${fresh.content_id}"]`))
  doc.querySelector(`button[data-act="analyze"][data-id="${fresh.content_id}"]`).click()
  await waitFor(() => sent.length > 0)
  assert.match(sent[0].prompt, new RegExp(fresh.content_id))
  assert.match(sent[0].prompt, /action="read"/)
  await teardown(window, doc)
})
