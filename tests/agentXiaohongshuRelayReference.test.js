import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repo = fileURLToPath(new URL('../', import.meta.url)), release = path.resolve(process.env.BL_CHAT_AGENT_RELEASE_DIR || repo)
const load = name => import(pathToFileURL(path.join(release, 'dist/backend/modules/media/infrastructure', name)).href)
const { parseAgentXiaohongshuReference, readAgentXiaohongshuAccess, validateAgentXiaohongshuAccess,
  xiaohongshuAccessPageUrl, sanitizeAgentXiaohongshuShareText } = await load('agentXiaohongshuRelayReference.js')
const { validateAgentMediaShare, agentMediaSharePageUrl, validateAgentMediaPreparedPageUrl } = await load('agentMediaRelayReference.js')
const ID = '6ad4a9c200000000290162d4', OTHER = '651a2b3c000000000d0e0f10', page = `https://www.xiaohongshu.com/explore/${ID}`
const share = (kind = 'note', id = ID) => ({ provider: 'xiaohongshu', reference: { kind, id } })
const signed = `${page}?xsec_token=ABcd%3D&xsec_source=app_share&type=normal&share_channel=qq`

test('Xiaohongshu note identities are normalized and short routes preserve their exact bounded case', () => {
  for (const input of [page, `http://xiaohongshu.com/explore/${ID.toUpperCase()}/`, `//www.xiaohongshu.com/discovery/item/${ID}`,
    `xiaohongshu.com/discovery/item/${ID}/?utm_source=qq`, signed]) assert.deepEqual(parseAgentXiaohongshuReference(input), share())
  for (const id of ['Ab_C-9', 'a/Ab_C-9']) {
    const selected = share('short', id)
    assert.deepEqual(parseAgentXiaohongshuReference(`https://xhslink.com/${id}/`), selected)
    assert.equal(agentMediaSharePageUrl(selected), `https://xhslink.com/${id}`)
  }
  assert.deepEqual(validateAgentMediaShare(share('note', ID.toUpperCase())), share())
  for (const selected of [share('note', 'a'.repeat(15)), share('note', 'a'.repeat(33)), share('note', 'g'.repeat(24)),
    share('short', 'a/x/y'), share('short', 'b/abc'), share('short', 'a/' + 'x'.repeat(129)), share('video'),
    { ...share(), xsecToken: 'PRIVATE' }, { provider: 'xiaohongshu', reference: { ...share().reference, xsec_token: 'PRIVATE' } }]) assert.throws(() => validateAgentMediaShare(selected))
})

test('strict source parsing rejects deceptive URLs, duplicate access keys and malformed percent escapes', () => {
  for (const input of [`https://www.xiaohongshu.com.evil.test/explore/${ID}`, `https://user@www.xiaohongshu.com/explore/${ID}`,
    `${page}:443`, `https://www.xiaohongshu.com:443/explore/${ID}`, `${page}#`, `${page}#part`,
    `https://www.xiaohongshu.com/explore/%36${ID.slice(1)}`, `https://www.xiaohongshu.com/a/../explore/${ID}`,
    `${page}\\tail`, `https://xhslink.com/a/a/b`, `https://xhslink.com/o/abc`, `https://xhslink.com/%61bc`,
    `${page}?xsec_token=X&xsec_token=Y`, `${page}?XSEC_TOKEN=X&xsec_token=Y`, `${page}?xsec_source=a&xsec_source=b`,
    `${page}?type=video&type=normal`, `${page}?xsec_token=%ZZ`, `${page}?tracking=%`, `${page}?xsec_token=A%20B`,
    `${page}?xsec_token=A+B`, `${page}?xsec_token=`, `${page}?xsec_token=%E4%B8%AD`, `${page}?xsec_source=a%0Ab`,
    `${page}?type=other`, `${page}?cookie=PRIVATE`, `${page}?access_token=PRIVATE`, `${page}?xsec_token=PRIVATE\\bad`]) assert.equal(parseAgentXiaohongshuReference(input), undefined, input)
})

test('source access decodes once, reconstructs only permitted access fields and never borrows another URL token', () => {
  const access = readAgentXiaohongshuAccess(signed, share())
  assert.deepEqual(access, { provider: 'xiaohongshu', xsecToken: 'ABcd=', xsecSource: 'app_share', mediaKind: 'image' }); assert.ok(Object.isFrozen(access))
  const rebuilt = new URL(xiaohongshuAccessPageUrl(share(), access))
  assert.equal(rebuilt.origin + rebuilt.pathname, page)
  assert.deepEqual([...rebuilt.searchParams.keys()], ['xsec_token', 'xsec_source', 'type']); assert.equal(rebuilt.searchParams.get('xsec_token'), 'ABcd=')
  assert.equal(rebuilt.searchParams.has('share_channel'), false)
  const twice = readAgentXiaohongshuAccess(`${page}?xsec_token=AB%253D&type=video`, share())
  assert.equal(twice.xsecToken, 'AB%3D'); assert.equal(new URL(xiaohongshuAccessPageUrl(share(), twice)).searchParams.get('xsec_token'), 'AB%3D')
  assert.deepEqual(readAgentXiaohongshuAccess(`${page} ${signed}`, share()), { provider: 'xiaohongshu' }, 'first source without token cannot borrow a later same-note token')
  assert.equal(readAgentXiaohongshuAccess(`https://www.xiaohongshu.com/explore/${OTHER}?xsec_token=OTHER ${signed}`, share()), undefined)
  assert.equal(readAgentXiaohongshuAccess(signed, share('note', OTHER)), undefined)
  assert.equal(readAgentXiaohongshuAccess(signed, { provider: 'douyin', reference: { kind: 'video', id: '7123456789012345678' } }), undefined)
  assert.deepEqual(readAgentXiaohongshuAccess('https://xhslink.com/a/Ab_C9?xsec_token=SHORT', share('short', 'a/Ab_C9')), { provider: 'xiaohongshu', xsecToken: 'SHORT' })
  for (const token of ['PREFIX;PRIVATE_TAIL', 'PREFIX,PRIVATE_TAIL', 'PREFIX;,PRIVATE_TAIL']) {
    const input = `${page}?xsec_token=${token}&xsec_source=app_share ${signed}`
    assert.equal(readAgentXiaohongshuAccess(input, share()).xsecToken, token, 'literal URI query punctuation belongs to the first URL')
    assert.equal(new URL(xiaohongshuAccessPageUrl(share(), readAgentXiaohongshuAccess(input, share()))).searchParams.get('xsec_token'), token)
  }
})

test('temporary access is closed, immutable and bounded without invoking getters or accepting arbitrary routes', () => {
  assert.deepEqual(validateAgentXiaohongshuAccess({ provider: 'xiaohongshu' }), { provider: 'xiaohongshu' })
  assert.equal(validateAgentXiaohongshuAccess({ provider: 'xiaohongshu', xsecToken: 'X'.repeat(4096) }).xsecToken.length, 4096)
  for (const value of [null, [], { provider: 'douyin' }, { provider: 'xiaohongshu', url: signed }, { provider: 'xiaohongshu', cookie: 'PRIVATE' },
    { provider: 'xiaohongshu', xsecToken: 'X'.repeat(4097) }, { provider: 'xiaohongshu', xsecToken: 'has space' },
    { provider: 'xiaohongshu', xsecToken: '中文' }, { provider: 'xiaohongshu', xsecToken: 'A\nB' },
    { provider: 'xiaohongshu', xsecSource: 'a'.repeat(129) }, { provider: 'xiaohongshu', xsecSource: 'a/b' },
    { provider: 'xiaohongshu', mediaKind: 'normal' }]) assert.throws(() => validateAgentXiaohongshuAccess(value))
  let touched = false
  assert.throws(() => validateAgentXiaohongshuAccess({ provider: 'xiaohongshu', get xsecToken() { touched = true; return 'PRIVATE' } })); assert.equal(touched, false)
  assert.throws(() => xiaohongshuAccessPageUrl({ provider: 'bilibili', reference: { kind: 'video', id: 'BV1234567890' } }))
})

test('sanitization removes valid and malformed access queries while preserving surrounding text and safe identities', () => {
  for (const query of ['xsec_token=ABcd%3D&type=video', 'xsec_token=%ZZ', 'xsec_token=A&xsec_token=B', 'cookie=PRIVATE',
    '%78sec_token=PRIVATE', 'xsec_token=PRIVATE#fragment', 'xsec_token=has%20space', 'xsec_token=%0A', 'xsec_token=PRIVATE\\bad',
    'xsec_token=PREFIX;PRIVATE_TAIL', 'xsec_token=PREFIX,PRIVATE_TAIL', 'xsec_token=PREFIX;,PRIVATE_TAIL']) {
    const text = `请看 ${page}?${query} 谢谢`
    assert.equal(sanitizeAgentXiaohongshuShareText(text), `请看 ${page} 谢谢`)
  }
  assert.equal(sanitizeAgentXiaohongshuShareText(`前文 https://xhslink.com/a/Ab_C9?xsec_token=PRIVATE 后文`), '前文 https://xhslink.com/a/Ab_C9 后文')
  assert.equal(sanitizeAgentXiaohongshuShareText(`${page}#xsec_token=PRIVATE`), page)
  assert.equal(sanitizeAgentXiaohongshuShareText('普通文字 https://www.douyin.com/video/7123456789012345678?utm_source=qq'), '普通文字 https://www.douyin.com/video/7123456789012345678?utm_source=qq')
  assert.equal(sanitizeAgentXiaohongshuShareText(page), page)
})

test('prepared Xiaohongshu pages bind direct IDs and reject access queries, cross-provider pages and malformed canonical pages', () => {
  assert.equal(validateAgentMediaPreparedPageUrl(page, share()), page)
  assert.equal(validateAgentMediaPreparedPageUrl(page, share('short', 'a/Ab_C9')), page)
  for (const url of [signed, page + '/', page + '\n', `https://www.xiaohongshu.com/discovery/item/${ID}`,
    `https://www.xiaohongshu.com/explore/${OTHER}`, `https://www.xiaohongshu.com/explore/${ID.toUpperCase()}`,
    'https://xhslink.com/abc', 'https://www.douyin.com/note/7123456789012345678']) assert.throws(() => validateAgentMediaPreparedPageUrl(url, share()))
  assert.throws(() => validateAgentMediaPreparedPageUrl(page, { provider: 'douyin', reference: { kind: 'note', id: '7123456789012345678' } }))
})
