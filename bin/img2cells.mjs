#!/usr/bin/env node
// Decode an image (PNG, JPEG, GIF, BMP, WebP), fit it into a box of terminal cells, print JSON for the mod:
//   node img2cells.mjs <file> <maxColumns> <maxRows> [--pixels]
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { inflateSync } from 'node:zlib'
import { pathToFileURL } from 'node:url'

const decodeJpeg = createRequire(import.meta.url)('./jpeg-decoder.cjs')

// Dispatch on the magic bytes, not the extension. Every decoder returns { w, h, rgb } (alpha over black).
export function decode(buf, file) {
  if (buf.length < 12) throw new Error('unsupported image format (PNG, JPEG, GIF, BMP and WebP are supported)')
  const magic = buf.toString('latin1', 0, 12)
  if (buf.readUInt32BE(0) === 0x89504e47) return decodePng(buf)
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return decodeJpg(buf)
  if (magic.startsWith('GIF8')) return decodeGif(buf)
  if (magic.startsWith('BM')) return decodeBmp(buf)
  if (magic.startsWith('RIFF') && magic.slice(8) === 'WEBP') return decodeWebp(file)
  throw new Error('unsupported image format (PNG, JPEG, GIF, BMP and WebP are supported)')
}

function decodeJpg(buf) {
  const { width: w, height: h, data } = decodeJpeg(buf, { useTArray: true, formatAsRGBA: false })
  return { w, h, rgb: data }
}

// ponytail: first frame only; an animated GIF is shown as a still.
function decodeGif(buf) {
  const w = buf.readUInt16LE(6)
  const h = buf.readUInt16LE(8)
  let global = null
  let p = 13
  if (buf[10] & 0x80) {
    const n = 3 << ((buf[10] & 7) + 1)
    global = buf.subarray(p, p + n)
    p += n
  }
  let transparent = -1
  while (p < buf.length) {
    const tag = buf[p++]
    if (tag === 0x21) {
      if (buf[p] === 0xf9 && buf[p + 2] & 1) transparent = buf[p + 5]
      p++
      for (let n; (n = buf[p]); ) p += n + 1
      p++
    } else if (tag === 0x2c) {
      const left = buf.readUInt16LE(p)
      const top = buf.readUInt16LE(p + 2)
      const fw = buf.readUInt16LE(p + 4)
      const fh = buf.readUInt16LE(p + 6)
      const flags = buf[p + 8]
      p += 9
      let palette = global
      if (flags & 0x80) {
        const n = 3 << ((flags & 7) + 1)
        palette = buf.subarray(p, p + n)
        p += n
      }
      if (!palette) throw new Error('GIF has no color table')
      const min = buf[p++]
      const parts = []
      for (let n; (n = buf[p]); p += n + 1) parts.push(buf.subarray(p + 1, p + 1 + n))
      const index = lzw(Buffer.concat(parts), min, fw * fh)
      // Interlaced rows come in four passes: every 8th from 0, every 8th from 4, every 4th from 2, every 2nd from 1.
      const rows = [...Array(fh).keys()]
      if (flags & 0x40) {
        const order = []
        for (const [start, step] of [[0, 8], [4, 8], [2, 4], [1, 2]])
          for (let y = start; y < fh; y += step) order.push(y)
        order.forEach((y, i) => (rows[i] = y))
      }
      const rgb = new Uint8Array(w * h * 3)
      for (let i = 0; i < fh; i++)
        for (let x = 0; x < fw; x++) {
          const c = index[i * fw + x]
          const X = left + x
          const Y = top + rows[i]
          if (c === transparent || X >= w || Y >= h) continue
          rgb.set(palette.subarray(c * 3, c * 3 + 3), (Y * w + X) * 3)
        }
      return { w, h, rgb }
    } else break
  }
  throw new Error('GIF has no image')
}

function lzw(data, min, count) {
  const out = new Uint8Array(count)
  const prefix = new Int32Array(4096)
  const suffix = new Uint8Array(4096)
  const stack = new Uint8Array(4097)
  const clear = 1 << min
  const end = clear + 1
  let size = min + 1
  let next = end + 1
  let prev = -1
  let first = 0
  let bits = 0
  let acc = 0
  let o = 0
  for (let i = 0; i < clear; i++) suffix[i] = i
  for (let p = 0; o < count; ) {
    while (bits < size && p < data.length) {
      acc |= data[p++] << bits
      bits += 8
    }
    if (bits < size) break
    const code = acc & ((1 << size) - 1)
    acc >>>= size
    bits -= size
    if (code === clear) {
      size = min + 1
      next = end + 1
      prev = -1
      continue
    }
    if (code === end) break
    if (prev === -1) {
      out[o++] = first = suffix[code]
      prev = code
      continue
    }
    let c = code
    let top = 0
    if (c >= next) {
      stack[top++] = first
      c = prev
    }
    while (c >= clear) {
      stack[top++] = suffix[c]
      c = prefix[c]
    }
    stack[top++] = first = suffix[c]
    while (top && o < count) out[o++] = stack[--top]
    if (next < 4096) {
      prefix[next] = prev
      suffix[next++] = first
      if (next === 1 << size && size < 12) size++
    }
    prev = code
  }
  return out
}

// ponytail: uncompressed 24/32-bit only; palette and RLE BMPs are rejected.
function decodeBmp(buf) {
  const offset = buf.readUInt32LE(10)
  const w = buf.readInt32LE(18)
  const H = buf.readInt32LE(22)
  const bpp = buf.readUInt16LE(28)
  const compression = buf.readUInt32LE(30)
  if ((bpp !== 24 && bpp !== 32) || (compression !== 0 && compression !== 3))
    throw new Error(`BMP ${bpp}-bit compression ${compression} is not supported`)
  const h = Math.abs(H)
  const stride = Math.ceil((w * bpp) / 32) * 4
  // 32-bit BI_BITFIELDS names its channels with masks; otherwise B, G, R in memory order.
  const shifts = [16, 8, 0]
  if (bpp === 32 && compression === 3)
    for (let k = 0; k < 3; k++) shifts[k] = 31 - Math.clz32(buf.readUInt32LE(54 + k * 4) & -buf.readUInt32LE(54 + k * 4))
  const rgb = new Uint8Array(w * h * 3)
  for (let y = 0; y < h; y++) {
    const row = offset + (H > 0 ? h - 1 - y : y) * stride
    for (let x = 0; x < w; x++) {
      const s = row + x * (bpp / 8)
      if (bpp === 24) rgb.set([buf[s + 2], buf[s + 1], buf[s]], (y * w + x) * 3)
      else {
        const v = buf.readUInt32LE(s)
        rgb.set([(v >>> shifts[0]) & 255, (v >>> shifts[1]) & 255, (v >>> shifts[2]) & 255], (y * w + x) * 3)
      }
    }
  }
  return { w, h, rgb }
}

// ponytail: no pure-JS VP8 decoder; shell out to dwebp or ImageMagick for a PNG and decode that.
function decodeWebp(file) {
  const tries = [['dwebp', [file, '-o', '-']], ['magick', [file, 'png:-']]]
  for (const [cmd, args] of tries) {
    try {
      return decodePng(execFileSync(cmd, args, { maxBuffer: 1 << 29, stdio: ['ignore', 'pipe', 'ignore'] }))
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`${cmd} failed to convert the WebP file`)
    }
  }
  throw new Error('WebP needs dwebp or magick on PATH')
}

function decodePng(buf) {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG file')
  let w, h, depth, type, palette
  const idat = []
  for (let p = 8; p + 12 <= buf.length; ) {
    const len = buf.readUInt32BE(p)
    const tag = buf.toString('latin1', p + 4, p + 8)
    const data = buf.subarray(p + 8, p + 8 + len)
    if (tag === 'IHDR') {
      w = data.readUInt32BE(0)
      h = data.readUInt32BE(4)
      depth = data[8]
      type = data[9]
      if (data[12]) throw new Error('interlaced PNG is not supported')
    } else if (tag === 'PLTE') palette = data
    else if (tag === 'IDAT') idat.push(data)
    else if (tag === 'IEND') break
    p += 12 + len
  }
  if (depth !== 8 && depth !== 16) throw new Error(`bit depth ${depth} is not supported`)
  const bytes = depth / 8
  const bpp = [1, 0, 3, 1, 2, 0, 4][type] * bytes
  const stride = w * bpp
  const raw = inflateSync(Buffer.concat(idat))
  const px = Buffer.alloc(h * stride)
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)]
    const src = y * (stride + 1) + 1
    const dst = y * stride
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[dst + x - bpp] : 0
      const b = y ? px[dst + x - stride] : 0
      const c = x >= bpp && y ? px[dst + x - stride - bpp] : 0
      let pred = 0
      if (filter === 1) pred = a
      else if (filter === 2) pred = b
      else if (filter === 3) pred = (a + b) >> 1
      else if (filter === 4) {
        const pa = Math.abs(b - c)
        const pb = Math.abs(a - c)
        const pc = Math.abs(a + b - 2 * c)
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      px[dst + x] = (raw[src + x] + pred) & 255
    }
  }
  // Alpha is blended over black.
  const rgb = new Uint8Array(w * h * 3)
  for (let i = 0; i < w * h; i++) {
    const s = i * bpp
    let r, g, b, alpha = 255
    if (type === 3) [r, g, b] = palette.subarray(px[s] * 3, px[s] * 3 + 3)
    else if (type === 0 || type === 4) {
      r = g = b = px[s]
      if (type === 4) alpha = px[s + bytes]
    } else {
      r = px[s]
      g = px[s + bytes]
      b = px[s + 2 * bytes]
      if (type === 6) alpha = px[s + 3 * bytes]
    }
    rgb[i * 3] = (r * alpha) / 255
    rgb[i * 3 + 1] = (g * alpha) / 255
    rgb[i * 3 + 2] = (b * alpha) / 255
  }
  return { w, h, rgb }
}

// Box-average resample to W x H.
export function resize({ w, h, rgb }, W, H) {
  const out = new Uint8Array(W * H * 3)
  for (let Y = 0; Y < H; Y++) {
    const y0 = Math.floor((Y * h) / H)
    const y1 = Math.max(y0 + 1, Math.floor(((Y + 1) * h) / H))
    for (let X = 0; X < W; X++) {
      const x0 = Math.floor((X * w) / W)
      const x1 = Math.max(x0 + 1, Math.floor(((X + 1) * w) / W))
      let r = 0, g = 0, b = 0
      for (let y = y0; y < y1; y++)
        for (let x = x0; x < x1; x++) {
          const s = (y * w + x) * 3
          r += rgb[s]
          g += rgb[s + 1]
          b += rgb[s + 2]
        }
      const n = (y1 - y0) * (x1 - x0)
      out.set([r / n, g / n, b / n], (Y * W + X) * 3)
    }
  }
  return { w: W, h: H, rgb: out }
}

// A cell is about twice as tall as wide, so one cell holds two square pixels:
// '▀' with the upper pixel as foreground and the lower as background.
export function toView(image, maxColumns, maxRows, withPixels) {
  const scale = Math.min(maxColumns / image.w, (maxRows * 2) / image.h)
  const columns = Math.max(1, Math.round(image.w * scale))
  const rows = Math.max(1, Math.round((image.h * scale) / 2))
  const small = resize(image, columns, rows * 2)
  const words = new Uint32Array(columns * rows * 3)
  const color = (x, y) => {
    const s = (y * columns + x) * 3
    return (small.rgb[s] << 16) | (small.rgb[s + 1] << 8) | small.rgb[s + 2]
  }
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < columns; x++)
      words.set([0x2580, color(x, y * 2), color(x, y * 2 + 1)], (y * columns + x) * 3)
  const view = { columns, rows, cells: Buffer.from(words.buffer).toString('base64') }
  if (withPixels) {
    // ponytail: assumes 8x16 px cells; the terminal scales the picture to the box anyway.
    const big = resize(image, Math.min(columns * 8, 2048), Math.min(rows * 16, 2048))
    const rgba = Buffer.alloc(big.w * big.h * 4, 255)
    for (let i = 0; i < big.w * big.h; i++) rgba.set(big.rgb.subarray(i * 3, i * 3 + 3), i * 4)
    view.pixels = { rgba: rgba.toString('base64'), width: big.w, height: big.h }
  }
  return view
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [file, maxColumns, maxRows, flag] = process.argv.slice(2)
  try {
    const view = toView(decode(readFileSync(file), file), Number(maxColumns), Number(maxRows), flag === '--pixels')
    process.stdout.write(JSON.stringify(view))
  } catch (error) {
    process.stderr.write(String(error.message ?? error))
    process.exit(1)
  }
}
