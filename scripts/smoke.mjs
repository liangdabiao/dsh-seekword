// 冒烟测试（离线）：假 YouTube InnerTube 服务器 + 假网页服务器 + 工具直调全链路 + 面板 API 全路由。
// 运行：npm run smoke
const { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync, statSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const { join } = await import('node:path')
const http = await import('node:http')

const tmp = mkdtempSync(join(tmpdir(), 'dsh-seekword-smoke-'))
process.env.DSH_HOME = tmp
delete process.env.SEEKWORD_PROXY

let failed = 0
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
  if (!cond) failed++
}

// ── 假 YouTube：InnerTube /player（ios 客户端带字幕轨）+ timedtext json3 ──
const TRANSCRIPT = [
  'The catastrophic failure taught us a valuable lesson about redundancy.',
  'Engineers scrutinized every component, yet the culprit was a ubiquitous sensor.',
  'Resilience matters more than perfection in distributed systems.',
  'We brainstormed relentlessly and finally mitigated the bottleneck.',
  'This ubiquitous pattern recurs throughout the industry.',
].join('\n')

const json3 = {
  events: TRANSCRIPT.split('\n').map((line) => ({ segs: [{ utf8: line }] })),
}
const TIMEDTEXT_URL = `/api/timedtext?v=abc12345678&lang=en&fmt=json3`

const srv = http.createServer((req, res) => {
  const reply = (obj, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
  const url = new URL(req.url, 'http://x')
  if (url.pathname === '/youtubei/v1/player' || url.pathname === '/youtubei/v1/next' || url.pathname === '/youtubei/v1/get_transcript') {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
      const client = body?.context?.client?.clientName
      if (body.videoId === 'novideo0000') return reply({ playabilityStatus: { status: 'ERROR' } })
      if (url.pathname.endsWith('/player')) {
        // ios 第一个客户端成功并带字幕轨；android_vr 只回 OK 无轨（测降级诊断）
        if (client === 'ANDROID_VR') return reply({ playabilityStatus: { status: 'OK' } })
        reply({
          playabilityStatus: { status: 'OK' },
          videoDetails: { title: 'Smoke Test Video' },
          captions: { playerCaptionsTracklistRenderer: { captionTracks: [
            { baseUrl: `http://127.0.0.1:${srv.address().port}${TIMEDTEXT_URL}`, name: { simpleText: 'English' }, languageCode: 'en', kind: 'asr' },
            { baseUrl: `http://127.0.0.1:${srv.address().port}/api/timedtext?v=abc12345678&lang=en&tlang=zh`, name: { simpleText: '中文（自动翻译）' }, languageCode: 'en' },
          ] } },
        })
      } else {
        reply({ engagementPanels: [] })
      }
    })
    return
  }
  if (url.pathname === '/api/timedtext') {
    if (url.searchParams.get('tlang')) { res.writeHead(200, { 'content-type': 'text/vtt' }); res.end('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n翻译轨不该被选中'); return }
    if (url.searchParams.get('fmt') === 'json3') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(json3)); return }
    res.writeHead(200, { 'content-type': 'text/vtt' }); res.end('WEBVTT')
    return
  }
  if (url.pathname === '/article') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(`<!doctype html><html><head><title>Resilience in Systems</title></head><body>
      <nav><a href="#">Home</a><a href="#">Archive</a></nav>
      <article><h1>Resilience</h1>
      <p>The architecture suffered a catastrophic outage last spring. Engineers scrutinized the logs and found a ubiquitous race condition.</p>
      <p>They mitigated it with backpressure, brainstormed a fix, and the system recovered. Resilience, not perfection.</p>
      <p>The bottleneck was mitigated by shrinking batch sizes; throughput doubled.</p>
      </article>
      <footer>© 2026 Smoke</footer></body></html>`)
    return
  }
  reply({ error: 'not found' }, 404)
})
await new Promise((r) => srv.listen(0, '127.0.0.1', r))
const PORT = srv.address().port
process.env.SEEKWORD_YT_API = `http://127.0.0.1:${PORT}/youtubei/v1`

// ── 工具直调 ──
const { seekwordTool } = await import('../src/host.js')
const call = async (args) => {
  try { return await seekwordTool.execute(args, {}) } catch (e) { return { ok: false, summary: String(e?.message || e) } }
}
const out = (r) => `${r.summary || ''}${r.data ? `\n${r.data}` : ''}`

let contentId = ''
let contentId2 = ''
{
  // capture text
  const r = await call({ action: 'capture', source: 'text', textContent: TRANSCRIPT, title: '冗余教训' })
  check('capture text 入库', r.ok && out(r).includes('contentId='), r.summary)
  contentId = (r.summary.match(/（contentId=([^）]+)）/) || [])[1]

  // capture youtube（假服务器）
  const ry = await call({ action: 'capture', source: 'youtube', url: 'https://www.youtube.com/watch?v=abc12345678' })
  check('capture youtube 抓字幕（选非翻译轨）', ry.ok && (ry.data || '').includes('catastrophic') && !(ry.data || '').includes('不该被选中'), (ry.data || '').slice(0, 60))
  const ymeta = ry.footer.match(/《(.+)》/) || []
  check('capture youtube 标题来自 player', ymeta[1] === 'Smoke Test Video', ymeta[1])

  // capture youtube 失败诊断（假服务器对该 videoId 全客户端回 ERROR）
  const rn = await call({ action: 'capture', source: 'youtube', url: 'novideo0000' })
  check('capture youtube 无字幕报诊断', !rn.ok && rn.summary.includes('诊断'), rn.summary.slice(0, 80))

  // capture web（假网页）
  const rw = await call({ action: 'capture', source: 'web', url: `http://127.0.0.1:${PORT}/article` })
  check('capture web 正文提取（剥 nav/footer）', rw.ok && (rw.data || '').includes('catastrophic outage') && !(rw.data || '').includes('Archive'), (rw.summary || '').slice(0, 50))
  contentId2 = (rw.summary.match(/（contentId=([^）]+)）/) || [])[1]

  // capture 校验
  const rshort = await call({ action: 'capture', source: 'text', textContent: '短' })
  check('capture 拒绝过短文本', !rshort.ok, rshort.summary)
  const rbad = await call({ action: 'capture', source: 'nope' })
  check('capture 未知来源拒绝', !rbad.ok && (rbad.summary.includes('未知来源') || rbad.summary.includes('只能是')), rbad.summary)
  const rnoargs = await call({ action: 'capture', source: 'text', extra: 1 })
  check('未知参数拒绝', !rnoargs.ok && rnoargs.summary.includes('未知参数'), rnoargs.summary)
}
{
  // read
  const r = await call({ action: 'read', contentId })
  check('read 分段读原文', r.ok && r.data.includes('catastrophic'), '')
  const r2 = await call({ action: 'read', contentId, offset: 99999 })
  check('read 越界提示', !r2.ok && r2.summary.includes('超出'), r2.summary)
}
{
  // save_candidates：含噪声词 + 未命中词
  const r = await call({ action: 'save_candidates', contentId, terms: [
    { term: 'catastrophic', type: 'word' },
    { term: 'scrutinized', type: 'word' },
    { term: 'ubiquitous', type: 'word' },
    { term: '123456', type: 'word' },           // 纯数字：机械丢弃
    { term: 'notinthetext', type: 'word' },     // 未命中：warn
    { term: 'catastrophic', type: 'word' },     // 重复
    { term: 'mitigated the bottleneck', type: 'phrase' },
  ] })
  check('save_candidates 清洗入库', r.ok && (r.data || '').split('\n').length === 5, (r.data || '').split('\n').length + '')
  check('save_candidates 未命中 warn', r.summary.includes('未在原文找到'), '')
  check('save_candidates 纯数字丢弃', !(r.data || '').includes('123456'), '')
}
{
  // save_cards：IPA 规则/例句两行/POS 映射/对齐补位
  const r = await call({ action: 'save_cards', contentId, selected: ['catastrophic', 'scrutinized', 'ubiquitous', 'ghostword'], cards: [
    { term: 'catastrophic', ipa_us: '/ˌkætəˈstrɑːfɪk/', ipa_uk: '/ˌkætəˈstrɒfɪk/', pos: 'adjective',
      definition: '灾难性的；造成重大损失的', examples: ['a catastrophic failure\n一场灾难性的故障'], notes: '常与 failure/loss 搭配' },
    { term: 'scrutinized', pos: 'verb', definition: '仔细检查；细看',
      examples: ['- Engineers scrutinized the logs\n- 工程师们仔细检查了日志'], reading: 'should-be-cleared-for-en' },
    { term: 'ubiquitous', ipa_us: '/juːˈbɪkwɪtəs/', pos: 'adjective', definition: '无处不在的', examples: ['a ubiquitous sensor\n一个无处不在的传感器'] },
    { term: '', definition: '缺 term 应被丢弃' },
  ] })
  check('save_cards 对齐 selected（选4得4）', r.ok && (r.data || '').split('\n').length === 4, (r.data || '').split('\n').length + '')
  check('save_cards 缺词补 insufficient_context', (r.data || '').includes('insufficient_context'), '')
  check('save_cards 未命中 warn 如实', r.summary.includes('ghostword') && r.summary.includes('没有对应卡片'), '')
  check('save_cards 缺 term 丢弃 warn', r.summary.includes('缺 term'), '')

  const wbr = await call({ action: 'wordbook', limit: 10 })
  check('wordbook 查卡片', wbr.ok && (wbr.data || '').includes('catastrophic'), '')

  // 规则校验：读回卡片
  const { getCards, getMeta } = await import('../lib/store.js')
  const meta = getMeta(contentId)
  const cards = getCards(contentId)
  const cat = cards.find((c) => c.term === 'catastrophic')
  const scr = cards.find((c) => c.term === 'scrutinized')
  check('IPA 规则：en 主音标跟随 accent(默认us) + 去包裹斜杠', cat.ipa === 'ˌkætəˈstrɑːfɪk' && cat.ipa_us === 'ˌkætəˈstrɑːfɪk' && cat.ipa_uk === 'ˌkætəˈstrɒfɪk', cat.ipa)
  check('IPA 规则：en reading 清空', !scr.reading, scr.reading)
  check('例句两行规范化（列表符号剥离）', scr.examples[0] && scr.examples[0].split('\n').length === 2 && !scr.examples[0].startsWith('-'), JSON.stringify(scr.examples))
  check('POS 中文映射（zh 释义时 adjective→形容词）', cat.pos === '形容词', cat.pos)
  check('meta card_count 更新（3 实卡 + 1 占位）', meta.card_count === 4, String(meta.card_count))

  // 重复 save_cards 合并去重
  const r2 = await call({ action: 'save_cards', contentId, cards: [{ term: 'catastrophic', definition: '重复卡' }] })
  check('重复制卡合并去重', r2.ok && r2.summary.includes('重复') && getCards(contentId).length === 4, r2.summary)
}
{
  // favorite / export / stats / list / delete
  const rf = await call({ action: 'favorite', contentId, term: 'catastrophic' })
  check('favorite 收藏', rf.ok && rf.summary.includes('已收藏'), rf.summary)
  const rf2 = await call({ action: 'favorite', contentId, term: 'catastrophic' })
  check('favorite 取消收藏', rf2.ok && rf2.summary.includes('取消'), rf2.summary)
  await call({ action: 'favorite', contentId, term: 'catastrophic' })

  const re = await call({ action: 'export', contentId })
  const csvPath = re.summary.match(/→ (.+?\.csv)/)?.[1] || ''
  check('export CSV 落盘', re.ok && csvPath && existsSync(csvPath), re.summary)
  const ref = await call({ action: 'export', favorites: 'true' })
  check('export 收藏 CSV', ref.ok && ref.summary.includes('收藏'), ref.summary)
  const csv = readFileSync(csvPath, 'utf8')
  check('CSV 带 BOM + 例句两行保留', csv.startsWith('\ufeff') && csv.includes('"a catastrophic failure'), csv.slice(0, 40))

  const rs = await call({ action: 'stats' })
  check('stats 总览', rs.ok && rs.summary.includes('单词本总览'), rs.summary)
  const rl = await call({ action: 'list' })
  check('list 材料列表', rl.ok && (rl.data || '').split('\n').length >= 2, '')
  const rdel = await call({ action: 'delete', contentId: contentId2 })
  check('delete 材料', rdel.ok, rdel.summary)
  const rdel2 = await call({ action: 'delete', contentId: contentId2 })
  check('delete 不存在记录拒绝', !rdel2.ok, rdel2.summary)
}

// ── 面板 API ──
const { registerApi } = await import('../lib/api.js')
const { Writable } = await import('node:stream')
const { EventEmitter } = await import('node:events')
// 选文件对话框与 edge-tts 都不真跑：注入桩，只验路由与回执归一
let fakePick = { ok: true, path: 'D:\\资料\\article.pdf' }
const ttsFile = join(tmp, 'smoke-tts.mp3')
writeFileSync(ttsFile, Buffer.from('ID3-fake'))
let fakeTts = { ok: true, file: ttsFile, cached: true }
const ttsCalls = []
const routes = {}
registerApi({ get: () => undefined, webServer: { register: (r) => { routes[r.path] = r.handler } } },
  { config: {}, picker: async () => fakePick, tts: async (args) => { ttsCalls.push(args); return fakeTts } })
const req = async (method, path, body) => {
  const reqObj = new EventEmitter()
  reqObj.method = method
  reqObj.url = `/seekword${path}`
  reqObj.headers = body ? { 'content-type': 'application/json', host: 'x', origin: 'http://x' } : { host: 'x' }
  const chunks = []
  const resObj = new Writable({ write(c, _e, cb) { chunks.push(c); cb() } })
  resObj.statusCode = 0
  resObj.writeHead = (code) => { resObj.statusCode = code }
  const done = new Promise((resolve) => {
    const origEnd = resObj.end.bind(resObj)
    resObj.end = (...args) => { origEnd(...args); resolve({ status: resObj.statusCode, json: (() => { try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return null } })(), text: () => Buffer.concat(chunks).toString('utf8') }) }
  })
  const p = routes['/seekword'](reqObj, resObj)
  if (body) reqObj.emit('data', Buffer.from(JSON.stringify(body)))
  reqObj.emit('end')
  await p
  return done
}
{
  const cat = await req('GET', '/api/catalog')
  check('catalog：统计/材料/设置', cat.status === 200 && cat.json.stats && cat.json.contents.length >= 1 && cat.json.settings.gloss_lang === 'zh_CN', '')
  check('catalog 暴露选文件能力', typeof cat.json.capabilities?.pickFile === 'boolean', '')
  const one = await req('GET', `/api/contents/${contentId}`)
  check('内容详情带 candidates+cards+favorites', one.status === 200 && one.json.candidates.length === 5 && one.json.cards.length === 4 && one.json.favorites.includes('catastrophic'), '')

  const fav = await req('POST', '/api/favorite', { content_id: contentId, term: 'scrutinized' })
  check('面板收藏切换', fav.status === 200 && fav.json.ok && fav.json.favorited, '')
  const cardsFav = await req('GET', '/api/cards?fav=1')
  check('收藏视图（含纯词名收藏）', cardsFav.status === 200 && cardsFav.json.cards.some((c) => c.favorite), '')
  const cardsQ = await req('GET', '/api/cards?q=catast')
  check('卡片搜索', cardsQ.status === 200 && cardsQ.json.cards.length === 1, '')

  const st = await req('POST', '/api/settings', { gloss_lang: 'en', accent: 'uk', proxy_url: 'http://127.0.0.1:7890' })
  check('settings 保存 en/uk/代理', st.status === 200 && st.json.settings.gloss_lang === 'en' && st.json.settings.accent === 'uk' && st.json.settings.proxy_url.includes('7890'), '')
  const bad = await req('POST', '/api/settings', { gloss_lang: 'xx' })
  check('settings 非法语言拒绝', bad.status === 400, '')
  const restore = await req('POST', '/api/settings', { gloss_lang: 'zh_CN', accent: 'us', proxy_url: '' })
  check('settings 还原', restore.status === 200, '')

  const csv = await req('GET', `/api/export?content_id=${contentId}`)
  check('面板 CSV 导出', csv.status === 200 && csv.text().startsWith('\ufeff') && csv.text().includes('catastrophic'), '')
  const csv404 = await req('GET', `/api/export?content_id=nonexist-xxx`)
  check('导出不存在的材料 404', csv404.status === 404, '')

  // 学会了：卡片离开单词本与材料详情（学习页），进「学会了」栏目；撤销可恢复
  const learnResp = await req('POST', '/api/learned', { content_id: contentId, term: 'catastrophic' })
  check('标记学会了', learnResp.status === 200 && learnResp.json.ok && learnResp.json.learned === true, '')
  const wbAfter = await req('GET', '/api/cards')
  check('学会了不再出现在单词本', wbAfter.status === 200 && !wbAfter.json.cards.some((c) => c.term === 'catastrophic'), '')
  const detailAfter = await req('GET', `/api/contents/${contentId}`)
  check('学会了不再出现在学习页卡片', !detailAfter.json.cards.some((c) => c.term === 'catastrophic'), '')
  const learnedList = await req('GET', '/api/learned')
  check('「学会了」栏目能查到该词并带快照',
    learnedList.status === 200 && learnedList.json.learned.some((l) => l.term === 'catastrophic' && l.snapshot && l.snapshot.definition), '')
  const catAfter = await req('GET', '/api/catalog')
  check('总览：学习卡片排除已学会 + 学会计数',
    catAfter.json.stats.learned >= 1 && catAfter.json.stats.cards === wbAfter.json.cards.length,
    `cards=${catAfter.json.stats.cards} learned=${catAfter.json.stats.learned}`)
  const restoreLearned = await req('POST', '/api/learned/remove', { term: 'catastrophic' })
  check('撤销学会了', restoreLearned.status === 200 && restoreLearned.json.restored === true, '')
  const wbBack = await req('GET', '/api/cards')
  check('撤销后回到单词本', wbBack.json.cards.some((c) => c.term === 'catastrophic'), '')
  const learnNoTerm = await req('POST', '/api/learned', { content_id: contentId })
  check('学会了缺 term → 400', learnNoTerm.status === 400, '')

  const open = await req('POST', '/api/open', { url: 'http://127.0.0.1/x' })
  check('open 拒绝本机地址', open.status === 400, '')

  // 选文件：只回绝对路径（不读文件内容），取消/不支持都按「不是失败」处理
  fakePick = { ok: true, path: 'D:\\资料\\article.pdf' }
  const pick = await req('POST', '/api/pick', { title: '选择要学的文件' })
  check('选文件回绝对路径 + exists 标记',
    pick.status === 200 && pick.json.ok && pick.json.path === 'D:\\资料\\article.pdf' && typeof pick.json.exists === 'boolean', pick.json?.path || '')
  fakePick = { ok: false, cancelled: true }
  const pickCancel = await req('POST', '/api/pick', {})
  check('选文件取消：ok=false + cancelled', pickCancel.status === 200 && pickCancel.json.ok === false && pickCancel.json.cancelled === true, '')
  fakePick = { ok: false, error: '当前系统暂不支持弹窗选文件，请直接填写文件路径' }
  const pickBad = await req('POST', '/api/pick', {})
  check('选文件不支持：错误文案原样回给页面', pickBad.status === 200 && pickBad.json.ok === false && pickBad.json.error.includes('不支持'), '')
  fakePick = { ok: true, path: 'D:\\资料\\article.pdf' }

  // 朗读：edge-tts 合成结果（注入桩，不真跑 python）
  ttsCalls.length = 0
  const ttsOk = await req('GET', '/api/tts?text=resilient&lang=en&accent=uk')
  check('朗读走 edge-tts 路由：回 mp3 字节', ttsOk.status === 200 && ttsOk.text() === 'ID3-fake', `status=${ttsOk.status}`)
  check('朗读把语言与口音透传给合成器',
    ttsCalls[0]?.text === 'resilient' && ttsCalls[0]?.lang === 'en' && ttsCalls[0]?.accent === 'uk',
    JSON.stringify(ttsCalls[0] || {}))
  fakeTts = { ok: false, status: 502, error: 'edge-tts 合成超时' }
  const ttsBad = await req('GET', '/api/tts?text=resilient')
  check('朗读失败回 502（面板据此回退浏览器语音）', ttsBad.status === 502 && /超时/.test(ttsBad.json?.error || ''), '')
  fakeTts = { ok: false, status: 400, error: '没有要朗读的文本' }
  const ttsEmpty = await req('GET', '/api/tts?text=')
  check('朗读空文本 400', ttsEmpty.status === 400, '')
  fakeTts = { ok: true, file: ttsFile, cached: true }

  // 独立工作区：目录建好并回给面板（本进程没有 workspaceRegistry，workspaceId 为空 = 退回当前工作区）
  const ws = await req('GET', '/api/workspace')
  const wsDir = ws.json?.path || ''
  check('独立工作区：返回目录并确保存在',
    ws.status === 200 && ws.json.ok && wsDir.length > 0 && existsSync(wsDir),
    wsDir)
  check('独立工作区：没有 registry 时不编造 workspaceId', ws.json.workspaceId === '', JSON.stringify(ws.json))
  const wsStat = statSync(wsDir)
  check('独立工作区：确实是目录', wsStat.isDirectory(), '')

  const page = await req('GET', '/')
  check('面板首页可访问', page.status === 200 && page.text().includes('app.js'), '')
  const appjs = await req('GET', '/app.js')
  check('app.js/scheme.js 静态可达', appjs.status === 200 && appjs.text().includes('seekword:refresh'), '')
  const trav = await req('GET', '/..%2f..%2fpackage.json')
  check('路径穿越拦截', trav.status === 404, '')
  const appjsFile = readFileSync(new URL('../lab/app.js', import.meta.url), 'utf8')
  const clientFile = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  check('lab 消息类型与 client 对齐', appjsFile.includes('seekword:refresh') && clientFile.includes('seekword:refresh') && appjsFile.includes('seekword:start-ok') && clientFile.includes('seekword:start-ok'), '')
  check('面板主入口齐备（4渠道+执行按钮+2s轮询）',
    appjsFile.includes("['file', '📁 选择文件']") && appjsFile.includes('粘贴文本') && appjsFile.includes('YouTube') && appjsFile.includes('网页')
    && appjsFile.includes('① 分析生词') && appjsFile.includes('② 生成卡片') && appjsFile.includes('class="primary cap-go"')
    && appjsFile.includes('setInterval(pollOnce, 2000)') && appjsFile.includes('startWaiting'),
    '')
  check('独立工作区接线：面板带 workspaceId、client 用它开对话',
    appjsFile.includes('/api/workspace') && appjsFile.includes('workspaceId')
    && clientFile.includes('m.workspaceId') && clientFile.includes('startSession(workspaceId'),
    '')
  // 导入区要极简：一个输入 + 一个「分析」按钮，没有标题输入、没有说明段落
  check('导入区极简（无标题输入/无说明段落）',
    !appjsFile.includes('cap-title') && !appjsFile.includes('id="cap-pick-hint">面板')
    && (appjsFile.match(/class="primary cap-go"/g) || []).length === 4,
    '')
  const capRoute = await req('POST', '/api/capture', { source: 'text', text: 'hello world' })
  check('面板不再提供 /api/capture（入库归 agent）', capRoute.status === 404, '')
  // 导入区四个渠道必须是纯交接：面板只把材料线索写进草稿交给 agent
  check('导入区四个渠道都只做交接',
    appjsFile.includes("apiPost('/api/pick'") && appjsFile.includes('importFilePrompt')
    && appjsFile.includes('importTextPrompt') && appjsFile.includes('importUrlPrompt')
    && appjsFile.includes('source="file"') && appjsFile.includes('source="text"')
    && appjsFile.includes('source="${kind}"') && appjsFile.includes('startWatchingNew')
    && !appjsFile.includes('cap-file-input') && !appjsFile.includes('blob.text()') && !appjsFile.includes('getPathForFile')
    && !appjsFile.includes("apiPost('/api/capture'"),
    '')
}

srv.close()
rmSync(tmp, { recursive: true, force: true })
console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
process.exit(failed ? 1 : 0)
