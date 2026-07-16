// Generates build/icon.ico (256x256 PNG-in-ICO) — a white mic glyph on a blue
// disc — with zero image dependencies. Run: node scripts/gen-icon.mjs
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'

const SIZE = 256

// ---- draw into an RGBA buffer ----
const px = Buffer.alloc(SIZE * SIZE * 4)
const put = (x, y, r, g, b, a = 255) => {
  const i = (y * SIZE + x) * 4
  px[i] = r
  px[i + 1] = g
  px[i + 2] = b
  px[i + 3] = a
}

const inCapsule = (x, y, cx, y0, y1, radius) => {
  if (y >= y0 && y <= y1 && Math.abs(x - cx) <= radius) return true
  const dTop = Math.hypot(x - cx, y - y0)
  const dBot = Math.hypot(x - cx, y - y1)
  return dTop <= radius || dBot <= radius
}

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const dc = Math.hypot(x - 128, y - 128)
    if (dc > 124) continue // transparent outside the disc
    // blue disc with subtle vertical shade
    const shade = 1 - (y / SIZE) * 0.25
    put(x, y, Math.round(79 * shade), Math.round(140 * shade), Math.round(255 * shade))

    let glyph = false
    // mic capsule
    if (inCapsule(x, y, 128, 72, 128, 26)) glyph = true
    // U-shaped cradle: lower half ring around (128,130)
    const dr = Math.hypot(x - 128, y - 130)
    if (y >= 130 && dr >= 44 && dr <= 56) glyph = true
    // handle
    if (Math.abs(x - 128) <= 7 && y >= 184 && y <= 206) glyph = true
    // base
    if (inCapsule(x, y, 128, 210, 210, 8) && Math.abs(x - 128) <= 34) glyph = true
    if (y >= 203 && y <= 217 && Math.abs(x - 128) <= 34) glyph = true

    if (glyph) put(x, y, 255, 255, 255)
  }
}

// ---- encode PNG ----
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

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(SIZE, 0)
ihdr.writeUInt32BE(SIZE, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 6 // RGBA
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1))
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0 // filter: none
  px.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4)
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
])

// ---- wrap in ICO (single 256x256 PNG entry) ----
const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0) // reserved
header.writeUInt16LE(1, 2) // type: icon
header.writeUInt16LE(1, 4) // count
const entry = Buffer.alloc(16)
entry[0] = 0 // width 256 -> 0
entry[1] = 0 // height 256 -> 0
entry.writeUInt16LE(1, 4) // planes
entry.writeUInt16LE(32, 6) // bpp
entry.writeUInt32LE(png.length, 8)
entry.writeUInt32LE(22, 12) // offset

mkdirSync('build', { recursive: true })
writeFileSync('build/icon.ico', Buffer.concat([header, entry, png]))
writeFileSync('build/icon.png', png)
console.log(`wrote build/icon.ico (${png.length + 22} bytes)`)
