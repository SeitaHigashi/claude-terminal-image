#!/usr/bin/env node
// Decode a PNG, fit it into a box of terminal cells, print JSON for the mod:
//   node png2cells.mjs <file.png> <maxColumns> <maxRows> [--pixels]
import { readFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'
import { pathToFileURL } from 'node:url'

// ponytail: PNG only (8/16-bit, non-interlaced); convert with imagemagick first if JPEG/WebP is ever needed.
export function decode(buf) {
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
    const view = toView(decode(readFileSync(file)), Number(maxColumns), Number(maxRows), flag === '--pixels')
    process.stdout.write(JSON.stringify(view))
  } catch (error) {
    process.stderr.write(String(error.message ?? error))
    process.exit(1)
  }
}
