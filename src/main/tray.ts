import { app, Menu, Tray, nativeImage, BrowserWindow } from 'electron'
import { APP_NAME } from '@shared/constants'

// Minimal 16x16 mic glyph as a data URL so we need no binary asset for the tray
// (the installer icon lives in build/icon.ico; this is only the tray fallback).
const TRAY_ICON_DATAURL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAdElEQVR4nGNgGGjACCP+//8vzMDAcJmBgeE/AwPDFQYGhkuMjIxPsGlgYmBgYGBkZPzPyMh4H8q/CjUAJ2CBc/7/Z2ZgYFBjYGBQY2BgSGJgYPjHyMh4EqcXsLkKlwGMKArwuOI/AwODAiMj4zNsihkZGe8DAPU/HeYCzGDhAAAAAElFTkSuQmCC'

export interface TrayController {
  tray: Tray
  setStatus(text: string): void
  destroy(): void
}

export function createTray(win: BrowserWindow, onQuit: () => void): TrayController {
  const icon = nativeImage.createFromDataURL(TRAY_ICON_DATAURL)
  const tray = new Tray(icon)
  tray.setToolTip(APP_NAME)

  const show = (): void => {
    win.show()
    win.focus()
  }

  const menu = Menu.buildFromTemplate([
    { label: 'Show window', click: show },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        onQuit()
        app.quit()
      }
    }
  ])
  tray.setContextMenu(menu)
  tray.on('click', show)

  return {
    tray,
    setStatus: (text: string) => tray.setToolTip(`${APP_NAME} — ${text}`),
    destroy: () => tray.destroy()
  }
}
