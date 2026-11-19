// 选文件对话框（宿主侧）：脚本编码 / 结果归一 / 不支持平台降级。
// 不进真实对话框：pickFile 的 spawn 可注入（run），只验确定性部分。
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildPickScript, pickFile, pickerSupported, DOC_FILTER } from '../lib/picker.js'

const decode = (b64) => Buffer.from(String(b64), 'base64').toString('utf16le')

test('buildPickScript：base64 能还原成 PowerShell 对话框脚本', () => {
  const script = decode(buildPickScript({ title: '选择要学的文件' }))
  assert.match(script, /System\.Windows\.Forms\.OpenFileDialog/)
  assert.match(script, /选择要学的文件/)
  assert.match(script, /ShowDialog/)
  assert.match(script, /\[Console\]::Out\.Write\(\$dialog\.FileName\)/)
})

test('buildPickScript：单引号被转义，滤镜不会被拼坏', () => {
  const script = decode(buildPickScript({ title: "it's", filter: "文档|*.txt|所有文件|*.*" }))
  assert.match(script, /\$dialog\.Title = 'it''s'/)
  assert.match(script, /文档\|\*\.txt\|所有文件\|\*\.\*/)
})

test('DOC_FILTER：文本/字幕/PDF/Word/EPUB 都给出，最后一档是所有文件', () => {
  for (const ext of ['*.txt', '*.md', '*.srt', '*.vtt', '*.json3', '*.pdf', '*.docx', '*.epub']) {
    assert.ok(DOC_FILTER.includes(ext), `缺少 ${ext}`)
  }
  assert.ok(DOC_FILTER.endsWith('|所有文件|*.*'))
})

test('pickFile：选中文件时回绝对路径', async () => {
  const r = await pickFile({
    run: async () => ({ code: 0, stdout: 'D:\\资料\\article.pdf\r\n', stderr: '' }),
  })
  assert.equal(r.ok, true)
  assert.equal(r.path, 'D:\\资料\\article.pdf')
})

test('pickFile：去 BOM、空输出算取消', async () => {
  const bom = await pickFile({ run: async () => ({ code: 0, stdout: '\uFEFFD:\\a.txt', stderr: '' }) })
  assert.equal(bom.path, 'D:\\a.txt')
  const cancelled = await pickFile({ run: async () => ({ code: 0, stdout: '   ', stderr: '' }) })
  assert.equal(cancelled.ok, false)
  assert.equal(cancelled.cancelled, true)
})

test('pickFile：非零退出码回错误，不抛异常', async () => {
  const r = await pickFile({ run: async () => ({ code: 1, stdout: '', stderr: 'Access denied' }) })
  assert.equal(r.ok, false)
  assert.match(r.error, /Access denied/)
})

test('pickFile：注入的 run 抛错时转成 { ok:false, error }', async () => {
  const r = await pickFile({ run: async () => { throw new Error('spawn failed') } })
  assert.equal(r.ok, false)
  assert.match(r.error, /spawn failed/)
})

test('pickerSupported：与当前平台一致（Windows 才声称支持）', () => {
  assert.equal(pickerSupported(), process.platform === 'win32')
})
