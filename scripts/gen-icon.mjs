// Generates the app icon (build/icon.ico + icon.png) and the MSIX/Store logo
// assets (build/appx/*.png) — a white mic glyph on a blue disc — with zero
// image dependencies. Run: node scripts/gen-icon.mjs
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'

// ---- draw the mic-on-disc glyph into an RGBA buffer at any canvas size ----
function render(width, height) {
  const px = Buffer.alloc(width * height * 4)
  const cx = width / 2
  const cy = height / 2
  const s = Math.min(width, height) / 256 // glyph designed on a 256 grid

  const put = (x, y, r, g, b, a = 255) => {
    const i = (y * width + x) * 4
    px[i] = r
    px[i + 1] = g
    px[i + 2] = b
    px[i + 3] = a
  }

  const inCapsule = (x, y, capX, y0, y1, radius) => {
    if (y >= y0 && y <= y1 && Math.abs(x - capX) <= radius) return true
    return Math.hypot(x - capX, y - y0) <= radius || Math.hypot(x - capX, y - y1) <= radius
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (Math.hypot(x - cx, y - cy) > 124 * s) continue // transparent outside disc
      const shade = 1 - (y / height) * 0.25
      put(x, y, Math.round(79 * shade), Math.round(140 * shade), Math.round(255 * shade))

      // glyph coordinates on the 256 design grid, centered on (cx, cy)
      const gx = (x - cx) / s + 128
      const gy = (y - cy) / s + 128
      let glyph = false
      if (inCapsule(gx, gy, 128, 72, 128, 26)) glyph = true
      const dr = Math.hypot(gx - 128, gy - 130)
      if (gy >= 130 && dr >= 44 && dr <= 56) glyph = true
      if (Math.abs(gx - 128) <= 7 && gy >= 184 && gy <= 206) glyph = true
      if (gy >= 203 && gy <= 217 && Math.abs(gx - 128) <= 34) glyph = true
      if (glyph) put(x, y, 255, 255, 255)
    }
  }
  return px
}

// ---- PNG encoder ----
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (buf) => {
  let c = 0xffffffff
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])))
  return Buffer.concat([len, typeBuf, data, crc])
}

function encodePng(px, width, height) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  const raw = Buffer.alloc(height * (width * 4 + 1))
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0 // filter: none
    px.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

const pngAt = (w, h) => encodePng(render(w, h), w, h)

// ---- main icon: 256 PNG wrapped in ICO ----
const png256 = pngAt(256, 256)
const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0)
header.writeUInt16LE(1, 2) // type: icon
header.writeUInt16LE(1, 4) // count
const entry = Buffer.alloc(16)
entry[0] = 0 // width 256
entry[1] = 0 // height 256
entry.writeUInt16LE(1, 4) // planes
entry.writeUInt16LE(32, 6) // bpp
entry.writeUInt32LE(png256.length, 8)
entry.writeUInt32LE(22, 12) // offset

mkdirSync('build/appx', { recursive: true })
writeFileSync('build/icon.ico', Buffer.concat([header, entry, png256]))
writeFileSync('build/icon.png', png256)

// ---- MSIX / Microsoft Store assets ----
const appxAssets = {
  'StoreLogo.png': [50, 50],
  'Square44x44Logo.png': [44, 44],
  'Square150x150Logo.png': [150, 150],
  'Square310x310Logo.png': [310, 310],
  'Wide310x150Logo.png': [310, 150]
}
for (const [name, [w, h]] of Object.entries(appxAssets)) {
  writeFileSync(`build/appx/${name}`, pngAt(w, h))
}
console.log(`wrote build/icon.ico and ${Object.keys(appxAssets).length} appx assets`)
