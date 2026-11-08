import { expect, test } from 'claude-code/testing'

// A 640x360 PNG header is all the mod reads to size the picture (it never decodes pixels).
function pngBase64(width: number, height: number): string {
  const bytes = new Uint8Array(40) as Uint8Array & { toBase64(): string }
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  const view = new DataView(bytes.buffer)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return bytes.toBase64()
}

const message = (text: string) =>
  ({
    plugin: 'inline-image',
    component: 'AssistantMessage',
    surface: 'terminal',
    props: { text, isFirstOfReply: true },
  }) as const

// Nothing sits beneath the plugin: each hook stands for the engine. A call on `$` is answered `{ value }`.
type Body = Extract<Parameters<typeof test>[1], (...args: any) => any>
type On = Parameters<Body>[1]

function engine(on: On, file?: { base64: string; size?: number }) {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('env.get', () => ({ value: '/home/me' }))
  on('process.run', (_, e) =>
    e.argv[0] === 'mktemp'
      ? { value: { exitCode: 0, stdout: '/tmp/claude-inline-image.test\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
      : { value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }, // no cell size from the tty, no converters
  )
  on('fs.stat', () =>
    file
      ? { value: { kind: 'file', size: file.size ?? 1000, mtimeMs: 1, isLink: false } }
      : { deny: 'ENOENT' },
  )
  on('fs.read', () => ({ value: { base64: file?.base64 ?? '' } }))
}

test('a message without an image goes to the engine untouched', async ($, on) => {
  engine(on)
  const ui = await $.ui.mount(message('just words'))

  expect(await ui.find({ type: 'Image' })).toBeUndefined()
  expect((await ui.find({ type: 'Text' }))?.text).toBe('engine')
  await ui.unmount()
})

test('a PNG link draws a picture under the text and hides the link', async ($, on) => {
  engine(on, { base64: pngBase64(640, 360) })
  const ui = await $.ui.mount(message('Here you go\n![chart](/tmp/chart.png)'))

  const image = await ui.find({ type: 'Image' })
  expect(image).toBeDefined()
  expect(image?.props.alt).toBe('chart')
  const columns = Number(image?.props.columns)
  const rows = Number(image?.props.rows)
  expect(columns).toBeGreaterThan(8)
  // 16:9 in cells that are about twice as tall as wide: fewer rows than columns, never zero
  expect(rows).toBeGreaterThan(0)
  expect(rows).toBeLessThan(columns)
  await ui.unmount()
})

test('a missing file says so instead of drawing', async ($, on) => {
  engine(on)
  const ui = await $.ui.mount(message('![nope](/tmp/missing.png)'))

  expect(await ui.find({ type: 'Image' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /nope/ })).toBeDefined()
  await ui.unmount()
})

test('web URLs are refused unless allowRemote is on', async ($, on) => {
  engine(on)
  const ui = await $.ui.mount(message('![x](https://example.com/a.png)'))

  expect(await ui.find({ type: 'Text', text: /remote images are off/ })).toBeDefined()
  await ui.unmount()
})

test('only maxImages pictures are drawn', async ($, on) => {
  engine(on, { base64: pngBase64(64, 64) })
  const links = [1, 2, 3, 4, 5].map(n => `![i${n}](/tmp/${n}.png)`).join('\n')
  const ui = await $.ui.mount(message(links))

  expect((await ui.findAll({ type: 'Image' })).length).toBe(4)
  await ui.unmount()
})
