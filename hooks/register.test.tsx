import { expect, mock, test } from 'claude-code/testing'
import type { CommandRunInput } from 'claude-code'

// One orange upper-half block, [0x2580, 0xff8800, 0x000000] as RasterProps
// packs it: what the helper prints for a 1x1-cell picture.
const CELLS = 'gCUAAACI/wAAAAAA'
const RAN = { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }

const PANE = {
  plugin: 'terminal-image',
  surface: 'terminal',
  component: 'Pane',
  requestId: 'terminal-image',
} as const
const PANE_PROPS = {
  title: 'a.png',
  isFocused: false,
  bodyColumns: 80,
  placement: 'inline',
  scroll: { offset: 0, bodyRows: 24 },
  view: {},
} as const

const img = (args: string): CommandRunInput => ({
  command: 'img',
  args,
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 120 },
})

test('/img --cells draws the helper output as a Raster in its pane', async ($, on) => {
  on('process.run', async () => ({
    value: { ...RAN, stdout: JSON.stringify({ columns: 1, rows: 1, cells: CELLS }) },
  }))
  on('ui.open', async () => ({ value: { isPlaced: true } }))

  const ran = await $.command.run(img('--cells a.png'))
  expect(ran.text).toBe('img: a.png as 1x1 cells')

  const ui = await $.ui.mount({ ...PANE, props: PANE_PROPS })
  expect(await ui.find({ key: 'picture' })).toMatchObject({ type: 'Raster' })
})

test('/img asks the helper for pixels and draws them as an Image', async ($, on) => {
  let argv: readonly string[] = []
  on('process.run', async (_$, e) => {
    argv = e.argv
    const pixels = { rgba: 'AAAA/w==', width: 1, height: 1 }

    return { value: { ...RAN, stdout: JSON.stringify({ columns: 1, rows: 1, cells: CELLS, pixels }) } }
  })
  on('ui.open', async () => ({ value: { isPlaced: true } }))

  const ran = await $.command.run(img('a.png'))
  expect(argv.at(-1)).toBe('--pixels')
  expect(ran.text).toBe('img: a.png as 1x1 cells (kitty graphics)')

  const ui = await $.ui.mount({ ...PANE, props: PANE_PROPS })
  expect(await ui.find({ type: 'Image' })).toBeDefined()
})

test('/img reports a helper failure instead of opening a pane', async ($, on) => {
  on('process.run', async () => ({ value: { ...RAN, exitCode: 1, stderr: 'not a PNG file' } }))

  expect((await $.command.run(img('a.txt'))).text).toBe('img: not a PNG file')
})

const PANE_MODE = { options: { display: 'pane' } }
const PIXELS = JSON.stringify({ columns: 1, rows: 1, cells: CELLS, pixels: { rgba: 'AAAA/w==', width: 1, height: 1 } })

test('with display=pane a Read of an image opens the pane; other files and a helper failure leave the Read alone', PANE_MODE, async ($, on) => {
  const opened: string[] = []
  let helper = { ...RAN, stdout: PIXELS }
  on('process.run', async () => ({ value: helper }))
  on('ui.open', async (_$, e) => {
    opened.push(e.title ?? '')

    return { value: { isPlaced: true } }
  })
  on('tool.call', { tool: 'Read' }, async () => ({ result: 'read' as never }))

  await $.tool.call({ tool: 'Read', file_path: '/x/notes.txt' })
  expect(opened).toEqual([])

  await $.tool.call({ tool: 'Read', file_path: '/x/A.PNG' })
  expect(opened).toEqual(['/x/A.PNG'])

  await $.tool.call({ tool: 'Read', file_path: '/x/photo.jpeg' })
  expect(opened).toEqual(['/x/A.PNG', '/x/photo.jpeg'])

  helper = { ...RAN, exitCode: 1, stderr: 'not a PNG file' }
  const ran = await $.tool.call({ tool: 'Read', file_path: '/x/broken.png' })
  expect(ran.deny).toBeUndefined()
  expect(opened).toEqual(['/x/A.PNG', '/x/photo.jpeg'])
})

test('with display=pane show_image opens the pane and reports a helper failure to the model', PANE_MODE, async ($, on) => {
  let helper = { ...RAN, stdout: PIXELS }
  on('process.run', async () => ({ value: helper }))
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  const call = (path: string) => $.tool.call({ tool: 'mcp__terminal-image__show_image', path } as never)

  expect((await call('/x/a.png')).result).toBe('img: /x/a.png as 1x1 cells (kitty graphics)')

  helper = { ...RAN, exitCode: 1, stderr: 'not a PNG file' }
  expect((await call('/x/a.txt')).deny).toBe('img: not a PNG file')
})

test('the picture is fitted again when the pane has another room than it was fitted to', async ($, on) => {
  const boxes: string[] = []
  on('process.run', async (_$, e) => {
    boxes.push(`${e.argv[3]}x${e.argv[4]}`)

    return { value: { ...RAN, stdout: PIXELS } }
  })
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  const clock = mock.clock(on)
  const draw = async (bodyColumns: number, bodyRows: number, waitMs: number) => {
    const ui = await $.ui.mount({ ...PANE, props: { ...PANE_PROPS, bodyColumns, scroll: { offset: 0, bodyRows } } })
    await clock.advance(waitMs)
    await ui.unmount()
  }

  await $.command.run(img('a.png'))
  await draw(80, 24, 300)
  expect(boxes).toEqual(['80x24'])

  // A resize in progress: each size is drawn, only the one it settles on is fitted.
  await draw(100, 30, 100)
  await draw(110, 35, 100)
  await draw(120, 40, 300)
  await draw(120, 40, 300)
  expect(boxes).toEqual(['80x24', '120x40'])
})

const ROW = { plugin: 'terminal-image', surface: 'terminal' } as const
const CALL = { isRunning: false, isErrored: false, isInterrupted: false, input: {} }

test('by default a Read of an image is drawn under its row and opens no pane', async ($, on) => {
  const opened: string[] = []
  on('process.run', async () => ({ value: { ...RAN, stdout: PIXELS } }))
  on('ui.open', async (_$, e) => {
    opened.push(e.title ?? '')

    return { value: { isPlaced: true } }
  })
  on('tool.call', { tool: 'Read' }, async () => ({ result: 'read' as never }))
  // The engine's own row, which the plugin's tree wraps.
  on('ui.render', async (engine, e) => {
    const { Text } = engine.ui.resolve(e)

    return <Text>the row</Text>
  })

  await $.tool.call({ tool: 'Read', file_path: '/x/a.png', tool_use_id: 't1' } as never)
  expect(opened).toEqual([])

  const props = { tool: 'Read', output: {}, isErrored: false }
  const mine = await $.ui.mount({ ...ROW, component: 'ToolResult', requestId: 't1', props: { ...props, tool_use_id: 't1' } })
  expect(await mine.find({ type: 'Image' })).toBeDefined()

  const other = await $.ui.mount({ ...ROW, component: 'ToolResult', requestId: 't2', props: { ...props, tool_use_id: 't2' } })
  expect(await other.find({ type: 'Image' })).toBeUndefined()

  const group = await $.ui.mount({
    ...ROW,
    component: 'ToolGroup',
    requestId: 'g1',
    props: { calls: [{ ...CALL, tool: 'Read', tool_use_id: 't1' }], isActive: false, isExpanded: false },
  })
  expect(await group.find({ type: 'Image' })).toBeDefined()
})

test('by default show_image answers with the picture size and a helper failure is denied', async ($, on) => {
  let helper = { ...RAN, stdout: PIXELS }
  on('process.run', async () => ({ value: helper }))
  const call = (path: string) => $.tool.call({ tool: 'mcp__terminal-image__show_image', path, tool_use_id: 't9' } as never)

  expect((await call('/x/a.png')).result).toBe('img: /x/a.png as 1x1 cells (kitty graphics)')

  helper = { ...RAN, exitCode: 1, stderr: 'not a PNG file' }
  expect((await call('/x/a.txt')).deny).toBe('img: not a PNG file')
})
