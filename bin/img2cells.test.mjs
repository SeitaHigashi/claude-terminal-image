// Run: node --test bin/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { decode } from './img2cells.mjs'

const fixture = name => new URL(`./fixtures/${name}`, import.meta.url).pathname
const load = name => decode(readFileSync(fixture(name)), fixture(name))
const png = load('a.png')
const meanDiff = img => {
  assert.equal(`${img.w}x${img.h}`, `${png.w}x${png.h}`)
  let sum = 0
  for (let i = 0; i < png.rgb.length; i++) sum += Math.abs(img.rgb[i] - png.rgb[i])
  return sum / png.rgb.length
}
const hasCommand = cmd => {
  try {
    execFileSync(cmd, ['-version'], { stdio: 'ignore' })
    return true
  } catch (error) {
    return error.code !== 'ENOENT'
  }
}

// The fixture is a 16x12 gradient with two flat blocks; a row or channel mix-up moves the mean a lot.
const cases = [
  ['a.jpg', 6],
  ['a-progressive.jpg', 6],
  ['a.gif', 10],
  ['a-interlaced.gif', 10],
  ['a-24.bmp', 1],
  ['a-32.bmp', 1],
]
for (const [name, bound] of cases)
  test(`decodes ${name}`, () => assert.ok(meanDiff(load(name)) <= bound))

test('decodes a.webp', { skip: !(hasCommand('dwebp') || hasCommand('magick')) && 'needs dwebp or magick' }, () => {
  assert.ok(meanDiff(load('a.webp')) <= 1)
})

test('rejects unknown data', () => {
  assert.throws(() => decode(Buffer.from('not an image at all'), 'x.txt'), /unsupported image format/)
})
