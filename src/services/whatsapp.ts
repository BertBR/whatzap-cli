import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  ConnectionState,
  WASocket,
} from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import { homedir } from 'os'
import { join } from 'path'

export interface SendOptions {
  /** Message being replied to; WhatsApp shows it quoted above the reply. */
  quoted?: { key: { remoteJid: string; id: string; participant?: string; fromMe: boolean }; message: { conversation: string } }
  /** JIDs mentioned with @ in the text. */
  mentions?: string[]
}

const AUTH_DIR = join(homedir(), '.whatzap', 'auth')

const noopLogger = {
  level: 'silent',
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  child: () => noopLogger,
} as never

export class WhatsAppService {
  private socket: WASocket | null = null
  private msgCache = new Map<string, { conversation: string }>()

  async connect(onQR?: (qr: string) => void, onClose?: () => void): Promise<void> {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
    const { version } = await fetchLatestBaileysVersion()
    const MAX_RETRIES = 5

    return new Promise((resolve, reject) => {
      let attempts = 0
      let isConnected = false

      const attemptConnect = () => {
        const sock = makeWASocket({
          auth: state,
          version,
          printQRInTerminal: false,
          logger: noopLogger,
          getMessage: async (key) => this.msgCache.get(key.id ?? '') ?? { conversation: '' },
        })

        this.socket = sock
        sock.ev.on('creds.update', saveCreds)

        sock.ev.on('connection.update', (update: Partial<ConnectionState>) => {
          const { connection, lastDisconnect, qr } = update

          if (qr && onQR) {
            onQR(qr)
          }

          if (connection === 'open') {
            isConnected = true
            resolve()
          }

          if (connection === 'close') {
            if (isConnected) {
              // Connection dropped after being established — notify caller
              onClose?.()
              return
            }

            const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode
            const isLoggedOut = statusCode === DisconnectReason.loggedOut

            if (isLoggedOut) {
              reject(new Error(`Logged out. Please run 'whatzap login' again.`))
              return
            }

            attempts++
            if (attempts >= MAX_RETRIES) {
              reject(new Error(`Connection failed after ${MAX_RETRIES} attempts. Last status: ${statusCode ?? 'unknown'}`))
              return
            }

            // Transient failure — retry after a short delay
            this.socket = null
            setTimeout(attemptConnect, 1500)
          }
        })
      }

      attemptConnect()
    })
  }

  async sendMessage(jid: string, text: string, options: SendOptions = {}): Promise<void> {
    if (!this.socket) throw new Error('Not connected')
    // Resolve the canonical JID from WhatsApp's servers.
    // Brazilian numbers went through a 8→9 digit migration; the registered JID
    // may differ from what we constructed locally.
    if (jid.endsWith('@s.whatsapp.net')) {
      const phone = jid.replace('@s.whatsapp.net', '')
      const resolved = await this.resolvePhone(phone)
      if (resolved) jid = resolved
    }
    const result = await this.socket.sendMessage(
      jid,
      options.mentions?.length ? { text, mentions: options.mentions } : { text },
      options.quoted ? { quoted: options.quoted as any } : undefined
    )
    if (result?.key?.id) {
      this.msgCache.set(result.key.id, { conversation: text })
      if (this.msgCache.size > 500) {
        const oldest = this.msgCache.keys().next().value
        if (oldest !== undefined) this.msgCache.delete(oldest)
      }
    }
  }

  // Resolve a Brazilian phone number to the actual WhatsApp JID.
  // Tries both the 9-digit and 8-digit formats (Brazilian number migration).
  private async resolvePhone(phone: string): Promise<string | null> {
    if (!this.socket) return null

    const candidates = [phone]

    // Brazilian mobile: country code 55 + 2-digit area + number
    // If number part starts with 9 and has 9 digits → try without the leading 9
    // If number part has 8 digits → try adding 9
    if (phone.startsWith('55') && phone.length >= 12) {
      const area = phone.slice(2, 4)
      const number = phone.slice(4)
      if (number.length === 9 && number.startsWith('9')) {
        candidates.push('55' + area + number.slice(1)) // remove 9
      } else if (number.length === 8) {
        candidates.push('55' + area + '9' + number)    // add 9
      }
    }

    const results = await this.socket.onWhatsApp(...candidates)
    const match = results?.find((r) => r.exists)
    return match ? match.jid : null
  }

  async logout(): Promise<void> {
    if (this.socket) {
      try {
        await this.socket.logout()
      } catch {
        // ignore errors — server may close the connection immediately
      }
      this.socket = null
    }
  }

  async fetchGroups(): Promise<Record<string, string>> {
    if (!this.socket) throw new Error('Not connected')
    const groups = await this.socket.groupFetchAllParticipating()
    const result: Record<string, string> = {}
    for (const [jid, meta] of Object.entries(groups)) {
      result[jid] = meta.subject
    }
    return result
  }

  onMessage(handler: (msg: { key: import('@whiskeysockets/baileys').WAMessageKey; message: import('@whiskeysockets/baileys').WAMessage['message']; pushName?: string | null }) => void): void {
    if (!this.socket) throw new Error('Not connected')
    this.socket.ev.process((events) => {
      const upsert = events['messages.upsert']
      if (!upsert) return
      for (const msg of upsert.messages) {
        handler({ key: msg.key, message: msg.message, pushName: msg.pushName })
      }
    })
  }

  async disconnect(): Promise<void> {
    if (this.socket) {
      const origWrite = process.stdout.write.bind(process.stdout)
      process.stdout.write = () => true
      this.socket.end(undefined)
      this.socket = null
      await new Promise<void>((r) => setTimeout(r, 300))
      process.stdout.write = origWrite
    }
  }
}
