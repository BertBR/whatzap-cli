import net from 'net'
import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const WHATZAP_DIR = join(homedir(), '.whatzap')
const SOCK_PATH = join(WHATZAP_DIR, 'daemon.sock')
const CREDS_PATH = join(WHATZAP_DIR, 'auth', 'creds.json')
const DAEMON_PATH = join(__dirname, 'server.js')

function sendRequest<T extends object>(req: object, timeoutMs = 10000): Promise<T> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(SOCK_PATH)
    let buf = ''
    let settled = false

    const settle = (fn: () => void) => {
      if (settled) return
      settled = true
      fn()
      socket.destroy()
    }

    socket.setTimeout(timeoutMs)
    socket.on('timeout', () => settle(() => reject(new Error('Daemon timeout'))))
    socket.on('error', (err) => settle(() => reject(err)))
    socket.on('connect', () => socket.write(JSON.stringify(req) + '\n'))

    socket.on('data', (chunk) => {
      buf += chunk.toString()
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          settle(() => resolve(JSON.parse(line) as T))
        } catch {
          settle(() => reject(new Error('Invalid response from daemon')))
        }
      }
    })
  })
}

export function isDaemonRunning(): Promise<boolean> {
  return sendRequest<{ ok: boolean }>({ command: 'ping' }, 2000).then(() => true).catch(() => false)
}

export async function startDaemon(): Promise<void> {
  const child = spawn(process.execPath, [DAEMON_PATH], {
    detached: true,
    stdio: 'ignore',
  })
  child.unref()

  for (let i = 0; i < 40; i++) {
    await new Promise<void>((r) => setTimeout(r, 500))
    if (await isDaemonRunning()) return
  }

  throw new Error('Daemon failed to start within 20s')
}

export async function ensureDaemon(): Promise<void> {
  if (!existsSync(CREDS_PATH)) {
    console.error("Not logged in. Run 'whatzap login' first.")
    process.exit(1)
  }
  if (await isDaemonRunning()) return
  await startDaemon()
}

export async function sendViaDaemon(jid: string, text: string): Promise<void> {
  const res = await sendRequest<{ ok: boolean; error?: string }>({ command: 'send', jid, text }, 30000)
  if (!res.ok) throw new Error(res.error ?? 'Send failed')
}

export async function replyViaDaemon(id: string, text: string, mentions: string[] = []): Promise<void> {
  const res = await sendRequest<{ ok: boolean; error?: string }>({ command: 'reply', id, text, mentions }, 30000)
  if (!res.ok) throw new Error(res.error ?? 'Reply failed')
}

export async function replyAudioViaDaemon(id: string, file: string): Promise<void> {
  const res = await sendRequest<{ ok: boolean; error?: string }>({ command: 'reply-audio', id, text: file }, 60000)
  if (!res.ok) throw new Error(res.error ?? 'Reply failed')
}

export async function stopDaemon(): Promise<void> {
  await sendRequest<{ ok: boolean }>({ command: 'stop' })
}

export async function logoutDaemon(): Promise<void> {
  await sendRequest<{ ok: boolean }>({ command: 'logout' }, 15000)
}

export async function listGroups(): Promise<{ jid: string; name: string }[]> {
  const res = await sendRequest<{ ok: true; groups: { jid: string; name: string }[] }>({ command: 'list-groups' })
  return res.groups
}

export async function watchAdd(jid: string): Promise<{ alreadyPresent: boolean }> {
  const res = await sendRequest<{ ok: true; alreadyPresent: boolean }>({ command: 'watch-add', jid })
  return { alreadyPresent: res.alreadyPresent }
}

export async function watchRemove(jid: string): Promise<{ ok: boolean }> {
  const res = await sendRequest<{ ok: boolean; error?: string }>({ command: 'watch-remove', jid })
  return { ok: res.ok }
}

export async function watchList(): Promise<{ jid: string; name: string }[]> {
  const res = await sendRequest<{ ok: true; list: { jid: string; name: string }[] }>({ command: 'watch-list' })
  return res.list
}
