// 插件独立工作区：所有「分析生词 / 制卡」对话都在这个目录里跑，不占用用户其它工作区。
//   <数据目录>/workspace   （首次使用时创建）
// 拿到目录后交给 Host 的 workspaceRegistry 注册，返回稳定 workspaceId 给面板 → client.js
// 用 uiWorkspace.startSession(workspaceId, …) 开新对话。
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from './store.js'

export const WORKSPACE_TITLE = '捕获生词'
export const WORKSPACE_DIR = join(DATA_DIR, 'workspace')

/** 确保工作区目录存在，返回绝对路径。 */
export function ensureWorkspaceDir(dir = WORKSPACE_DIR) {
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * 确保「插件工作区」已注册（幂等）。
 * @param registry - ctx.get('workspaceRegistry')；不可用时只返回路径
 * @returns { path, workspaceId }（registry 缺席时 workspaceId 为空串）
 */
export async function ensureSeekwordWorkspace(registry, dir = WORKSPACE_DIR) {
  const path = ensureWorkspaceDir(dir)
  if (!registry || typeof registry.create !== 'function') return { path, workspaceId: '' }
  const ws = await registry.create(path, WORKSPACE_TITLE)
  return { path, workspaceId: String(ws?.id || '') }
}
