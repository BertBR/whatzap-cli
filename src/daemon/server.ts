import net from 'net'
import { existsSync, writeFileSync, readFileSync, unlinkSync, mkdirSync } from 'fs'
import { execFileSync } from 'child_process'
import { randomUUID } from 'crypto'
import { homedir } from 'os'
import { join } from 'path'
import { WhatsAppService } from '../services/whatsapp.js'
import { jidToFilename, HISTORY_DIR } from '../utils/phone.js'

const WHATZAP_DIR = join(homedir(), '.whatzap')
const SOCK_PATH = join(WHATZAP_DIR, 'daemon.sock')
const PID_PATH = join(WHATZAP_DIR, 'daemon.pid')

const service = new WhatsAppService()

// --- Config helpers ---

interface Config {
  contacts?: Record<string, unknown>
  watchList?: string[]
}

const CONFIG_PATH = join(WHATZAP_DIR, 'settings.json')

function readConfig(): Config {
  if (!existsSync(CONFIG_PATH)) return {}
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as Config
  } catch {
    return {}
  }
}

// Serialized write queue — prevents concurrent config mutations losing data
let configWriteQueue: Promise<void> = Promise.resolve()

function writeConfig(config: Config): void {
  configWriteQueue = configWriteQueue.then(() => {
    writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2))
  }).catch(() => {
    // Write failed — queue is reset so next write can still proceed
  })
}

// --- In-memory state ---

const watchSet = new Set<string>(readConfig().watchList ?? [])
const groupCache = new Map<string, string>() // jid → name

let server: net.Server

const HISTORY_MAX = 100
const MEDIA_DIR = join(WHATZAP_DIR, 'media')
// The message id is chosen by the sender's device: a random suffix keeps one
// sender from overwriting another's file, and 'wx' refuses to overwrite at all.
function mediaName(id: string, ext: string): string {
  const safe = id.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || 'media'
  return `${safe}-${randomUUID().slice(0, 8)}.${ext}`
}

function appendHistory(jid: string, entry: object): void {
  mkdirSync(HISTORY_DIR, { recursive: true })
  const filepath = join(HISTORY_DIR, jidToFilename(jid) + '.jsonl')
  const existing = existsSync(filepath)
    ? readFileSync(filepath, 'utf8').split('\n').filter(Boolean)
    : []
  existing.push(JSON.stringify(entry))
  if (existing.length > HISTORY_MAX) existing.splice(0, existing.length - HISTORY_MAX)
  writeFileSync(filepath, existing.join('\n') + '\n')
}

interface HistoryEntry { ts: string; d: 'in' | 'out'; n?: string; text: string; id?: string; p?: string; q?: string; pn?: string; fw?: boolean }

// Message ids are random, but refuse to guess if one shows up in more than
// one chat: replying in the wrong conversation is worse than not replying.
function findHistoryEntry(id: string): { jid: string; entry: HistoryEntry } | null {
  const found: { jid: string; entry: HistoryEntry }[] = []
  for (const jid of watchSet) {
    const filepath = join(HISTORY_DIR, jidToFilename(jid) + '.jsonl')
    if (!existsSync(filepath)) continue
    for (const line of readFileSync(filepath, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        const entry = JSON.parse(line) as HistoryEntry
        if (entry.id === id) found.push({ jid, entry })
      } catch {
        // skip malformed line
      }
    }
  }
  if (found.length > 1) throw new Error(`Message '${id}' matches ${found.length} chats; not replying`)
  return found[0] ?? null
}

function cleanup(): void {
  if (server) server.close()
  if (existsSync(SOCK_PATH)) unlinkSync(SOCK_PATH)
  if (existsSync(PID_PATH)) unlinkSync(PID_PATH)
  service.disconnect().finally(() => process.exit(0))
}

async function handleRequest(line: string, socket: net.Socket): Promise<void> {
  let req: { command: string; jid?: string; text?: string; id?: string; mentions?: string[] }
  try {
    req = JSON.parse(line)
  } catch {
    socket.write(JSON.stringify({ ok: false, error: 'Invalid JSON' }) + '\n')
    return
  }

  if (req.command === 'ping') {
    socket.write(JSON.stringify({ ok: true }) + '\n')
  } else if (req.command === 'send') {
    try {
      await service.sendMessage(req.jid!, req.text!)
      socket.write(JSON.stringify({ ok: true }) + '\n')
    } catch (err) {
      socket.write(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }) + '\n')
    }
  } else if (req.command === 'reply') {
    // Reply quoting a recorded message and mentioning its sender, so the
    // answer stays attached to the question in busy groups.
    try {
      const found = findHistoryEntry(req.id!)
      if (!found) throw new Error(`Message '${req.id}' not found in watched history`)
      const { jid, entry } = found
      const quoted = {
        key: { remoteJid: jid, id: entry.id!, participant: entry.p, fromMe: entry.d === 'out' },
        message: { conversation: entry.text },
      }
      const mention = entry.d === 'in' && entry.p ? entry.p : null
      const text = mention ? `@${mention.split('@')[0]} ${req.text!}` : req.text!
      const extra = (req.mentions ?? []).filter((m) => m !== mention)
      await service.sendMessage(jid, text, { quoted, mentions: [...(mention ? [mention] : []), ...extra] })
      socket.write(JSON.stringify({ ok: true }) + '\n')
    } catch (err) {
      socket.write(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }) + '\n')
    }
  } else if (req.command === 'send-audio') {
    try {
      if (!req.text || !req.text.endsWith('.ogg') || !existsSync(req.text)) throw new Error('Audio must be an existing .ogg file')
      await service.sendVoice(req.jid!, readFileSync(req.text))
      socket.write(JSON.stringify({ ok: true }) + '\n')
    } catch (err) {
      socket.write(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }) + '\n')
    }
  } else if (req.command === 'reply-audio') {
    // Voice note quoting a recorded message. Only .ogg files, read by the daemon itself.
    try {
      const found = findHistoryEntry(req.id!)
      if (!found) throw new Error(`Message '${req.id}' not found in watched history`)
      if (!req.text || !req.text.endsWith('.ogg') || !existsSync(req.text)) throw new Error('Audio must be an existing .ogg file')
      const { jid, entry } = found
      const quoted = {
        key: { remoteJid: jid, id: entry.id!, participant: entry.p, fromMe: entry.d === 'out' },
        message: { conversation: entry.text },
      }
      await service.sendVoice(jid, readFileSync(req.text), { quoted })
      socket.write(JSON.stringify({ ok: true }) + '\n')
    } catch (err) {
      socket.write(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }) + '\n')
    }
  } else if (req.command === 'logout') {
    // Delete auth files synchronously before the async logout triggers onClose → cleanup()
    execFileSync('/bin/rm', ['-rf', join(WHATZAP_DIR, 'auth')])
    socket.write(JSON.stringify({ ok: true }) + '\n')
    setTimeout(async () => {
      await service.logout()
    }, 100)
  } else if (req.command === 'stop') {
    socket.write(JSON.stringify({ ok: true }) + '\n')
    setTimeout(cleanup, 100)
  } else if (req.command === 'list-groups') {
    const groups = Array.from(groupCache.entries()).map(([jid, name]) => ({ jid, name }))
    socket.write(JSON.stringify({ ok: true, groups }) + '\n')

  } else if (req.command === 'watch-add') {
    const jid = req.jid!
    const alreadyPresent = watchSet.has(jid)
    watchSet.add(jid)
    const config = readConfig()
    config.watchList = Array.from(watchSet)
    writeConfig(config)
    socket.write(JSON.stringify({ ok: true, alreadyPresent }) + '\n')

  } else if (req.command === 'watch-remove') {
    const jid = req.jid!
    if (!watchSet.has(jid)) {
      socket.write(JSON.stringify({ ok: false, error: 'JID not in watch list' }) + '\n')
    } else {
      watchSet.delete(jid)
      const config = readConfig()
      config.watchList = Array.from(watchSet)
      writeConfig(config)
      socket.write(JSON.stringify({ ok: true }) + '\n')
    }

  } else if (req.command === 'watch-list') {
    const list = Array.from(watchSet).map((jid) => {
      const name = jid.endsWith('@g.us')
        ? (groupCache.get(jid) ?? jid)
        : jid.replace('@s.whatsapp.net', '')
      return { jid, name }
    })
    socket.write(JSON.stringify({ ok: true, list }) + '\n')

  } else {
    socket.write(JSON.stringify({ ok: false, error: 'Unknown command' }) + '\n')
  }
}

async function main(): Promise<void> {
  mkdirSync(WHATZAP_DIR, { recursive: true })

  await service.connect(undefined, () => {
    // WhatsApp connection dropped after being established — exit so ensureDaemon() restarts us
    cleanup()
  })

  // Populate group cache (best-effort — don't fail daemon startup if this errors)
  try {
    const groups = await service.fetchGroups()
    for (const [jid, name] of Object.entries(groups)) {
      groupCache.set(jid, name)
    }
  } catch {
    // Group fetch failed — list-groups will return empty until restart
  }

  service.onMessage((msg) => {
    const { key, message, pushName } = msg
    // Resolve LID (@lid) to phone JID (@s.whatsapp.net) using senderPn when available
    const rawJid = key.remoteJid
    if (!rawJid) return
    const resolvedJid = rawJid.endsWith('@lid') ? ((key as any).senderPn ?? rawJid) : rawJid
    const remoteJid = resolvedJid
    if (!watchSet.has(remoteJid)) return

    // Images (also inside an album) are saved too, with the caption as text.
    const image = (message as any)?.imageMessage ?? (message as any)?.ephemeralMessage?.message?.imageMessage
    if (image && !key.fromMe) {
      const isGroup = remoteJid.endsWith('@g.us')
      if (isGroup && !key.participant) return
      const id = key.id ?? String(Date.now())
      service.downloadMedia({ key, message }).then((buf) => {
        mkdirSync(MEDIA_DIR, { recursive: true, mode: 0o700 })
        const file = join(MEDIA_DIR, mediaName(id, 'jpg'))
        writeFileSync(file, buf, { mode: 0o600, flag: 'wx' })
        appendHistory(remoteJid, {
          ts: new Date().toISOString(), d: 'in', n: pushName ?? undefined,
          text: image.caption ? `[image] ${image.caption}` : '[image]',
          id: key.id ?? undefined, p: key.participant ?? undefined,
          q: image.contextInfo?.stanzaId ?? undefined, pn: (key as any).participantPn ?? undefined,
          fw: image.contextInfo?.isForwarded ? true : undefined, image: file,
        })
      }).catch(() => {
        appendHistory(remoteJid, { ts: new Date().toISOString(), d: 'in', n: pushName ?? undefined, text: '[image: download failed]', id: key.id ?? undefined, p: key.participant ?? undefined })
      })
      return
    }

    // Voice notes and audio files are saved next to the history; the entry
    // points to the file so whoever reads the history can transcribe it.
    const audio = message?.audioMessage
    if (audio && !key.fromMe) {
      const isGroup = remoteJid.endsWith('@g.us')
      if (isGroup && !key.participant) return
      const id = key.id ?? String(Date.now())
      service.downloadMedia({ key, message }).then((buf) => {
        mkdirSync(MEDIA_DIR, { recursive: true, mode: 0o700 })
        const file = join(MEDIA_DIR, mediaName(id, 'ogg'))
        writeFileSync(file, buf, { mode: 0o600, flag: 'wx' })
        appendHistory(remoteJid, {
          ts: new Date().toISOString(),
          d: 'in',
          n: pushName ?? undefined,
          text: '[audio]',
          id: key.id ?? undefined,
          p: key.participant ?? undefined,
          q: audio.contextInfo?.stanzaId ?? undefined,
          pn: (key as any).participantPn ?? undefined,
          fw: audio.contextInfo?.isForwarded ? true : undefined,
          audio: file,
          sec: audio.seconds ?? undefined,
        })
      }).catch(() => {
        // download failed: record that an audio arrived so it is not silently lost
        appendHistory(remoteJid, { ts: new Date().toISOString(), d: 'in', n: pushName ?? undefined, text: '[audio: download failed]', id: key.id ?? undefined, p: key.participant ?? undefined })
      })
      return
    }

    // Wrapped messages (ephemeral, view once, edited) carry the content inside.
    const inner: any = (message as any)?.ephemeralMessage?.message ?? (message as any)?.viewOnceMessage?.message ?? (message as any)?.viewOnceMessageV2?.message ?? (message as any)?.editedMessage?.message?.protocolMessage?.editedMessage ?? message
    const kind = inner ? Object.keys(inner).find((k) => k !== 'messageContextInfo') : undefined
    const text =
      inner?.conversation ??
      inner?.extendedTextMessage?.text ??
      inner?.imageMessage?.caption ??
      inner?.videoMessage?.caption ??
      inner?.documentMessage?.caption ??
      // Non-text types (sticker, document, location...): record that it arrived instead of dropping it silently.
      (kind && !key.fromMe && kind !== 'protocolMessage' && kind !== 'reactionMessage' && kind !== 'senderKeyDistributionMessage' ? `[non-text message: ${kind}]` : undefined)
    if (!text) return
    // contextInfo of the part that carries the text: quote and "forwarded" also apply to captions and wrappers.
    const ctx = inner?.extendedTextMessage?.contextInfo ?? inner?.imageMessage?.contextInfo ?? inner?.videoMessage?.contextInfo ?? inner?.documentMessage?.contextInfo ?? (kind ? inner?.[kind]?.contextInfo : undefined)

    if (key.fromMe) {
      appendHistory(remoteJid, {
        ts: new Date().toISOString(),
        d: 'out',
        text,
        id: key.id ?? undefined,
      })
      return
    }

    const isGroup = remoteJid.endsWith('@g.us')
    const participant = key.participant
    if (isGroup && !participant) return

    appendHistory(remoteJid, {
      ts: new Date().toISOString(),
      d: 'in',
      n: pushName ?? undefined,
      text,
      // id and sender let `whatzap reply` quote the message and mention its author
      id: key.id ?? undefined,
      p: participant ?? undefined,
      // id of the message this one replies to, when it quotes another
      q: ctx?.stanzaId ?? undefined,
      // sender's phone JID as reported by the server (groups address people by LID)
      pn: (key as any).participantPn ?? undefined,
      // forwarded text was written by someone else; never treat it as the sender's own words
      fw: ctx?.isForwarded ? true : undefined,
    })
  })

  writeFileSync(PID_PATH, String(process.pid))

  if (existsSync(SOCK_PATH)) unlinkSync(SOCK_PATH)

  server = net.createServer((socket) => {
    let buf = ''
    socket.on('data', (chunk) => {
      buf += chunk.toString()
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        if (line.trim()) handleRequest(line, socket).catch(() => {})
      }
    })
    socket.on('error', () => {})
  })

  server.listen(SOCK_PATH)

  process.on('SIGTERM', cleanup)
  process.on('SIGINT', cleanup)
}

main().catch(() => process.exit(1))
