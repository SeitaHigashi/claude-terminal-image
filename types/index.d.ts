export type Box = { columns: number; rows: number }

export type View = {
  path: string
  /** The room (in cells) the picture was fitted into; the pane refits when its own differs. */
  box?: Box
  columns: number
  rows: number
  /** Raster cells (RasterProps), one upper-half block per cell. */
  cells: string
  /** Absent with `--cells`: RGBA bytes for an `Image` of the same box. */
  pixels?: { rgba: string; width: number; height: number }
}

declare module 'claude-code' {
  interface PluginState {
    'terminal-image': { view: View | null }
  }
}
