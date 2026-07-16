import fs from 'node:fs'
import path from 'node:path'
import log from 'electron-log'
import { DEFAULT_SETTINGS, type Settings } from '@shared/types'

export { DEFAULT_SETTINGS }
export type { Settings }

const FILE = 'settings.json'

export class SettingsStore {
  private data: Settings
  private readonly file: string

  constructor(dir: string) {
    this.file = path.join(dir, FILE)
    this.data = { ...DEFAULT_SETTINGS }
    try {
      if (fs.existsSync(this.file)) {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<Settings>
        // Merge over defaults so new keys added in updates get defaults.
        this.data = { ...DEFAULT_SETTINGS, ...raw }
      }
    } catch (err) {
      log.scope('settings').warn('settings.json unreadable, using defaults', err)
    }
  }

  get(): Settings {
    return { ...this.data }
  }

  set(patch: Partial<Settings>): Settings {
    this.data = { ...this.data, ...patch }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2))
    } catch (err) {
      log.scope('settings').error('failed to persist settings', err)
    }
    return this.get()
  }
}
