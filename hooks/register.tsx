import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { View } from '../types'

const PANE = 'terminal-image'
// ponytail: fixed box; read the pane's viewport and re-run the helper if it should follow a resize.
const MAX_COLUMNS = 80
const MAX_ROWS = 24
const USAGE = 'Usage: /img [--cells] <file.png>'
// A RegExp: the generated tool-name union only knows the mod's own tool after a reload.
const SHOW_TOOL = /^mcp__terminal-image__show_image$/
const view = atom({ plugin: 'terminal-image', key: 'view' } as const, null)

async function show($: EngineInterface, path: string, isCells: boolean): Promise<{ text: string; isError?: true }> {
  const ran = await $.process.run([
    'node',
    `${$.plugin.root}/bin/png2cells.mjs`,
    path,
    String(MAX_COLUMNS),
    String(MAX_ROWS),
    ...(isCells ? [] : ['--pixels']),
  ])
  if (ran.exitCode !== 0) return { text: `img: ${ran.stderr || 'the helper failed'}`, isError: true }

  const made: View = { ...JSON.parse(ran.stdout), path }
  await update($, view, () => made)
  await $.ui.open({ id: PANE, title: path, rows: made.rows + 1 })

  return { text: `img: ${path} as ${made.columns}x${made.rows} cells${isCells ? '' : ' (kitty graphics)'}` }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'img',
      description: 'Show a PNG in a pane with kitty graphics (--cells: half-block cells instead)',
      argumentHint: '[--cells] <file.png>',
    })
    await $.tool.register({
      name: 'show_image',
      description:
        'Show a PNG file to the user in a terminal pane. Call it after generating or saving an image the user will want to see. Reading a .png with Read already shows it.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Absolute path of the PNG file' } },
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

  // Auto-display: a PNG the model reads shows up without typing /img.
  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && !ran.isError && /\.png$/i.test(e.file_path)) {
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
