// 宿主侧通用工具（dsh 家族插件共用的一份）：用系统默认浏览器打开链接。
// 桌面端 dsh 的 WebContentsView 把 window.open / target=_blank 一律 deny，
// 面板 iframe 里点链接没有任何反应；只能交给宿主进程 spawn 系统打开器
// （不经过 shell，参数不拼字符串）。
import { spawn } from 'node:child_process'

const LOOPBACK = /^(localhost$|127\.\d+\.\d+\.\d+$|0\.0\.0\.0$|::1$|\[::1\]$)/i

export function parseOpenableUrl(raw) {
  let url
  try {
    url = new URL(String(raw || '').trim())
  } catch {
    throw new Error('链接格式不对')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('只支持 http(s) 链接')
  if (LOOPBACK.test(url.hostname)) throw new Error('不支持打开本机地址')
  return url.toString()
}

export function canOpenExternal() {
  if (process.platform === 'win32' || process.platform === 'darwin') return true
  return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY || process.env.WSL_DISTRO_NAME)
}

/** 用系统默认浏览器打开一个 http(s) 链接，resolve 实际打开的 URL。 */
export function openExternal(raw) {
  const target = parseOpenableUrl(raw)
  if (!canOpenExternal()) throw new Error('当前环境没有可用的桌面浏览器')
  const [cmd, args] = process.platform === 'win32'
    ? ['rundll32.exe', ['url.dll,FileProtocolHandler', target]]
    : process.platform === 'darwin'
      ? ['open', [target]]
      : ['xdg-open', [target]]
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true })
    } catch (e) {
      reject(new Error(`打开链接失败：${e.message}`))
      return
    }
    child.once('error', (e) => reject(new Error(`打开链接失败：${e.message}`)))
    child.once('spawn', () => {
      child.unref()
      resolve(target)
    })
  })
}
