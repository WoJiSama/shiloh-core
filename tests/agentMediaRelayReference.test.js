import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repo = fileURLToPath(new URL('../', import.meta.url)), release = path.resolve(process.env.BL_CHAT_AGENT_RELEASE_DIR || repo)
const load = name => import(pathToFileURL(path.join(release, 'dist/backend/modules/media/infrastructure', name)).href)
const { validateAgentMediaShare, agentMediaSharePageUrl, validateAgentMediaPreparedPageUrl } = await load('agentMediaRelayReference.js')
const { parseAgentDouyinReference } = await load('agentDouyinRelayReference.js')
const { parseAgentBilibiliReference, validateAgentMediaShare: compatibleValidator } = await load('agentBilibiliRelayReference.js')
const ID = '7123456789012345678', BV = 'BV1234567890'
const share = (provider = 'douyin', kind = 'video', id = ID) => ({ provider, reference: { kind, id } })

test('the shared reference validator preserves legacy Bilibili ownership and closes Douyin references', () => {
  assert.equal(compatibleValidator, validateAgentMediaShare)
  assert.deepEqual(validateAgentMediaShare(share('bilibili', 'video', 'bv1234567890')), share('bilibili', 'video', BV))
  for (const kind of ['video', 'note', 'short']) {
    const value = share('douyin', kind, kind === 'short' ? 'Ab_9-z' : ID), owned = validateAgentMediaShare(value)
    assert.deepEqual(owned, value); assert.notEqual(owned, value)
    assert.equal(Object.isFrozen(owned.reference), true)
  }
  for (const value of [share('other'), share('douyin', 'episode'), share('bilibili', 'note', ID), share('douyin', 'video', '012345'),
    share('douyin', 'video', '12345'), share('douyin', 'video', '123456\n'), share('douyin', 'video', '1'.repeat(21)), share('douyin', 'short', 'https://v.douyin.com/x'),
    share('douyin', 'short', 'x'.repeat(129)), { ...share(), url: 'https://cdn.invalid/private' },
    { provider: 'douyin', reference: { ...share().reference, token: 'secret' } }, Object.assign(Object.create({ inherited: true }), share())]) assert.throws(() => validateAgentMediaShare(value))
  let invoked = false
  assert.throws(() => validateAgentMediaShare({ provider: 'douyin', get reference() { invoked = true; return share().reference } })); assert.equal(invoked, false)
})

test('Douyin syntax recognizes official video, note and short references in text order without preserving tracking', () => {
  for (const input of [`https://www.douyin.com/video/${ID}?utm_source=qq&share_app_id=1128`, `http://douyin.com/video/${ID}/`,
    `//www.iesdouyin.com/share/video/${ID}/`, `iesdouyin.com/share/video/${ID}`]) assert.deepEqual(parseAgentDouyinReference(input), share())
  for (const input of [`https://www.douyin.com/note/${ID}`, `https://www.iesdouyin.com/share/note/${ID}/`]) assert.deepEqual(parseAgentDouyinReference(input), share('douyin', 'note'))
  assert.deepEqual(parseAgentDouyinReference(`复制打开 https://v.douyin.com/Ab_9-z/ 观看 https://www.douyin.com/video/${ID}`), share('douyin', 'short', 'Ab_9-z'))
  assert.deepEqual(parseAgentDouyinReference(`https://evil.test/ https://www.douyin.com/note/${ID}`), share('douyin', 'note'))
  assert.equal(parseAgentDouyinReference(ID), undefined)
  assert.deepEqual(parseAgentBilibiliReference(`https://b23.tv/legacy?secret=ignored`), share('bilibili', 'short', 'legacy'), 'existing Bilibili syntax remains compatible')
})

test('Douyin syntax rejects deceptive authorities, encoded paths, unsupported routes and credential-bearing URLs', () => {
  for (const input of [`https://www.douyin.com.evil.test/video/${ID}`, `https://evil.test/www.douyin.com/video/${ID}`,
    `https://user@www.douyin.com/video/${ID}`, `https://www.douyin.com@evil.test/video/${ID}`, `https://www.douyin.com:443/video/${ID}`,
    `https://www.douyin.com/video/${ID}#`, `https://www.douyin.com/video/${ID}#fragment`, `https://www.douyin.com/video/%37${ID.slice(1)}`,
    `https://www.douyin.com/a/../video/${ID}`, `https://www.douyin.com/video/${ID}\\evil`, `https://v.douyin.com/one/two`,
    `https://www.douyin.com/user/${ID}`, `https://www.douyin.com/video/012345`, `https://www.douyin.com/video/12345`,
    `https://www.douyin.com/video/${'1'.repeat(21)}`, `https://www.douyin.com/video/${ID}?access_token=private`,
    `https://v.douyin.com/abc/?cookie=private`, `https://v.douyin.com/abc/?%61uthorization=private`,
    `https://v.douyin.com/abc/?session_id=private`, `https://v.douyin.com/abc/?api_key=private`, `https://v.douyin.com/abc/?authToken=private`, `https://v.douyin.com/abc/?source=a%0Ab`]) {
    assert.equal(parseAgentDouyinReference(input), undefined, input)
  }
})

test('fallback links reconstruct official identities without queries and prepared pages cannot change provider or direct ID', () => {
  assert.equal(agentMediaSharePageUrl(share()), `https://www.douyin.com/video/${ID}`)
  assert.equal(agentMediaSharePageUrl(share('douyin', 'note')), `https://www.douyin.com/note/${ID}`)
  assert.equal(agentMediaSharePageUrl(share('douyin', 'short', 'Ab_9-z')), 'https://v.douyin.com/Ab_9-z/')
  assert.equal(agentMediaSharePageUrl(share('bilibili', 'video', BV)), `https://www.bilibili.com/video/${BV}`)
  assert.equal(agentMediaSharePageUrl(share('bilibili', 'episode', '123')), 'https://www.bilibili.com/bangumi/play/ep123')
  assert.equal(agentMediaSharePageUrl(share('bilibili', 'short', 'legacy')), 'https://b23.tv/legacy')
  for (const kind of ['video', 'note']) assert.equal(validateAgentMediaPreparedPageUrl(`https://www.douyin.com/${kind}/${ID}`, share()), `https://www.douyin.com/${kind}/${ID}`)
  assert.equal(validateAgentMediaPreparedPageUrl(`https://www.douyin.com/note/${ID}`, share('douyin', 'short', 'abc')), `https://www.douyin.com/note/${ID}`)
  assert.equal(validateAgentMediaPreparedPageUrl(`https://www.bilibili.com/video/${BV}`, share('bilibili', 'short', 'abc')), `https://www.bilibili.com/video/${BV}`)
  for (const url of [`https://www.bilibili.com/video/${BV}`, `https://www.douyin.com/video/${'8'.repeat(19)}`, `https://www.douyin.com/video/${ID}/`,
    `https://www.douyin.com/video/${ID}?utm_source=qq`, `https://www.douyin.com/video/${ID}#`, `https://v.douyin.com/abc/`,
    `http://www.douyin.com/video/${ID}`, `https://www.iesdouyin.com/share/video/${ID}/`, `https://www.douyin.com/video/${ID}\n`]) assert.throws(() => validateAgentMediaPreparedPageUrl(url, share()), url)
  assert.throws(() => validateAgentMediaPreparedPageUrl(`https://www.douyin.com/video/${ID}`, share('bilibili', 'video', BV)))
  assert.throws(() => validateAgentMediaPreparedPageUrl('https://www.bilibili.com/bangumi/play/ep123', share('bilibili', 'video', BV)))
})
