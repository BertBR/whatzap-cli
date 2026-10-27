import { ensureDaemon, replyViaDaemon } from '../daemon/client.js'

export async function reply(id: string, message: string, mentions: string[] = []): Promise<void> {
  await ensureDaemon()
  try {
    await replyViaDaemon(id, message, mentions)
    console.log('Reply sent.')
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exitCode = 1
  }
}
