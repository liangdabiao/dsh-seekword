// 插件独立工作区：目录创建 + 幂等注册 + registry 缺席时的降级。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'seekword-ws-'))
process.on('exit', () => { try { rmSync(process.env.DSH_HOME, { recursive: true, force: true }) } catch { /* ignore */ } })

const { ensureWorkspaceDir, ensureSeekwordWorkspace, WORKSPACE_DIR, WORKSPACE_TITLE } = await import('../lib/workspace.js')
const { DATA_DIR } = await import('../lib/store.js')

test('工作区目录固定在插件数据目录下', () => {
  assert.equal(WORKSPACE_DIR, join(DATA_DIR, 'workspace'))
})

test('ensureWorkspaceDir：目录不存在时创建，重复调用无副作用', () => {
  assert.equal(existsSync(WORKSPACE_DIR), false)
  const dir = ensureWorkspaceDir()
  assert.equal(dir, WORKSPACE_DIR)
  assert.ok(statSync(dir).isDirectory())
  assert.equal(ensureWorkspaceDir(), dir)
})

test('ensureSeekwordWorkspace：注册后返回 workspaceId', async () => {
  const calls = []
  const registry = {
    create: async (path, title) => { calls.push({ path, title }); return { id: 'ws-1', path, title } },
  }
  const r = await ensureSeekwordWorkspace(registry)
  assert.equal(r.path, WORKSPACE_DIR)
  assert.equal(r.workspaceId, 'ws-1')
  assert.deepEqual(calls, [{ path: WORKSPACE_DIR, title: WORKSPACE_TITLE }])
  assert.ok(existsSync(WORKSPACE_DIR))
})

test('ensureSeekwordWorkspace：registry 缺席时只返回路径（面板据此退回当前工作区）', async () => {
  const r = await ensureSeekwordWorkspace(undefined)
  assert.equal(r.path, WORKSPACE_DIR)
  assert.equal(r.workspaceId, '')
})

test('ensureSeekwordWorkspace：注册失败向上抛（由 /api/workspace 回 500）', async () => {
  const registry = { create: async () => { throw new Error('workspace/invalid-path') } }
  await assert.rejects(() => ensureSeekwordWorkspace(registry), /invalid-path/)
})
