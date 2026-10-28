#!/usr/bin/env node

import { login } from './commands/login.js'
import { logout } from './commands/logout.js'
import { sendMessage } from './commands/send-message.js'
import { stop } from './commands/stop.js'
import { findContact } from './commands/find-contact.js'
import { addWatch } from './commands/add-watch.js'
import { removeWatch } from './commands/remove-watch.js'
import { listWatch } from './commands/list-watch.js'
import { restart } from './commands/restart.js'
import { sendGroup } from './commands/send-group.js'
import { reply } from './commands/reply.js'
import { setting } from './commands/setting.js'
import { installSkill } from './commands/install-skill.js'
import { init } from './commands/init.js'


const [, , command, ...args] = process.argv

const USAGE = `whatzap — Send WhatsApp messages from the terminal

Usage:
  whatzap init                           First-time setup: install skill + authenticate
  whatzap login                          Authenticate with WhatsApp via QR code
  whatzap logout                         Log out and remove saved credentials
  whatzap send-message <phone> <message> Send a text message to a phone number
  whatzap send-group <group name> <message> Send a text message to a group
  whatzap reply [--mention <jid>]... <message id> <message>  Reply quoting a recorded message and mentioning its sender
  whatzap find-contact <query>           Search macOS Contacts by name, returns JSON
  whatzap stop                           Stop the background session
  whatzap add-watch <phone|group name>    Start recording messages for a contact or group
  whatzap remove-watch <phone|group name> Stop recording messages for a contact or group
  whatzap list-watch                      List watched contacts and groups
  whatzap restart                         Restart the background session
  whatzap setting set default-country-code <code>  Set default country code (e.g. 55, 1, 44)
  whatzap install-skill                  Install the Claude Code skill to ~/.claude/skills/

Examples:
  whatzap login
  whatzap logout
  whatzap send-message +5511999999999 Hello!
  whatzap send-message +5511999999999 Multi word message works too
  whatzap send-group familia Oi pessoal!
  whatzap setting set default-country-code 55
  whatzap install-skill
  whatzap stop`

async function main() {
  switch (command) {
    case 'init':
      await init()
      break

    case 'login':
      await login()
      break

    case 'logout':
      await logout()
      break

    case 'send-message': {
      const [phone, ...rest] = args
      const message = rest.join(' ')
      if (!phone || !message) {
        console.error(USAGE)
        process.exit(1)
      }
      await sendMessage(phone, message)
      break
    }

    case 'find-contact': {
      const query = args.join(' ')
      await findContact(query)
      break
    }

    case 'stop':
      await stop()
      break

    case 'add-watch': {
      const input = args.join(' ')
      if (!input) {
        console.error('Usage: whatzap add-watch <phone|group name>')
        process.exit(1)
      }
      await addWatch(input)
      break
    }

    case 'remove-watch': {
      const input = args.join(' ')
      if (!input) {
        console.error('Usage: whatzap remove-watch <phone|group name>')
        process.exit(1)
      }
      await removeWatch(input)
      break
    }

    case 'list-watch':
      await listWatch()
      break

    case 'send-group': {
      if (args.length < 2) {
        console.error(USAGE)
        process.exit(1)
      }
      await sendGroup(args)
      break
    }

    case 'reply': {
      // --mention <jid> (repeatable) mentions more people; the text must carry "@<number>" for each
      const extra: string[] = []
      // accepted anywhere, so a flag placed after the text never leaks into the message
      for (let i = args.indexOf('--mention'); i !== -1 && args[i + 1]; i = args.indexOf('--mention')) {
        extra.push(args[i + 1]); args.splice(i, 2)
      }
      const [id, ...rest] = args
      const message = rest.join(' ')
      if (!id || !message) {
        console.error('Usage: whatzap reply <message id> <message>')
        process.exit(1)
      }
      await reply(id, message, extra)
      break
    }

    case 'reply-audio': {
      const [id, file] = args
      if (!id || !file) {
        console.error('Usage: whatzap reply-audio <message id> <file.ogg>')
        process.exit(1)
      }
      const { ensureDaemon, replyAudioViaDaemon } = await import('./daemon/client.js')
      const { resolve } = await import('path')
      await ensureDaemon()
      try { await replyAudioViaDaemon(id, resolve(file)); console.log('Voice reply sent.') }
      catch (err) { console.error(err instanceof Error ? err.message : String(err)); process.exitCode = 1 }
      break
    }

    case 'restart':
      await restart()
      break

    case 'setting':
      setting(args)
      break

    case 'install-skill':
      installSkill()
      break

    case '--help':
    case '-h':
    case 'help':
      console.log(USAGE)
      break

    default:
      console.error(USAGE)
      process.exit(1)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
}).finally(() => {
  process.exit(process.exitCode ?? 0)
})
