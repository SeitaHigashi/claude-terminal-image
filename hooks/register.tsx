import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Box, View } from '../types'

const PANE = 'terminal-image'
// The room the pane's body had at its last draw; the box before any draw.
// A module variable: a reload falls back to the default and the next draw refits.
let room: Box = { columns: 80, rows: 24 }
// The last refit asked for, so a failing one is not asked again at every draw.
let lastRefit = ''
// How long the pane's room must stay the same before the picture is fitted to it.
const SETTLE_MS = 300
let settling: Timer | undefined
const USAGE = 'Usage: /img [--cells] <image file>'
// A RegExp: the generated tool-name union only knows the mod's own tool after a reload.
const SHOW_TOOL = /^mcp__terminal-image__show_image$/
const view = atom({ plugin: 'terminal-image', key: 'view' } as const, null)

async function fit($: EngineInterface, path: string, isCells: boolean, box: Box): Promise<View | string> {
  const ran = await $.process.run([
    'node',
    `${$.plugin.root}/bin/img2cells.mjs`,
    path,
    String(box.columns),
    String(box.rows),
    ...(isCells ? [] : ['--pixels']),
  ])
  if (ran.exitCode !== 0) return ran.stderr || 'the helper failed'

  return { ...JSON.parse(ran.stdout), path, box }
}

async function show($: EngineInterface, path: string, isCells: boolean): Promise<{ text: string; isError?: true }> {
  const made = await fit($, path, isCells, room)
  if (typeof made === 'string') return { text: `img: ${made}`, isError: true }

  await update($, view, () => made)
  await $.ui.open({ id: PANE, title: path, rows: made.rows + 1 })

  return { text: `img: ${path} as ${made.columns}x${made.rows} cells${isCells ? '' : ' (kitty graphics)'}` }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'img',
      description: 'Show an image (PNG, JPEG, GIF, WebP, BMP) in a pane with kitty graphics (--cells: half-block cells instead)',
      argumentHint: '[--cells] <image file>',
    })
    await $.tool.register({
      name: 'show_image',
      description:
        'Show an image file (PNG, JPEG, GIF, WebP or BMP) to the user in a terminal pane. Call it after generating or saving an image the user will want to see. Reading an image with Read already shows it.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Absolute path of the image file' } },
        required: ['path'],
      },
      isDeferred: false,
    })

    return next(e)
  })

  on('command.run', { command: 'img' }, async ($, e) => {
    const args = e.args.trim()
    const isCells = args.startsWith('--cells')
    const path = (isCells ? args.slice('--cells'.length) : args).trim()
    if (!path) return { text: USAGE }

    return { text: (await show($, path, isCells)).text }
  })

  // Auto-display: an image the model reads shows up without typing /img.
  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && !ran.isError && /\.(png|jpe?g|gif|webp|bmp)$/i.test(e.file_path)) {
      // The picture is a side effect: a failure here must not fail the Read.
      await show($, e.file_path, false).catch(() => undefined)
    }

    return ran
  })

  on('tool.call', { tool: SHOW_TOOL }, async ($, e) => {
    const path = (e as { path?: unknown }).path
    if (typeof path !== 'string' || !path) return { deny: 'show_image: path is required' }
    const shown = await show($, path, false)

    return shown.isError ? { deny: shown.text } : { result: shown.text }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (e.surface !== 'terminal') return next(e)
    const { Box, Text, Raster, Image } = $.ui.resolve(e)
    const shown = await read($, view)
    if (!shown) return <Text dimColor>{USAGE}</Text>

    // Follow the pane: when its room is not the box the picture was fitted to, fit
    // again. A draw may not write state, so the write happens from a timer.
    room = { columns: Math.max(1, e.props.bodyColumns), rows: Math.max(1, e.props.scroll.bodyRows) }
    const { path } = shown
    const isCells = !shown.pixels
    const wanted = room
    const refit = `${path} ${isCells} ${wanted.columns}x${wanted.rows}`
    const isFitted = shown.box?.columns === wanted.columns && shown.box?.rows === wanted.rows
    // Each draw of a resize in progress puts the refit off again: it runs once, when the size has settled.
    settling?.cancel()
    settling = undefined
    if (!isFitted && refit !== lastRefit) {
      settling = $.clock.after(SETTLE_MS, async () => {
        lastRefit = refit
        const made = await fit($, path, isCells, wanted)
        // Keep a picture shown since: only the one this refit was for is replaced.
        if (typeof made !== 'string') await update($, view, now => (now?.path === path ? made : now))
      })
    }

    return (
      <Box flexDirection="column">
        {shown.pixels ? (
          <Image
            source={shown.pixels}
            columns={shown.columns}
            rows={shown.rows}
            alt={`${shown.path}: this terminal draws no kitty graphics here; run /img --cells`}
          />
        ) : (
          <Raster key="picture" columns={shown.columns} rows={shown.rows} cells={shown.cells} />
        )}
      </Box>
    )
  })
}
