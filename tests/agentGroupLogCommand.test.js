import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repo = fileURLToPath(new URL('../', import.meta.url)), release = path.resolve(process.env.BL_CHAT_AGENT_RELEASE_DIR || repo)
const { parseAgentGroupLogCommand: parse } = await import(pathToFileURL(path.join(release, 'dist/backend/modules/dice/domain/agentGroupLogCommand.js')).href)

test('group-log start preserves bounded title data across legacy aliases, case and multiple spaces', () => {
  for (const action of ['new', 'on', 'start', 'create', '新建', '开始', '开启', 'NEW', 'On']) {
    assert.deepEqual(parse(` .LoG   ${action}   至死  方休  `), { kind: 'start', title: '至死  方休' })
    assert.deepEqual(parse(`.log ${action}`), { kind: 'start', title: '' })
  }
  assert.deepEqual(parse('。  LOG new 第三夜'), { kind: 'start', title: '第三夜' })
  assert.deepEqual(parse(`.log new ${'𠮷'.repeat(40)}`), { kind: 'start', title: '𠮷'.repeat(40) })
  assert.deepEqual(parse(`.log new ${'𠮷'.repeat(41)}`), { kind: 'invalid' })
})

test('stop, status, list and end retain their distinct legacy command semantics', () => {
  for (const action of ['off', 'stop', '结束', '关闭', 'OFF']) assert.deepEqual(parse(`.log ${action} 忽略的团名`), { kind: 'stop' })
  for (const action of ['status', '状态', 'STATUS']) assert.deepEqual(parse(`.log ${action}`), { kind: 'status' })
  for (const action of ['list', '列表', '历史', '团录', 'LIST']) assert.deepEqual(parse(`.log ${action}`), { kind: 'list' })
  for (const text of ['.log end', '.LOG END 3 html', '.log 结束并导出 至死方休 网页版']) assert.deepEqual(parse(text), { kind: 'end' }, 'end never selects a history entry or HTML')
  assert.deepEqual(parse('.log'), { kind: 'invalid' }, 'the host owns the empty-command help text')
})

test('export leaves current, historical numeric and exact-title selectors intact without coercion', () => {
  for (const action of ['export', 'get', '导出', '获取', 'EXPORT']) {
    for (const selector of ['', 'current', 'CURRENT', '当前', '0001', '0', '9007199254740993', '至死  方休', 'Case Sensitive']) {
      assert.deepEqual(parse(`.log ${action}   ${selector}  `), { kind: 'export', selector, format: 'txt' })
    }
  }
  assert.deepEqual(parse('.log export txt'), { kind: 'export', selector: 'txt', format: 'txt' }, 'txt remains a title under the legacy syntax')
  assert.deepEqual(parse('.log export html-night'), { kind: 'export', selector: 'html-night', format: 'txt' })
})

test('only a final complete HTML alias changes format and preserves the legacy whitespace normalization', () => {
  for (const format of ['html', 'htm', 'HTML', 'HtM', '网页', '网页版']) {
    assert.deepEqual(parse(`.log export ${format}`), { kind: 'export', selector: '', format: 'html' })
    assert.deepEqual(parse(`.log export   0002   ${format}  `), { kind: 'export', selector: '0002', format: 'html' })
    assert.deepEqual(parse(`.log export  Case  Sensitive   ${format}`), { kind: 'export', selector: 'Case Sensitive', format: 'html' })
  }
  assert.deepEqual(parse('.log export html current'), { kind: 'export', selector: 'html current', format: 'txt' })
  assert.deepEqual(parse('.log export title.xhtml'), { kind: 'export', selector: 'title.xhtml', format: 'txt' })
})

test('group-log AI accepts explicit toggles or status without taking unrelated dice commands', () => {
  for (const head of ['.骰娘 跑团AI', '.dice 跑团ai', '。 DICE  跑团Ai']) {
    for (const action of ['', '状态', 'status', 'STATUS']) assert.deepEqual(parse(`${head}   ${action}`), { kind: 'ai' })
    for (const action of ['开', '开启', 'on', 'ON']) assert.deepEqual(parse(`${head} ${action}`), { kind: 'ai', enabled: true })
    for (const action of ['关', '关闭', 'off', 'OFF']) assert.deepEqual(parse(`${head} ${action}`), { kind: 'ai', enabled: false })
  }
  for (const text of ['.骰娘 开', '.dice help', '.骰娘 跑团AIs 开', '.dicebot 跑团AI on']) assert.equal(parse(text), undefined)
  for (const text of ['.骰娘 跑团AI enabled', '.骰娘 跑团AI on now']) assert.deepEqual(parse(text), { kind: 'invalid' })
})

test('only complete anchored command words are consumed and URL-looking text remains inert local data', () => {
  for (const text of ['', '普通聊天 .log on', '.logics', '.logger off', '.logon title', 'https://example.com/.log', 'https://example.com/.log export html', '.骰娘跑团AI 开']) assert.equal(parse(text), undefined)
  for (const text of ['.log newish', '.log exportable', '.log onnow', '.log status extra', '.log list extra', '.log unknown', '.log /tmp/private']) assert.deepEqual(parse(text), { kind: 'invalid' })
  assert.deepEqual(parse('.log export https://example.com/private?token=opaque'),
    { kind: 'export', selector: 'https://example.com/private?token=opaque', format: 'txt' }, 'a selector is never interpreted as an external URL')
})

test('command rejection is explicit for control characters and input bounds without coercing non-string values', () => {
  for (const text of ['.log on\n标题', '.log\ton', '.log new 团名\u0000', '.log end\r', '.log export 团名\u001b', '.log off\u007f', '.log status\u0085', '.骰娘 跑团AI on\u009f']) assert.deepEqual(parse(text), { kind: 'invalid' })
  assert.deepEqual(parse('.log end' + ' '.repeat(4096 - '.log end'.length)), { kind: 'end' })
  assert.deepEqual(parse('.log end' + ' '.repeat(4097 - '.log end'.length)), { kind: 'invalid' })
  let coerced = false
  for (const value of [null, undefined, 1, false, [], {}, new String('.log on'), { toString() { coerced = true; return '.log on' } }]) assert.equal(parse(value), undefined)
  assert.equal(coerced, false)
})
