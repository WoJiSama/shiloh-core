import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repo = fileURLToPath(new URL('../', import.meta.url)), release = path.resolve(process.env.BL_CHAT_AGENT_RELEASE_DIR || repo)
const { renderLogText, renderLogHtml, resolveLogForExport } = await import(pathToFileURL(path.join(release, 'dist/backend/modules/dice/domain/logExport.js')).href)
const { DiceManager } = await import(pathToFileURL(path.join(release, 'dist/backend/modules/dice/infrastructure/DiceManager.js')).href)
const MiB = 1024 * 1024
const digest = value => createHash('sha256').update(value, 'utf8').digest('hex')

// Captured from the unmodified legacy renderer before extraction, including its exact header/body boundary.
const golden = [
  {
    log: { active: false, file: 'fixture-a', title: '团录<script>&"', startedAt: '2026-11-16T12:00:00Z', endedAt: '2026-11-16T13:00:00Z' },
    lines: [
      { at: '2026-11-16T12:01:02.001Z', name: '甲<&"', userId: 'u1', content: '两行\n正文 <script>" &', type: 'message' },
      { at: '2026-11-16T12:02:03.001Z', name: '乙', userId: 'u2', content: '大成功', type: 'dice_result' },
      { at: '2026-11-16T12:03:03.001Z', userId: 'u3', content: '大失败', type: 'dice_result' },
      { name: '丙', content: '困难成功', type: 'dice_result' }, { content: '失败', type: 'dice_result' }, { content: '1D100=50', type: 'dice_result' },
    ],
    textHash: '6800b1a4fdb6bc62321254be9d27abd31c571d1422d73f5f5380cd62d6c18d9a',
    htmlHash: 'ae6b15387252ef9c49249e3656880f4289da8db306a2d1cfe76c67ef4e91e8c0',
  },
  { log: { active: false, file: 'fixture-b' }, lines: [], textHash: 'b057fde325796b649b254f9a12275a4e808013c2556772f55526a35afdfb4707', htmlHash: 'cf3bc111501d45ad88bfcf5be9c1377fa8bedaec93a0e2357b241a6c64919e3d' },
  { log: { active: true, file: 'fixture-c', title: '😺𠮷', startedAt: '2026-11-16' }, lines: [{}, { content: '\\u0000 \r\n \t', userId: 'unicode-𠮷' }], textHash: '795a6ec71964d6aa62fa58ab777c469b77273fcbcd832a9616e248bf4344d437', htmlHash: '57ccf62e2853a7d598a0424888f4a6b582c0ffc68c78d79fa9bdefff60cafd29' },
]

test('shared TXT and HTML preserve legacy bytes and the legacy manager delegates to the same pure functions', () => {
  const manager = new DiceManager()
  for (const { log, lines, textHash, htmlHash } of golden) {
    const text = renderLogText(log, lines), html = renderLogHtml(log, lines)
    assert.equal(digest(text), textHash); assert.equal(digest(html), htmlHash)
    assert.equal(manager.buildLogText(log, lines), text); assert.equal(manager.buildLogHtml(log, lines), html)
    assert.equal(renderLogText(log, lines, { maxBytes: MiB }), text); assert.equal(renderLogHtml(log, lines, { maxBytes: MiB }), html)
  }
})

test('pure export selection retains current, reverse history, exact-title precedence and reserved selectors', () => {
  const old = { file: 'old', title: '同名' }, latest = { file: 'latest', title: '同名' }, other = { file: 'other', title: '另一团' }, current = { file: 'current', title: '同名' }
  const group = { log: current, logs: [old, other, latest, { ...current }] }, manager = new DiceManager()
  for (const [selector, wanted] of [['', current], [' current ', current], ['CURRENT', current], ['当前', current], ['1', latest], ['0001', latest], ['2', other], ['3', old], ['0', null], ['4', null], ['同名', current], ['另一团', other], ['不存在', null]]) {
    assert.equal(resolveLogForExport(group, selector), wanted); assert.equal(manager.resolveLogForExport(group, selector), wanted)
  }
  assert.equal(resolveLogForExport({ logs: [old, other, latest] }, '同名'), latest)
  assert.equal(resolveLogForExport({ logs: [old] }), null); assert.equal(resolveLogForExport({ logs: [old] }, '1'), old)
  assert.equal(resolveLogForExport({ log: { title: '无文件' }, logs: [{ title: '也无文件' }] }, '1'), null)
  assert.equal(resolveLogForExport(), null)
})

test('bounded TXT counts UTF-8 bytes exactly and rejects the whole export one byte over budget', () => {
  const log = { title: '完整文本' }, line = { name: '甲', userId: '1', content: '' }
  const overhead = Buffer.byteLength(renderLogText(log, [line])), remaining = MiB - overhead
  const content = '中'.repeat(Math.floor(remaining / 3)) + 'x'.repeat(remaining % 3)
  const complete = renderLogText(log, [{ ...line, content }], { maxBytes: MiB })
  assert.equal(Buffer.byteLength(complete), MiB); assert.ok(complete.includes(content)); assert.ok(complete.endsWith('\n'))
  assert.throws(() => renderLogText(log, [{ ...line, content: content + 'x' }], { maxBytes: MiB }), /完整文件字节上限/u)
  assert.equal(Buffer.byteLength(renderLogText(log, [{ ...line, content: content + 'x' }], { maxBytes: MiB + 1 })), MiB + 1)
})

test('bounded HTML includes escaping expansion and wrapper bytes in the exact whole-file budget', () => {
  const log = { title: '完整HTML' }, line = { name: '甲', content: '' }, overhead = Buffer.byteLength(renderLogHtml(log, [line])), remaining = MiB - overhead
  const content = '&'.repeat(Math.floor(remaining / 5)) + 'x'.repeat(remaining % 5), complete = renderLogHtml(log, [{ ...line, content }], { maxBytes: MiB })
  assert.equal(Buffer.byteLength(complete), MiB); assert.ok(complete.includes('&amp;'.repeat(Math.floor(remaining / 5)))); assert.ok(complete.endsWith('</html>'))
  assert.throws(() => renderLogHtml(log, [{ ...line, content: content + 'x' }], { maxBytes: MiB }), /完整文件字节上限/u)
})

test('chunking preserves surrogate pairs and escapes without changing the complete output', () => {
  const content = 'a'.repeat(8191) + '😺𠮷<&"' + 'b'.repeat(8191) + '😺\ud800x\udc00', line = { name: '😀', userId: 'u', content }
  const text = renderLogText({}, [line], { maxBytes: MiB }), html = renderLogHtml({}, [line], { maxBytes: MiB })
  assert.ok(text.includes(content)); assert.ok(html.includes(content.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')))
  assert.equal(text, renderLogText({}, [line])); assert.equal(html, renderLogHtml({}, [line]))
  for (const render of [renderLogText, renderLogHtml]) {
    const unicode = { content: ('a'.repeat(8191) + '😺\ud800x\udc00').repeat(130) }, complete = render({}, [unicode]), exactBytes = Buffer.byteLength(complete)
    assert.ok(exactBytes >= MiB); assert.equal(render({}, [unicode], { maxBytes: exactBytes }), complete)
    assert.throws(() => render({}, [unicode], { maxBytes: exactBytes - 1 }), /完整文件字节上限/u)
  }
})

test('rendering stops on the first over-budget chunk before touching later records or returning partial text', () => {
  for (const render of [renderLogText, renderLogHtml]) {
    let touched = false
    const later = { get content() { touched = true; throw Error('PRIVATE_LATE_CONTENT') } }
    assert.throws(() => render({}, [{ content: 'x'.repeat(MiB + 1) }, later], { maxBytes: MiB }), error => error.message === '团录导出超过完整文件字节上限')
    assert.equal(touched, false)
  }
})

test('explicit render budgets allow integer bytes from 1 through 100 MiB and reject invalid boundaries', () => {
  for (const render of [renderLogText, renderLogHtml]) {
    for (const maxBytes of [0, 1, MiB - 1, MiB + 0.5, 100 * MiB + 1, Infinity, NaN, '1048576', null]) assert.throws(() => render({}, [], { maxBytes }), /字节上限必须/u)
    assert.equal(render({}, [], { maxBytes: 100 * MiB }), render({}, []))
  }
})
