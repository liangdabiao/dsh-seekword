// 捕获生词 · 面板逻辑：导入区（4 渠道+执行按钮）/ 学习（材料状态机：①分析→②制卡→③闪卡）/ 单词本 / 设置。
// 「分析生词」「生成卡片」走 agent：嵌入 dsh → postMessage（client.js startSession 填草稿不自动发送）；
// 独立浏览器预览 → 复制提示词。点按钮后面板每 2 秒轻量轮询，agent 入库自动刷新视图。
(() => {
  const $app = document.getElementById('app')
  const $toast = document.getElementById('toast')
  const EMBEDDED = (() => { try { return window.parent !== window } catch { return false } })()

  const state = {
    catalog: null,
    view: 'home',
    learn: null,        // { id, meta, sourceText, candidates, cards, favorites, idx, flipped, grid }
    wb: { q: '', fav: false, source: '', cards: [], total: 0 },
    capture: { tab: 'file', file: null },
    waiting: null,      // { contentId, title, baseline:{cand,cards}, since }
  }
  let pollTimer = null
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

  async function api(path) {
    const res = await fetch(`/seekword${path}`)
    const body = await res.json().catch(() => ({}))
    if (!res.ok) {
      const err = new Error(body.error || `HTTP ${res.status}`)
      err.status = res.status
      throw err
    }
    return body
  }
  async function apiPost(path, payload) {
    const res = await fetch(`/seekword${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload || {}),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`)
    return body
  }
  async function apiDelete(path) {
    const res = await fetch(`/seekword${path}`, { method: 'DELETE' })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`)
    return body
  }

  // 打开外部链接：桌面端 iframe 里 window.open 会被 WebContentsView deny，
  // 先请宿主用系统默认浏览器打开；宿主不支持（网页版/无桌面）时退回新窗口。
  async function openLink(u) {
    if (!u || u === '#' || u === 'about:blank') return
    try {
      const r = await apiPost('/api/open', { url: u })
      if (r?.ok) { toast('已在系统浏览器打开'); return }
      throw new Error(r?.error || '打开失败')
    } catch (e) {
      const win = window.open(u, '_blank', 'noopener')
      if (!win) {
        const hint = /404|not found/i.test(String(e.message))
          ? '宿主还没重启（/api/open 未上线），重启 dsh 后就能用系统浏览器打开'
          : e.message
        toast(`打不开：${hint}`)
      }
    }
  }

  let toastTimer = null
  function toast(msg) {
    $toast.textContent = msg
    $toast.classList.add('show')
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => $toast.classList.remove('show'), 3200)
  }

  const SRC_LABEL = { text: '粘贴', youtube: 'YouTube', web: '网页', file: '文件' }
  const GLOSS = [
    ['zh_CN', '简体中文'], ['zh_TW', '繁體中文'], ['en', 'English'], ['ja', '日本語'],
    ['ko', '한국어'], ['ru', 'Русский'], ['fr', 'Français'], ['de', 'Deutsch'], ['es', 'Español'],
  ]
  const TTS_LANG = { en: 'en-US', zh_CN: 'zh-CN', zh_TW: 'zh-TW', ja: 'ja-JP', ko: 'ko-KR', ru: 'ru-RU', fr: 'fr-FR', de: 'de-DE', es: 'es-ES' }

  // ── 材料状态机：imported(待分析) → candidates(待制卡) → cards(可学习) ──
  function nextStepOf(m) {
    if ((m.card_count || 0) > 0) return 'cards'
    if ((m.candidate_count || 0) > 0) return 'candidates'
    return 'imported'
  }
  const STEP_META = {
    imported: { label: '待分析', btn: '① 分析生词', act: 'analyze', cls: 'primary' },
    candidates: { label: '待制卡', btn: '② 选词制卡', act: 'make', cls: 'primary' },
    cards: { label: '可学习', btn: '去学习', act: 'learn', cls: '' },
  }

  // ── agent 提示词与交接 ────────────────────────────────────────────────
  function analyzePrompt(m, maxCards) {
    return `给《${m.title}》分析生词（contentId=${m.content_id}）。\n` +
      `请按 seekword 技能执行：用 seekword(action="read", contentId="${m.content_id}") 分段通读原文 → ` +
      `按筛选规则挑最多 ${maxCards || 30} 个高价值生词（term 必须是原文表面形式，宁缺毋滥）→ ` +
      `seekword(action="save_candidates", contentId="${m.content_id}", terms=[...]) 入库 → 给我候选词清单。`
  }
  function makeCardsPrompt(m, terms) {
    return `给《${m.title}》生成学习卡片（contentId=${m.content_id}）。\n` +
      `用户选定了这些候选词：${terms.join('、')}。\n` +
      `请按 seekword 技能的制卡规则，为每个词生成卡片（发音/词性/贴合原文语境的释义/两组双语例句/语法备注），` +
      `然后调 seekword(action="save_cards", contentId="${m.content_id}", cards=[...], selected=[...]) 入库，最后按技能输出规则给出卡片清单。`
  }
  async function handToAgent(prompt, waitingId, waitingTitle) {
    if (EMBEDDED) {
      try {
        window.parent.postMessage({ type: 'seekword:refresh', prompt }, location.origin)
        toast('已交给对话：草稿已填入，点「发送」后 agent 开始（面板每 2 秒自动检查入库）')
      } catch {
        try { await navigator.clipboard.writeText(prompt); toast('交给对话失败：提示词已复制，请粘贴发送') } catch { toast('交给对话失败') }
      }
    } else {
      try { await navigator.clipboard.writeText(prompt); toast('独立预览模式：提示词已复制，去对话粘贴后发送') } catch { toast('复制失败：请手动复制提示词') }
    }
    if (waitingId) startWaiting(waitingId, waitingTitle)
  }

  // ── 等待 agent：2s 轻量轮询 catalog，入库自动刷新 ─────────────────────
  function startWaiting(contentId, title) {
    const m = state.catalog?.contents.find((x) => x.content_id === contentId)
    stopWaiting()
    state.waiting = {
      contentId,
      title: title || m?.title || '',
      baseline: { cand: m?.candidate_count || 0, cards: m?.card_count || 0 },
      since: Date.now(),
    }
    pollTimer = setInterval(pollOnce, 2000)
    paintWaitingBar()
  }
  function stopWaiting() {
    if (pollTimer) clearInterval(pollTimer)
    pollTimer = null
    state.waiting = null
  }
  async function pollOnce() {
    if (!state.waiting) return
    try {
      const c = await api('/api/catalog')
      state.catalog = c
      paintCounts()
      const mm = c.contents.find((x) => x.content_id === state.waiting?.contentId)
      if (!mm) return
      const grown = (mm.candidate_count || 0) > state.waiting.baseline.cand
        || (mm.card_count || 0) > state.waiting.baseline.cards
      if (grown) {
        const refreshView = state.view
        stopWaiting()
        toast('agent 已入库，视图已刷新')
        if (refreshView === 'learn') await renderLearn(mm.content_id)
        else if (refreshView === 'home') await renderHome()
        paintWaitingBar()
      } else if (Date.now() - state.waiting.since > 120000) {
        stopWaiting()
        toast('等待超时（2 分钟无入库）：agent 可能还没跑完，完成后点材料上的执行按钮即可')
        paintWaitingBar()
      }
    } catch { /* 网络抖动忽略，下一轮再试 */ }
  }
  function paintWaitingBar() {
    const slot = document.getElementById('waiting-slot')
    if (!slot) return
    slot.innerHTML = state.waiting ? `
      <div class="waiting-bar" id="waiting-bar">
        <span class="spin">⏳</span>
        <span>等待 agent 入库：<b>${esc(state.waiting.title)}</b>（每 2 秒自动检查）</span>
        <button class="ghost" id="waiting-cancel">取消等待</button>
      </div>` : ''
    document.getElementById('waiting-cancel')?.addEventListener('click', () => {
      stopWaiting()
      paintWaitingBar()
      toast('已取消自动检查（agent 入库后手动点材料按钮即可）')
    })
  }

  // ── TTS（浏览器语音，本地合成） ────────────────────────────────────────
  function speak(text, lang) {
    try {
      if (!('speechSynthesis' in window)) return toast('当前环境不支持语音合成')
      speechSynthesis.cancel()
      const u = new SpeechSynthesisUtterance(String(text || '').slice(0, 120))
      const tag = TTS_LANG[lang] || ''
      if (tag) u.lang = tag
      const voices = speechSynthesis.getVoices()
      const v = voices.find((x) => x.lang === tag) || voices.find((x) => x.lang?.startsWith(tag.slice(0, 2)))
      if (v) u.voice = v
      u.rate = 0.95
      speechSynthesis.speak(u)
    } catch { /* 静默：朗读是增强功能 */ }
  }

  // ── 路由 ───────────────────────────────────────────────────────────────
  async function route() {
    const hash = location.hash || '#/'
    const [pathPart, queryPart] = hash.slice(1).split('?')
    const query = new URLSearchParams(queryPart || '')
    const view = (pathPart === '/' || pathPart === '') ? 'home' : pathPart.slice(1)
    state.view = view
    if (view === 'wordbook' || view === 'settings') stopWaiting()
    for (const a of document.querySelectorAll('.nav a')) a.classList.toggle('active', a.dataset.view === view)
    try {
      if (view === 'learn') await renderLearn(query.get('id'))
      else if (view === 'wordbook') await renderWordbook()
      else if (view === 'settings') renderSettings()
      else await renderHome()
      paintWaitingBar()
    } catch (e) {
      $app.innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`
    }
  }

  async function loadCatalog(force = false) {
    if (!state.catalog || force) state.catalog = await api('/api/catalog')
    paintCounts()
    return state.catalog
  }

  function paintCounts() {
    const c = state.catalog
    if (!c) return
    const map = { contents: c.stats.contents, cards: c.stats.cards, favorites: c.stats.favorites }
    for (const el of document.querySelectorAll('[data-count]')) el.textContent = map[el.dataset.count] ?? ''
  }

  // ── 概览：导入区（4 渠道）+ 材料列表（状态机执行按钮） ─────────────────
  async function renderHome() {
    const cat = await loadCatalog(true)
    const s = cat.stats
    const contents = cat.contents || []
    const tab = state.capture.tab

    const TABS = [
      ['file', '📁 选择文件'],
      ['text', '粘贴文本'],
      ['youtube', 'YouTube'],
      ['web', '网页'],
    ]
    $app.innerHTML = `
      <h1>捕获生词</h1>
      <p class="sub">导入 → 点「① 分析生词」交给 agent 筛选制卡 → 面板翻卡复习。数据目录 <span class="mono">${esc(cat.dataDir)}</span></p>
      <div id="waiting-slot"></div>
      <div class="grid2">
        <div class="card stat"><div class="num">${s.contents}</div><div class="lbl">捕获材料</div></div>
        <div class="card stat"><div class="num">${s.cards}</div><div class="lbl">学习卡片</div></div>
        <div class="card stat"><div class="num">${s.favorites}</div><div class="lbl">收藏生词</div></div>
        <div class="card stat"><div class="num">${latestLabel(contents[0])}</div><div class="lbl">最近材料</div></div>
      </div>

      <h2>导入内容</h2>
      <div class="card">
        <div class="tabs" id="cap-tabs">
          ${TABS.map(([t, n]) => `<button data-tab="${t}" class="${tab === t ? 'on' : ''}">${n}</button>`).join('')}
        </div>
        <div class="field ${tab === 'file' ? '' : 'hide'}" data-field="file">
          <input type="file" id="cap-file-input" accept=".txt,.md,.srt,.vtt,.json3,.json,text/plain" style="display:none">
          <div class="row">
            <button id="cap-pick">选择文件…</button>
            <span class="muted" style="font-size:12px">支持 txt / md / srt / vtt / json3 字幕与文本</span>
          </div>
          <div id="cap-file-chip" style="margin-top:8px"></div>
        </div>
        <div class="field ${tab === 'text' ? '' : 'hide'}" data-field="text">
          <label>原文（粘贴任意语言文本）</label>
          <textarea id="cap-text" placeholder="粘贴要学的文章/字幕/段落……"></textarea>
        </div>
        <div class="field ${tab === 'youtube' ? '' : 'hide'}" data-field="youtube">
          <label>YouTube 视频链接或 videoId（自动抓字幕，多客户端降级；国内网络可在设置页配代理）</label>
          <input id="cap-url" style="width:100%" placeholder="https://www.youtube.com/watch?v=...">
        </div>
        <div class="field ${tab === 'web' ? '' : 'hide'}" data-field="web">
          <label>网页链接（http/https，自动提取正文）</label>
          <input id="cap-url" style="width:100%" placeholder="https://example.com/article">
        </div>
        <div class="row" style="margin-top:10px">
          <input id="cap-title" placeholder="标题（可留空自动取）" style="flex:1;min-width:180px">
          <button class="primary" id="cap-go">导入</button>
        </div>
        <div class="muted" style="font-size:12px;margin-top:6px">导入后自动跳到「学习」页，点「① 分析生词」交给 agent 筛选制卡。</div>
      </div>

      <h2>材料列表<span class="muted" style="font-weight:400;font-size:12px">（新→旧 · 状态列即下一步按钮）</span></h2>
      <div class="card" style="padding:6px 10px">
        ${contents.length ? `<table>
          <thead><tr><th>材料</th><th>来源</th><th>语言</th><th>字符</th><th>候选</th><th>卡片</th><th>状态</th><th>日期</th><th></th></tr></thead>
          <tbody>
            ${contents.map((m) => {
              const step = nextStepOf(m)
              const sm = STEP_META[step]
              return `<tr>
              <td><a href="#/learn?id=${encodeURIComponent(m.content_id)}" style="color:var(--ink);font-weight:600;text-decoration:none">${esc(m.title)}</a>${m.source_url ? `<div class="muted mono" style="font-size:11px"><a href="javascript:void 0" data-open="${esc(m.source_url)}">${esc(m.source_url.slice(0, 60))}</a></div>` : ''}</td>
              <td><span class="badge src-${esc(m.source)}">${SRC_LABEL[m.source] || esc(m.source)}</span></td>
              <td class="mono">${esc(m.lang)}</td>
              <td class="mono">${m.chars}</td>
              <td class="mono">${m.candidate_count || 0}</td>
              <td class="mono">${m.card_count}</td>
              <td><span class="badge st-${step}">${sm.label}</span></td>
              <td class="muted mono">${esc(m.created_day)}</td>
              <td class="stepcell"><button class="${sm.cls}" data-act="${sm.act}" data-id="${esc(m.content_id)}">${sm.btn}</button> <button class="ghost" data-del="${esc(m.content_id)}" title="删除材料">✕</button></td>
            </tr>`
            }).join('')}
          </tbody>
        </table>` : '<div class="empty">还没有材料。选择一个文件、或粘贴一段文本，点「导入」。</div>'}
      </div>`

    // tabs
    $app.querySelector('#cap-tabs').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-tab]')
      if (!b) return
      state.capture.tab = b.dataset.tab
      renderHome()
    })

    // 文件选择（Electron 里 File.path 可取本地路径；取不到则前端读内容降级 text 通道）
    $app.querySelector('#cap-pick').addEventListener('click', () => $app.querySelector('#cap-file-input').click())
    $app.querySelector('#cap-file-input').addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0]
      if (!f) return
      let realPath = ''
      try { realPath = f.path || '' } catch { realPath = '' }
      if (!realPath && window.webUtils?.getPathForFile) {
        try { realPath = window.webUtils.getPathForFile(f) || '' } catch { realPath = '' }
      }
      state.capture.file = { name: f.name, size: f.size, path: realPath, blob: f }
      paintFileChip()
    })
    paintFileChip()

    // 导入（执行按钮）
    $app.querySelector('#cap-go').addEventListener('click', doImport)

    // 材料行：执行按钮 / 删除 / 打开原文链接
    $app.addEventListener('click', (e) => {
      const opener = e.target.closest('[data-open]')
      if (opener) { openLink(opener.dataset.open); return }
      const act = e.target.closest('button[data-act]')
      if (act) {
        const m = contents.find((x) => x.content_id === act.dataset.id)
        if (!m) return
        if (act.dataset.act === 'analyze') {
          handToAgent(analyzePrompt(m, cat.settings?.max_cards), m.content_id, m.title)
        } else {
          location.hash = `#/learn?id=${encodeURIComponent(m.content_id)}`
        }
        return
      }
      const b = e.target.closest('button[data-del]')
      if (!b) return
      if (!confirm('删除该材料及其卡片？（收藏快照保留）')) return
      apiDelete(`/api/contents/${encodeURIComponent(b.dataset.del)}`)
        .then(() => { toast('已删除'); renderHome() })
        .catch((err) => toast(`删除失败：${err.message}`))
    }, { once: true })
  }

  function paintFileChip() {
    const chip = $app.querySelector('#cap-file-chip')
    if (!chip) return
    const f = state.capture.file
    if (!f) { chip.innerHTML = ''; return }
    const kb = f.size > 1024 * 1024 ? `${(f.size / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(f.size / 1024))} KB`
    const hasPath = f.path && /^([a-zA-Z]:[\\/]|\/)/.test(f.path)
    chip.innerHTML = `
      <span class="filechip">📄 <b>${esc(f.name)}</b>（${kb}）· ${hasPath ? '路径已获取，直接导入' : '浏览器拿不到本地路径，将读取内容导入'}
        <span class="x" id="cap-file-clear" title="清除">✕</span></span>`
    chip.querySelector('#cap-file-clear')?.addEventListener('click', () => {
      state.capture.file = null
      const input = $app.querySelector('#cap-file-input')
      if (input) input.value = ''
      paintFileChip()
    })
  }

  async function doImport() {
    const tab = state.capture.tab
    const titleEl = $app.querySelector('#cap-title')
    const title = titleEl?.value.trim() || ''
    const payload = { title }
    if (tab === 'file') {
      const f = state.capture.file
      if (!f) return toast('先选择文件')
      if (f.path && /^([a-zA-Z]:[\\/]|\/)/.test(f.path)) {
        payload.source = 'file'
        payload.path = f.path
      } else {
        try {
          payload.source = 'text'
          payload.text = await f.blob.text()
        } catch (e) { return toast(`读取文件内容失败：${e.message}`) }
      }
    } else if (tab === 'text') {
      payload.source = 'text'
      payload.text = $app.querySelector('#cap-text').value.trim()
      if (!payload.text) return toast('先粘贴原文')
    } else {
      payload.source = tab
      payload.url = $app.querySelector('#cap-url').value.trim()
      if (!payload.url) return toast('先填链接')
    }
    const btn = $app.querySelector('#cap-go')
    btn.disabled = true
    btn.textContent = '导入中…'
    try {
      const r = await apiPost('/api/capture', payload)
      toast(`已导入《${r.meta.title}》：到学习页点「① 分析生词」`)
      await loadCatalog(true)
      location.hash = `#/learn?id=${encodeURIComponent(r.meta.content_id)}`
    } catch (e) {
      toast(`导入失败：${e.message}`)
      btn.disabled = false
      btn.textContent = '导入'
    }
  }

  function latestLabel(m) {
    return m ? `<span style="font-size:14px">${esc(String(m.title).slice(0, 14))}</span>` : '—'
  }

  // ── 学习：材料状态机（①分析 → ②选词制卡 → ③闪卡） ───────────────────
  async function renderLearn(id) {
    const cat = await loadCatalog()
    const contents = cat.contents || []
    if (!contents.length) {
      $app.innerHTML = `<h1>学习</h1><div id="waiting-slot"></div><div class="empty">还没有材料。先到「概览」导入一段内容。</div>`
      return
    }
    const target = id ? contents.find((m) => m.content_id === id) : contents[0]
    if (!target) {
      $app.innerHTML = `<h1>学习</h1><div id="waiting-slot"></div><div class="empty">材料不存在（可能已删除）。<a href="#/learn">回学习页</a></div>`
      return
    }
    const detail = await api(`/api/contents/${encodeURIComponent(target.content_id)}`)
    state.learn = {
      id: target.content_id,
      meta: detail.meta,
      sourceText: detail.source_text || '',
      candidates: detail.candidates || [],
      cards: detail.cards || [],
      favorites: new Set(detail.favorites || []),
      idx: 0,
      flipped: false,
      grid: false,
    }
    paintLearn()
  }

  function paintLearn() {
    const L = state.learn
    if (!L) return
    const cat = state.catalog
    const contents = cat.contents || []
    const step = nextStepOf(L.meta)
    const candCount = L.candidates.length
    const cardCount = L.cards.length

    $app.innerHTML = `
      <h1>学习</h1>
      <div id="waiting-slot"></div>
      <div class="learn-head">
        <select id="learn-select">${contents.map((m) => `<option value="${esc(m.content_id)}" ${m.content_id === L.id ? 'selected' : ''}>${esc(m.title)}</option>`).join('')}</select>
        <span class="badge">${SRC_LABEL[L.meta.source] || esc(L.meta.source)}</span>
        <span class="badge">${esc(L.meta.lang)}</span>
        <span class="badge st-${step}">${STEP_META[step].label}</span>
        <span class="muted">${cardCount} 卡 · 候选 ${candCount}</span>
        <span style="margin-left:auto" class="row">
          ${step !== 'imported' ? `<button class="ghost" id="act-reanalyze">重新分析</button>` : ''}
          ${cardCount ? `<button id="learn-grid">${L.grid ? '卡片视图' : '网格视图'}</button>` : ''}
          ${cardCount ? `<button id="learn-export">导出 CSV</button>` : ''}
        </span>
      </div>

      ${step === 'imported' ? `
        <div class="card step-card">
          <h2 style="margin:0 0 6px">第 1 步 · 分析生词</h2>
          <p class="muted" style="margin:0 0 10px">把原文交给对话里的 agent：按 seekword 技能通读全文、筛选高价值生词并入库。候选词会回到这里（面板每 2 秒自动检查入库）。</p>
          ${L.sourceText ? `<div class="muted mono src-preview">${esc(L.sourceText.slice(0, 300))}${L.sourceText.length > 300 ? '…' : ''}</div>` : ''}
          <div class="row end" style="margin-top:10px">
            <button class="primary" id="act-analyze">① 分析生词</button>
          </div>
        </div>` : ''}

      ${step === 'candidates' ? `
        <div class="card step-card">
          <h2 style="margin:0 0 6px">第 2 步 · 选词制卡（候选 ${candCount}）</h2>
          <p class="muted" style="margin:0">勾选要学的词（默认全选），点「② 生成卡片」交给 agent 制卡。</p>
          <div class="cand-list" id="cand-list">
            ${L.candidates.map((c, i) => `
              <span class="cand on" data-cand="${i}">${esc(c.term)}<span class="tag">${c.type === 'phrase' ? '短语' : '词'}</span></span>`).join('')}
          </div>
          <div class="row end">
            <button class="ghost" id="cand-all">全选 / 全不选</button>
            <button class="primary" id="cand-go">② 生成卡片</button>
          </div>
        </div>` : ''}

      <div id="learn-area"></div>`

    $app.querySelector('#learn-select').addEventListener('change', (e) => {
      location.hash = `#/learn?id=${encodeURIComponent(e.target.value)}`
    })
    $app.querySelector('#act-analyze')?.addEventListener('click', () => {
      handToAgent(analyzePrompt(L.meta, cat.settings?.max_cards), L.id, L.meta.title)
    })
    $app.querySelector('#act-reanalyze')?.addEventListener('click', () => {
      handToAgent(analyzePrompt(L.meta, cat.settings?.max_cards), L.id, L.meta.title)
    })

    if (step === 'candidates') {
      const listEl = $app.querySelector('#cand-list')
      listEl.addEventListener('click', (e) => {
        const c = e.target.closest('[data-cand]')
        if (c) c.classList.toggle('on')
      })
      $app.querySelector('#cand-all').addEventListener('click', () => {
        const all = [...listEl.querySelectorAll('.cand')]
        const every = all.every((x) => x.classList.contains('on'))
        all.forEach((x) => x.classList.toggle('on', !every))
      })
      $app.querySelector('#cand-go').addEventListener('click', () => {
        const terms = [...listEl.querySelectorAll('.cand.on')].map((x) => L.candidates[Number(x.dataset.cand)].term)
        if (!terms.length) return toast('至少勾选一个词')
        handToAgent(makeCardsPrompt(L.meta, terms), L.id, L.meta.title)
      })
    }

    if (step === 'cards') {
      $app.querySelector('#learn-grid')?.addEventListener('click', () => { L.grid = !L.grid; L.flipped = false; paintLearn() })
      $app.querySelector('#learn-export')?.addEventListener('click', () => downloadCsv(`content_id=${encodeURIComponent(L.id)}`, L.meta.title))
      paintFlash()
      bindFlashKeys()
    }
  }

  // ── 闪卡 ───────────────────────────────────────────────────────────────
  function paintFlash() {
    const L = state.learn
    const area = $app.querySelector('#learn-area')
    if (!area) return
    if (L.grid) {
      area.innerHTML = `<div class="cards-grid">${L.cards.map((c, i) => `
        <div class="mini-card ${L.favorites.has(c.term) ? 'fav' : ''}" data-goto="${i}">
          <div class="t">${esc(c.term)}</div>
          <div class="d">${esc(c.definition)}</div>
        </div>`).join('')}</div>`
      area.querySelectorAll('[data-goto]').forEach((el) => el.addEventListener('click', () => {
        L.idx = Number(el.dataset.goto)
        L.grid = false
        L.flipped = false
        paintLearn()
      }))
      return
    }
    const c = L.cards[L.idx]
    if (!c) { area.innerHTML = '<div class="empty">没有卡片</div>'; return }
    const pron = c.ipa || c.reading || ''
    const fav = L.favorites.has(c.term)
    area.innerHTML = `
      <div class="flash-wrap">
        <div class="flash" id="flash">
          <span class="sense">${L.flipped ? '释义' : '生词'}</span>
          <button class="fav ${fav ? 'on' : ''}" id="fav-btn" title="收藏（空格）">${fav ? '♥' : '♡'}</button>
          <button class="ghost tts" id="tts-btn" title="朗读">🔊</button>
          ${L.flipped ? `
            <div class="definition">${esc(c.definition)}</div>
            <div class="pron">${esc(c.term)}${pron ? ` · ${esc(pron)}` : ''}${c.pos ? ` · ${esc(c.pos)}` : ''}</div>
            ${(c.examples || []).length ? `<div class="examples">${c.examples.map((ex) => {
              const lines = String(ex).split('\n')
              return `<div class="ex"><em>${esc(lines[0] || '')}</em><span>${esc(lines[1] || '')}</span></div>`
            }).join('')}</div>` : ''}
            ${c.notes ? `<div class="notes">${esc(c.notes)}</div>` : ''}
          ` : `
            <div class="term">${esc(c.term)}</div>
            ${pron ? `<div class="pron">${esc(pron)}</div>` : ''}
            ${c.pos ? `<span class="badge pos">${esc(c.pos)}</span>` : ''}
            <div class="hint">点击翻转看释义</div>
          `}
        </div>
        <div class="learn-bar">
          <button id="prev-btn" ${L.idx === 0 ? 'disabled' : ''}>←</button>
          <span class="idx">${L.idx + 1} / ${L.cards.length}</span>
          <button id="next-btn" ${L.idx === L.cards.length - 1 ? 'disabled' : ''}>→</button>
        </div>
        <div class="progress"><i style="width:${((L.idx + 1) / L.cards.length) * 100}%"></i></div>
      </div>`

    area.querySelector('#flash').addEventListener('click', (e) => {
      if (e.target.closest('button')) return
      L.flipped = !L.flipped
      paintFlash()
    })
    area.querySelector('#prev-btn').addEventListener('click', () => stepFlash(-1))
    area.querySelector('#next-btn').addEventListener('click', () => stepFlash(1))
    area.querySelector('#fav-btn').addEventListener('click', () => toggleFav(c.term))
    area.querySelector('#tts-btn').addEventListener('click', () => speak(c.term, L.meta.lang))
  }

  function stepFlash(d) {
    const L = state.learn
    const next = L.idx + d
    if (next < 0 || next >= L.cards.length) return
    L.idx = next
    L.flipped = false
    paintFlash()
  }

  async function toggleFav(term) {
    const L = state.learn
    try {
      const r = await apiPost('/api/favorite', { content_id: L.id, term })
      if (r.favorited) L.favorites.add(term)
      else L.favorites.delete(term)
      await loadCatalog(true)
      paintFlash()
      toast(r.favorited ? `已收藏「${term}」` : `已取消收藏「${term}」`)
    } catch (e) { toast(`收藏失败：${e.message}`) }
  }

  function bindFlashKeys() {
    if (state._keysBound) return
    state._keysBound = true
    addEventListener('keydown', (e) => {
      if (state.view !== 'learn' || !state.learn) return
      if (nextStepOf(state.learn.meta) !== 'cards' || state.learn.grid) return
      const tag = document.activeElement?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if (e.key === 'ArrowLeft') { e.preventDefault(); stepFlash(-1) }
      else if (e.key === 'ArrowRight') { e.preventDefault(); stepFlash(1) }
      else if (e.key === ' ') {
        e.preventDefault(); e.stopPropagation()
        const c = state.learn.cards[state.learn.idx]
        if (c) toggleFav(c.term)
      }
    }, { capture: true })
  }

  // ── 单词本 ─────────────────────────────────────────────────────────────
  async function renderWordbook() {
    await loadCatalog()
    const wb = state.wb
    $app.innerHTML = `
      <h1>单词本</h1>
      <p class="sub">所有材料的学习卡片。搜索/过滤后点「导出 CSV」拿当前结果。</p>
      <div class="card">
        <div class="row">
          <input id="wb-q" placeholder="搜生词/释义…" value="${esc(wb.q)}" style="width:200px">
          <select id="wb-source">
            <option value="">全部来源</option>
            ${Object.entries(SRC_LABEL).map(([k, v]) => `<option value="${k}" ${wb.source === k ? 'selected' : ''}>${v}</option>`).join('')}
          </select>
          <label style="margin:0"><input type="checkbox" id="wb-fav" ${wb.fav ? 'checked' : ''}> 只看收藏</label>
          <span style="margin-left:auto" class="row">
            <span class="muted mono" id="wb-count">${wb.total} 张</span>
            <button id="wb-export">导出 CSV</button>
          </span>
        </div>
        <div id="wb-table" style="margin-top:10px">${wbTable(wb.cards)}</div>
      </div>`
    paintCounts()

    const reload = async () => {
      const p = new URLSearchParams()
      if (state.wb.q) p.set('q', state.wb.q)
      if (state.wb.fav) p.set('fav', '1')
      if (state.wb.source) p.set('source', state.wb.source)
      const r = await api(`/api/cards?${p.toString()}`)
      state.wb.cards = r.cards
      state.wb.total = r.total
      const countEl = $app.querySelector('#wb-count')
      if (!countEl) return // 已切走视图
      countEl.textContent = `${r.total} 张`
      $app.querySelector('#wb-table').innerHTML = wbTable(r.cards)
      bindWbFav()
    }
    reload() // 首次渲染即拉全量
    let qTimer = null
    $app.querySelector('#wb-q').addEventListener('input', (e) => {
      clearTimeout(qTimer)
      qTimer = setTimeout(() => { state.wb.q = e.target.value.trim(); reload() }, 300)
    })
    $app.querySelector('#wb-source').addEventListener('change', (e) => { state.wb.source = e.target.value; reload() })
    $app.querySelector('#wb-fav').addEventListener('change', (e) => { state.wb.fav = e.target.checked; reload() })
    $app.querySelector('#wb-export').addEventListener('click', () =>
      downloadCsv(`${state.wb.fav ? 'fav=1' : ''}${state.wb.source ? `&source=${state.wb.source}` : ''}${state.wb.q ? `&q=${encodeURIComponent(state.wb.q)}` : ''}`.replace(/^&/, ''), 'wordbook'))
    bindWbFav()
  }

  function bindWbFav() {
    $app.querySelectorAll('[data-wbfav]').forEach((btn) => btn.addEventListener('click', async () => {
      const term = btn.dataset.wbfav
      const cid = btn.dataset.cid
      try {
        const r = await apiPost('/api/favorite', { content_id: cid, term })
        btn.textContent = r.favorited ? '♥' : '♡'
        btn.classList.toggle('on', r.favorited)
        await loadCatalog(true)
        toast(r.favorited ? `已收藏「${term}」` : `已取消收藏「${term}」`)
      } catch (e) { toast(`收藏失败：${e.message}`) }
    }))
  }

  function wbTable(cards) {
    if (!cards.length) return '<div class="empty">没有匹配的卡片。先导入材料、生成卡片。</div>'
    return `<table>
      <thead><tr><th></th><th>生词</th><th>读音/音标</th><th>词性</th><th>释义</th><th>材料</th></tr></thead>
      <tbody>${cards.map((c) => `<tr>
        <td><button class="ghost ${c.favorite ? 'on' : ''}" data-wbfav="${esc(c.term)}" data-cid="${esc(c.content_id)}" style="${c.favorite ? 'color:var(--bad)' : ''}">${c.favorite ? '♥' : '♡'}</button></td>
        <td style="font-weight:700">${esc(c.term)}</td>
        <td class="mono">${esc(c.ipa || c.reading || '')}</td>
        <td class="muted">${esc(c.pos || '')}</td>
        <td>${esc(c.definition || '')}${c.orphan ? ' <span class="badge">源已删</span>' : ''}</td>
        <td class="muted">${esc(String(c.title || '').slice(0, 18))}</td>
      </tr>`).join('')}</tbody>
    </table>`
  }

  // ── 导出（blob 下载，绕开 WebContentsView deny window.open） ──────────
  async function downloadCsv(query, name) {
    try {
      const res = await fetch(`/seekword/api/export?${query}`)
      if (!res.ok) {
        const b = await res.json().catch(() => ({}))
        throw new Error(b.error || `HTTP ${res.status}`)
      }
      const blob = await res.blob()
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `seekword-${String(name).replace(/[^\p{L}\p{N}]+/gu, '_').slice(0, 30) || 'export'}.csv`
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(a.href), 4000)
      toast('CSV 已下载')
    } catch (e) { toast(`导出失败：${e.message}`) }
  }

  // ── 设置 ───────────────────────────────────────────────────────────────
  function renderSettings() {
    const cat = state.catalog
    const s = cat?.settings || {}
    $app.innerHTML = `
      <h1>设置</h1>
      <p class="sub">改动即自动保存。这些设置同时约束 agent 制卡（释义语言/口音）与字幕抓取（代理）。</p>
      <div class="card" style="max-width:560px">
        <div class="field">
          <label>释义语言（definition/notes/例句翻译用什么语言写）</label>
          <select id="set-gloss">${GLOSS.map(([v, n]) => `<option value="${v}" ${s.gloss_lang === v ? 'selected' : ''}>${n}</option>`).join('')}</select>
        </div>
        <div class="field">
          <label>英语口音（ipa 主音标跟随）</label>
          <select id="set-accent">
            <option value="us" ${s.accent === 'us' ? 'selected' : ''}>美音 General American</option>
            <option value="uk" ${s.accent === 'uk' ? 'selected' : ''}>英音 RP</option>
          </select>
        </div>
        <div class="field">
          <label>单次候选词上限（5-60）</label>
          <input id="set-max" type="number" min="5" max="60" value="${esc(s.max_cards)}" style="width:110px">
        </div>
        <div class="field">
          <label>HTTP(S) 代理（抓 YouTube/网页用，如 http://127.0.0.1:7890，留空直连）</label>
          <input id="set-proxy" value="${esc(s.proxy_url || '')}" style="width:100%" placeholder="http://127.0.0.1:7890">
        </div>
        <div class="row end"><span class="muted" id="set-saved" style="font-size:12px"></span></div>
      </div>
      <h2>学习方式</h2>
      <div class="card muted" style="max-width:560px;font-size:13px">
        <p style="margin:4px 0"><b>导入 → 分析 → 学习</b>：概览页四渠道导入（文件/粘贴/YouTube/网页）→ 材料列表或学习页点「① 分析生词」交给 agent → 候选回面板勾选 → 「② 生成卡片」→ 闪卡学习。点按钮后面板每 2 秒自动检查入库并刷新。</p>
        <p style="margin:4px 0">闪卡键盘：<b>←/→</b> 切换 · <b>空格</b> 收藏 · 点击翻转释义。🔊 用浏览器本地语音朗读（无需 API key）。</p>
        <p style="margin:4px 0">「分析/生成卡片」按钮把指令草稿填进新对话（不自动发送）；独立浏览器预览时改为复制提示词。</p>
      </div>`

    const save = async (patch) => {
      try {
        await apiPost('/api/settings', patch)
        await loadCatalog(true)
        const el = $app.querySelector('#set-saved')
        if (el) { el.textContent = `已保存 ${new Date().toLocaleTimeString()}` }
        toast('设置已保存')
      } catch (e) { toast(`保存失败：${e.message}`) }
    }
    $app.querySelector('#set-gloss').addEventListener('change', (e) => save({ gloss_lang: e.target.value }))
    $app.querySelector('#set-accent').addEventListener('change', (e) => save({ accent: e.target.value }))
    $app.querySelector('#set-max').addEventListener('change', (e) => save({ max_cards: Number(e.target.value) }))
    $app.querySelector('#set-proxy').addEventListener('change', (e) => save({ proxy_url: e.target.value.trim() }))
  }

  // ── 宿主握手回执（client.js startSession 结果） ────────────────────────
  addEventListener('message', (e) => {
    if (e.source !== parent || e.origin !== location.origin) return
    const t = e.data?.type
    if (t === 'seekword:start-ok') toast('已交给宿主：新对话草稿已填入（未自动发送）')
    else if (t === 'seekword:start-failed') toast(`开新对话失败：${e.data.message || ''}（已改为复制提示词）`)
  })

  // ── 启动 ───────────────────────────────────────────────────────────────
  addEventListener('hashchange', route)
  if ('speechSynthesis' in window) speechSynthesis.getVoices() // 触发语音列表加载
  route()
})()
