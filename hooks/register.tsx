import type { EngineInterface, Register } from 'claude-code'

// ![alt](target "optional title")  ·  target may be <wrapped in angle brackets> to hold spaces
const IMAGE_LINK = /!\[([^\]]*)\]\(\s*(<[^>\n]+>|[^)\s]+)(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/g
const REMOTE = /^https?:\/\//i

const MAX_PAYLOAD = 1_900_000 // an Image source is capped at 2 MiB decoded
const GUTTER = 4 // bullet + indent + right margin, in cells
const CONVERT_TIMEOUT_MS = 20_000
const TOO_BIG = 'image too large even after scaling'
const SCALE_LADDER = [1280, 960, 720, 480] // longest side, tried in turn until the PNG fits
const EXACT_LADDER = [1, 0.85, 0.7, 0.55, 0.4] // box scale, tried in turn until the exact raster fits

type Options = {
  maxColumns?: number
  maxRows?: number
  maxImages?: number
  cellAspect?: number
  cellWidthPx?: number
  cellHeightPx?: number
  allowRemote?: boolean
}

type Loaded = { base64: string; width: number; height: number }

// Everything one activation of the module shares.
type Cell = { width: number; height: number }

type Ctx = {
  allowRemote: boolean
  detected?: { key: string; cell: Cell | null }
  workDir?: string
  counter: number
  cache: Map<string, Loaded>
}

const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)

// The engine's runtime has Uint8Array.fromBase64; the type library this module is checked against does not yet.
const fromBase64 = (Uint8Array as unknown as { fromBase64(text: string): Uint8Array }).fromBase64

// PNG IHDR: width at bytes 16-19, height at 20-23 (33 bytes = 44 base64 chars).
function pngSize(base64: string): { width: number; height: number } | null {
  const b = fromBase64(base64.slice(0, 44))
  if (b.length < 24 || b[1] !== 0x50 || b[2] !== 0x4e || b[3] !== 0x47) return null
  const u32 = (i: number) => (((b[i] ?? 0) << 24) | ((b[i + 1] ?? 0) << 16) | ((b[i + 2] ?? 0) << 8) | (b[i + 3] ?? 0)) >>> 0
  return { width: u32(16), height: u32(20) }
}

// Largest box (in cells) that holds the picture at its own aspect, within maxCols × maxRows.
function fitBox(width: number, height: number, maxCols: number, maxRows: number, cellAspect: number) {
  const natural = Math.max(4, Math.round(width / 10)) // small pictures stay small
  let cols = Math.min(maxCols, natural)
  let rows = Math.max(1, Math.round((cols * height) / width / cellAspect))
  if (rows > maxRows) {
    rows = maxRows
    cols = Math.max(1, Math.min(cols, Math.floor((rows * cellAspect * width) / height)))
  }
  return { cols, rows }
}

async function scratch($: EngineInterface, ctx: Ctx): Promise<string> {
  if (ctx.workDir) return ctx.workDir
  const made = await $.process.run(['mktemp', '-d', '-t', 'claude-inline-image.XXXXXX'])
  if (made.exitCode !== 0) throw new Error('no temp dir')
  ctx.workDir = made.stdout.trim()
  return ctx.workDir
}

async function tryRun($: EngineInterface, argv: string[]): Promise<boolean> {
  try {
    const r = await $.process.run(argv, { timeoutMs: CONVERT_TIMEOUT_MS })
    return r.exitCode === 0
  } catch {
    return false // tool not installed
  }
}

// Any format → PNG at width×height (shrunk to fit, or padded transparent to exactly that box when `pad`).
// First frame only for animations and multi-page files.
async function convert($: EngineInterface, src: string, out: string, width: number, height: number, pad: boolean) {
  const fit = `${width}x${height}`
  const im = (bin: string[]) => [
    ...bin,
    `${src}[0]`,
    '-auto-orient',
    '-resize',
    pad ? fit : `${fit}>`,
    ...(pad ? ['-background', 'none', '-gravity', 'center', '-extent', fit] : []),
    '-strip',
    `PNG32:${out}`,
  ]
  const attempts: string[][] = [
    im(['magick']),
    im(['convert']),
    im(['gm', 'convert']),
    [
      'ffmpeg', '-v', 'error', '-y', '-i', src, '-frames:v', '1', '-vf',
      pad
        ? `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black@0`
        : `scale='min(${width},iw)':-2`,
      out,
    ],
    ['rsvg-convert', '-w', String(width), '-o', out, src],
  ]
  for (const argv of attempts) {
    if (await tryRun($, argv)) return true
  }
  return false
}

async function resolvePath($: EngineInterface, target: string): Promise<string> {
  let p = target.startsWith('<') ? target.slice(1, -1) : target
  if (p.startsWith('file://')) p = decodeURIComponent(p.slice(7))
  if (p === '~' || p.startsWith('~/')) p = `${(await $.env.get('HOME')) ?? ''}${p.slice(1)}`
  return p
}

async function load(
  $: EngineInterface,
  ctx: Ctx,
  target: string,
  width: number,
  height: number,
  pad: boolean,
): Promise<Loaded> {
  const dir = await scratch($, ctx)
  let path = await resolvePath($, target)

  if (REMOTE.test(path)) {
    if (!ctx.allowRemote) throw new Error('remote images are off (set allowRemote)')
    const dest = `${dir}/remote-${ctx.counter++}`
    const ok = await tryRun($, ['curl', '-fsSL', '--max-time', '15', '--max-filesize', '25000000', '-o', dest, path])
    if (!ok) throw new Error('download failed')
    path = dest
  }

  const stat = await $.fs.stat(path)
  if (stat.kind !== 'file') throw new Error('not a file')

  const key = `${path}|${stat.mtimeMs}|${stat.size}|${width}x${height}|${pad}`
  const hit = ctx.cache.get(key)
  if (hit) return hit

  // Fast path: a PNG that already fits the payload cap needs no conversion.
  if (!pad && stat.size <= MAX_PAYLOAD) {
    const { base64 } = await $.fs.read(path, { as: 'bytes' })
    const size = pngSize(base64)
    if (size) {
      const loaded = { base64, ...size }
      ctx.cache.set(key, loaded)
      return loaded
    }
  }

  const out = `${dir}/out-${ctx.counter++}.png`
  if (!(await convert($, path, out, width, height, pad))) {
    throw new Error('could not decode (is ImageMagick installed?)')
  }
  const { base64 } = await $.fs.read(out, { as: 'bytes' })
  const size = pngSize(base64)
  if (!size) throw new Error('conversion produced no PNG')
  if (base64.length * 0.75 > MAX_PAYLOAD) throw new Error(TOO_BIG)
  const loaded = { base64, ...size }
  ctx.cache.set(key, loaded)
  return loaded
}

// Natural-aspect load: shrink until the PNG fits the payload cap.
async function loadFit($: EngineInterface, ctx: Ctx, target: string): Promise<Loaded> {
  for (const cap of SCALE_LADDER) {
    try {
      return await load($, ctx, target, cap, cap, false)
    } catch (err) {
      if (!(err instanceof Error) || err.message !== TOO_BIG) throw err
    }
  }
  throw new Error(TOO_BIG)
}

// Cell size in pixels from the tty's own window size (kitty, Ghostty, WezTerm, foot and others fill it in).
// Terminals that leave it at zero return null; set cellWidthPx / cellHeightPx for those.
const WINSIZE_PY =
  "import os,fcntl,termios,struct;" +
  "fd=os.open('/dev/tty',os.O_RDONLY);" +
  "r,c,x,y=struct.unpack('HHHH',fcntl.ioctl(fd,termios.TIOCGWINSZ,b'\\0'*8));" +
  "print(r,c,x,y)"

async function detectCell($: EngineInterface, ctx: Ctx, columns: number): Promise<Cell | null> {
  const key = String(columns)
  if (ctx.detected?.key === key) return ctx.detected.cell
  let cell: Cell | null = null
  try {
    const r = await $.process.run(['python3', '-c', WINSIZE_PY], { timeoutMs: 3000 })
    const [rows = 0, cols = 0, xpx = 0, ypx = 0] = r.stdout.trim().split(/\s+/).map(Number)
    if (r.exitCode === 0 && rows > 0 && cols > 0 && xpx > 0 && ypx > 0) cell = { width: xpx / cols, height: ypx / rows }
  } catch {
    cell = null
  }
  ctx.detected = { key, cell }
  return cell
}

// INLINE_IMAGE_CELL_PX=22x47 (width x height of one cell, in pixels): for terminals that do not report it.
async function envCell($: EngineInterface): Promise<Cell | null> {
  const raw = await $.env.get('INLINE_IMAGE_CELL_PX')
  const m = raw?.trim().match(/^(\d+(?:\.\d+)?)\s*[x×,]\s*(\d+(?:\.\d+)?)$/i)
  const width = Number(m?.[1])
  const height = Number(m?.[2])
  return width > 0 && height > 0 ? { width, height } : null
}

export const register: Register = (on, options) => {
  const cfg = (options ?? {}) as Options
  const maxColumns = Math.max(4, Math.min(255, num(cfg.maxColumns, 80)))
  const maxRows = Math.max(1, Math.min(255, num(cfg.maxRows, 24)))
  const maxImages = Math.max(1, Math.min(12, num(cfg.maxImages, 4)))
  const cellWidthPx = Math.max(0, num(cfg.cellWidthPx, 0))
  const cellHeightPx = Math.max(0, num(cfg.cellHeightPx, 0))
  const configured: Cell | null = cellWidthPx > 0 && cellHeightPx > 0 ? { width: cellWidthPx, height: cellHeightPx } : null
  const cellAspect = Math.max(1, num(cfg.cellAspect, 2.1))
  const ctx: Ctx = { allowRemote: cfg.allowRemote === true, counter: 0, cache: new Map() }

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const text = e.props.text
    const found = [...text.matchAll(IMAGE_LINK)]
    if (found.length === 0) return next(e)

    if (e.surface !== 'terminal') return next(e) // Image is the terminal surface's element
    const { Box, Text, Image } = $.ui.resolve(e)
    const columns = e.viewport?.columns ?? 80
    const room = Math.max(4, Math.min(maxColumns, columns - GUTTER))
    const cell = configured ?? (await envCell($)) ?? (await detectCell($, ctx, columns))
    const aspect = cell ? cell.height / cell.width : cellAspect
    const shots = []

    for (const match of found.slice(0, maxImages)) {
      const alt = match[1] ?? ''
      const target = match[2] ?? ''
      try {
        // Measure first (a bounded raster), then size the box from the picture's own aspect.
        const probe = await loadFit($, ctx, target)
        let box = fitBox(probe.width, probe.height, room, maxRows, aspect)
        let shown = probe
        if (cell) {
          // A raster the exact pixel size of its box draws without hairlines between rows. Shrink the
          // box until the PNG fits the payload cap; if nothing fits, keep the natural-size raster.
          for (const f of EXACT_LADDER) {
            const b = fitBox(probe.width, probe.height, Math.max(4, Math.floor(room * f)), Math.max(1, Math.floor(maxRows * f)), aspect)
            try {
              shown = await load($, ctx, target, Math.round(b.cols * cell.width), Math.round(b.rows * cell.height), true)
              box = b
              break
            } catch (err) {
              if (!(err instanceof Error) || err.message !== TOO_BIG) break
            }
          }
        }
        shots.push(
          <Image key={target} source={{ png: shown.base64 }} columns={box.cols} rows={box.rows} alt={alt || target} />,
        )
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err)
        shots.push(
          <Text dimColor>
            [{alt || 'image'}: {why}]
          </Text>,
        )
      }
    }

    return (
      <Box flexDirection="column">
        {await next({ ...e, props: { ...e.props, text: text.replace(IMAGE_LINK, '').trim() || ' ' } })}
        {shots}
      </Box>
    )
  })

  on('session.end', async ($, e, next) => {
    if (ctx.workDir) await tryRun($, ['rm', '-rf', ctx.workDir])
    return next(e)
  })
}
