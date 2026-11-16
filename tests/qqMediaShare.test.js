import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import path from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import WebSocket, { WebSocketServer } from 'ws'

const repo = fileURLToPath(new URL('../', import.meta.url)), release = path.resolve(process.env.BL_CHAT_AGENT_RELEASE_DIR || repo)
const compiled = name => pathToFileURL(path.join(release, 'dist/backend', name)).href
const { createQqMediaShareReader, extractQqMediaShare, QQ_MEDIA_SHARE_READ_TIMEOUT_MS, QQ_MEDIA_SHARE_GET_MESSAGE_TIMEOUT_MS } =
  await import(compiled('adapters/qqMediaShare.js'))
const { createOneBotConnection } = await import(compiled('adapters/oneBotConnection.js'))

const account = { platform: 'qq', namespace: 'global', id: '123456789' }
const group = { account, kind: 'group', id: '315320' }
const author = { ...account, id: '246810' }
const occurredAt = 1700000000000
const share = { provider: 'bilibili', reference: { kind: 'short', id: 'JvNsiRF' } }
const page = 'https://b23.tv/JvNsiRF?share_source=qq'
const video = { provider: 'bilibili', reference: { kind: 'video', id: 'BV1xx411c7mD' } }
const card = { app: 'com.tencent.miniapp_01', meta: { detail_1: { title: '哔哩哔哩', desc: '合成视频',
  qqdocurl: page, host: { uin: '999999', nick: '卡片名不是消息作者' }, preview: 'https://example.invalid/cover.jpg' } } }
const canonical = [{ type: 'json', data: { data: JSON.stringify(card) } }]
const douyinPage = 'https://v.douyin.com/EULdbQEydtc/?share_source=qq'
const douyinShare = { provider: 'douyin', reference: { kind: 'short', id: 'EULdbQEydtc' } }
const douyinId = '7661206883327471737'
const douyinVideo = { provider: 'douyin', reference: { kind: 'video', id: douyinId } }
const douyinNote = { provider: 'douyin', reference: { kind: 'note', id: douyinId } }
const douyinCard = { app: 'com.tencent.miniapp_01', meta: { detail_1: { title: '抖音', desc: '卡片标题不是可信作品信息', qqdocurl: douyinPage,
  host: { uin: '999999', nick: '卡片作者不是消息作者' }, preview: 'https://p3.douyinpic.com/untrusted-cover.webp' } } }
const douyinCanonical = [{ type: 'json', data: { data: JSON.stringify(douyinCard) } }]
const youtubeId = 'dQw4w9WgXcQ', youtubeOtherId = 'M7lc1UVf-VE'
const youtubePage = `https://www.youtube.com/watch?v=${youtubeId}&feature=share`
const youtubeShare = { provider: 'youtube', reference: { kind: 'video', id: youtubeId } }
const youtubeCard = { app: 'com.tencent.miniapp_01', meta: { detail_1: { title: 'YouTube卡片标题不可信',
  qqdocurl: youtubePage, desc: '卡片摘要不可信', preview: 'https://i.ytimg.com/untrusted-cover.jpg', host: { uin: '999999' } } } }
const youtubeCanonical = [{ type: 'json', data: { data: JSON.stringify(youtubeCard) } }]
const pixivId = '123456789', pixivOtherId = '987654321'
const pixivPage = `https://www.pixiv.net/artworks/${pixivId}?utm_source=share`
const pixivShare = { provider: 'pixiv', reference: { kind: 'artwork', id: pixivId } }
const pixivCard = { app: 'com.tencent.miniapp_01', meta: { detail_1: { title: 'Pixiv卡片标题不可信', qqdocurl: pixivPage,
  desc: '卡片摘要不可信', preview: 'https://i.pximg.net/untrusted-cover.jpg', host: { uin: '999999' } } } }
const pixivCanonical = [{ type: 'json', data: { data: JSON.stringify(pixivCard) } }]
const xhsId = '6ad4a9c200000000290162d4', otherXhsId = '64f0a1b2000000001c00ed1a'
const xhsToken = 'Xhs_Qq_Selected_Secret=', otherXhsToken = 'Other_Unselected_Secret='
const xhsPage = `https://www.xiaohongshu.com/discovery/item/${xhsId}?app_platform=android&xsec_source=app_share&type=video&xsec_token=${encodeURIComponent(xhsToken)}&share_channel=qq`
const xhsSafePage = `https://www.xiaohongshu.com/explore/${xhsId}`
const xhsShare = { provider: 'xiaohongshu', reference: { kind: 'note', id: xhsId } }
const xhsAccess = { provider: 'xiaohongshu', xsecToken: xhsToken, xsecSource: 'app_share', mediaKind: 'video' }
const xhsCard = { app: 'com.tencent.tuwen.lua', meta: { news: { title: '卡片标题不是作品详情', tag: '小红书',
  jumpUrl: xhsPage, desc: '卡片摘要不可信', preview: 'https://qq.ugcimg.cn/untrusted-cover', host: { uin: '999999' } } } }
const xhsCanonical = [{ type: 'json', data: { data: JSON.stringify(xhsCard) } }]
const ok = data => ({ status: 'ok', retcode: 0, data })
const message = (overrides = {}) => ok({ self_id: account.id, message_type: 'group', group_id: group.id, message_id: 71,
  time: occurredAt / 1000, user_id: author.id, sender: { user_id: author.id, nickname: '合成分享者' }, message: canonical, ...overrides })
const options = overrides => ({ signal: new AbortController().signal, isCurrent: () => true,
  expectedSource: { author: { ...author }, occurredAt }, allowsSource: async () => true, ...overrides })
const cq = value => `[CQ:json,data=${JSON.stringify(value).replace(/&/gu, '&amp;').replace(/,/gu, '&#44;').replace(/\[/gu, '&#91;').replace(/\]/gu, '&#93;')}]`
function direct(response = message(), configuredAccount = account) {
  const calls = [], read = createQqMediaShareReader({ account: configuredAccount, async readApi(action, params, scope) {
    calls.push({ action, params, scope })
    return typeof response === 'function' ? response(action, params, scope) : response
  } })
  return { calls, read }
}
async function waitFor(probe) {
  const until = Date.now() + 3000
  while (Date.now() < until) { const value = await probe(); if (value) return value; await delay(5) }
  assert.fail('Timed out waiting for media share fixture')
}

test('legacy, canonical, object, nested and CQ JSON cards produce one closed neutral share', () => {
  for (const input of [[{ type: 'json', data: JSON.stringify(card) }], [{ type: 'json', data: card }], canonical,
    [{ type: 'json', data: { data: card } }], [{ type: 'json', data: { data: JSON.stringify(JSON.stringify(card)) } }],
    [{ type: 'json', data: { wrapper: JSON.stringify(card) } }], cq(card)]) {
    const result = extractQqMediaShare(input)
    assert.deepEqual(result, share)
    assert.equal(Object.isFrozen(result), true)
    assert.equal(Object.isFrozen(result.reference), true)
    assert.deepEqual(Object.keys(result), ['provider', 'reference'])
    assert.deepEqual(Object.keys(result.reference), ['kind', 'id'])
    assert.equal(JSON.stringify(result).includes('qqdocurl'), false)
  }
  assert.deepEqual(extractQqMediaShare([{ type: 'json' }], cq(card)), share)
  assert.deepEqual(extractQqMediaShare([{ type: 'json', data: '{invalid' }], cq(card)), share)
})

test('official video, episode and short URLs retain legacy reference ranges without exposing URL parameters', () => {
  for (const prefix of ['https://', 'http://', '//', '']) {
    assert.deepEqual(extractQqMediaShare(`${prefix}www.bilibili.com/video/BV1xx411c7mD?p=2`), video)
    assert.deepEqual(extractQqMediaShare(`${prefix}m.bilibili.com/bangumi/play/ep12345?from=qq`),
      { provider: 'bilibili', reference: { kind: 'episode', id: '12345' } })
    assert.deepEqual(extractQqMediaShare(`${prefix}b23.tv/bangumi-test`),
      { provider: 'bilibili', reference: { kind: 'short', id: 'bangumi-test' } })
  }
  assert.deepEqual(extractQqMediaShare('https://www.bilibili.com/video/bvAbCd1234'),
    { provider: 'bilibili', reference: { kind: 'video', id: 'BVAbCd1234' } })
  assert.deepEqual(extractQqMediaShare([{ type: 'bilibili', short_url: page, bvid: 'untrusted', title: '不会返回' }]), share)
  assert.deepEqual(extractQqMediaShare([{ type: 'json', data: { url: 'https:\\/\\/www.bilibili.com\\/video\\/BV1xx411c7mD' } }]), video)
})

test('first-media choice matches the original automatic pipeline, including native douyin suppression', () => {
  const text = text => ({ type: 'text', data: { text } })
  assert.deepEqual(extractQqMediaShare([text(page), text('https://www.bilibili.com/video/BV1xx411c7mD')]), share)
  assert.deepEqual(extractQqMediaShare([text('https://youtu.be/earlier'), ...canonical]), share)
  assert.deepEqual(extractQqMediaShare([text('https://v.douyin.com/earlier'), ...canonical]), share)
  assert.deepEqual(extractQqMediaShare([...canonical, { type: 'douyin', data: {} }]), share)
  assert.equal(extractQqMediaShare([{ type: 'douyin', data: {} }, ...canonical], page), undefined)
  assert.equal(extractQqMediaShare([{ type: 'bilibili', bvid: 'BV1xx411c7mD' }, ...canonical]), undefined)
  assert.deepEqual(extractQqMediaShare([text('ordinary')], `https://www.bilibili.com/video/BV1xx411c7mD ${cq(card)}`), share)
  const preferred = { title: '哔哩哔哩', unrelated: 'https://www.bilibili.com/video/BV1xx411c7mD', qqdocurl: page }
  assert.deepEqual(extractQqMediaShare([{ type: 'json', data: preferred }]), share)
})

test('Douyin legacy, canonical, object, nested and CQ JSON cards return only a frozen neutral reference', () => {
  for (const input of [[{ type: 'json', data: JSON.stringify(douyinCard) }], [{ type: 'json', data: douyinCard }], douyinCanonical,
    [{ type: 'json', data: { data: douyinCard } }], [{ type: 'json', data: { data: JSON.stringify(JSON.stringify(douyinCard)) } }],
    [{ type: 'json', data: { wrapper: JSON.stringify(douyinCard) } }], cq(douyinCard)]) {
    const result = extractQqMediaShare(input)
    assert.deepEqual(result, douyinShare); assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.reference))
    assert.deepEqual(Object.keys(result), ['provider', 'reference']); assert.deepEqual(Object.keys(result.reference), ['kind', 'id'])
    for (const forbidden of ['qqdocurl', '999999', 'preview', 'author', 'title', 'share_source']) assert.equal(JSON.stringify(result).includes(forbidden), false)
  }
  assert.deepEqual(extractQqMediaShare([{ type: 'json' }], cq(douyinCard)), douyinShare)
  assert.deepEqual(extractQqMediaShare([{ type: 'json', data: '{invalid' }], cq(douyinCard)), douyinShare)
  assert.deepEqual(extractQqMediaShare([{ type: 'json', data: { url: 'https:\\/\\/www.douyin.com\\/video\\/' + douyinId } }]), douyinVideo)
})

test('Douyin text, legacy text fields, CQ text and native URL fields delegate official reference syntax to Core', () => {
  assert.deepEqual(extractQqMediaShare(`复制打开抖音 ${douyinPage} :6pm`), douyinShare)
  for (const prefix of ['https://', 'http://', '//', '']) {
    assert.deepEqual(extractQqMediaShare(`${prefix}www.douyin.com/video/${douyinId}`), douyinVideo)
    assert.deepEqual(extractQqMediaShare(`${prefix}douyin.com/note/${douyinId}`), douyinNote)
    assert.deepEqual(extractQqMediaShare(`${prefix}www.iesdouyin.com/share/video/${douyinId}/`), douyinVideo)
    assert.deepEqual(extractQqMediaShare(`${prefix}iesdouyin.com/share/note/${douyinId}/`), douyinNote)
  }
  assert.deepEqual(extractQqMediaShare([{ type: 'text', text: douyinPage }]), douyinShare)
  assert.deepEqual(extractQqMediaShare([{ type: 'text', data: { text: douyinPage } }]), douyinShare)
  assert.deepEqual(extractQqMediaShare(`[CQ:at,qq=${account.id}]${douyinPage}`), douyinShare)
  for (const key of ['short_url', 'page_url', 'video_url', 'final_url', 'qqdocurl', 'url', 'jumpUrl']) {
    for (const input of [{ type: 'douyin', [key]: douyinPage }, { type: 'douyin', data: { [key]: douyinPage } }]) {
      assert.deepEqual(extractQqMediaShare([input]), douyinShare)
    }
  }
})

test('mixed providers retain Bilibili scan priority, native media positions and JSON qqdocurl priority', () => {
  const text = text => ({ type: 'text', data: { text } })
  assert.deepEqual(extractQqMediaShare([text(douyinPage), ...canonical]), share)
  assert.deepEqual(extractQqMediaShare([...douyinCanonical, ...canonical]), share)
  assert.deepEqual(extractQqMediaShare([text(douyinPage)], page), share)
  assert.deepEqual(extractQqMediaShare([text(page), ...douyinCanonical]), share)
  assert.deepEqual(extractQqMediaShare([{ type: 'douyin', short_url: douyinPage }, ...canonical]), douyinShare)
  assert.deepEqual(extractQqMediaShare([...canonical, { type: 'douyin', short_url: douyinPage }]), share)
  assert.equal(extractQqMediaShare([{ type: 'douyin', aweme_id: douyinId }, ...canonical], page), undefined)
  assert.equal(extractQqMediaShare([{ type: 'bilibili', bvid: 'BV1xx411c7mD' }, ...douyinCanonical], douyinPage), undefined)
  const preferred = { title: '抖音', unrelated: 'https://www.bilibili.com/video/BV1xx411c7mD', qqdocurl: douyinPage }
  assert.deepEqual(extractQqMediaShare([{ type: 'json', data: preferred }]), douyinShare)
  assert.deepEqual(extractQqMediaShare([{ type: 'json', data: { title: '混合', first: douyinPage, later: page } }]), share)
  assert.deepEqual(extractQqMediaShare([{ type: 'text', data: { text: 'ordinary' } }], cq(douyinCard)), douyinShare)
})

test('Douyin bare IDs, metadata, CDN resources and forged official URLs never become references', () => {
  for (const input of [douyinId, 'https://v.douyin.com.evil.invalid/EULdbQEydtc/', 'https://v.douyin.com@evil.invalid/EULdbQEydtc/',
    'https://evil.invalid/?next=https://v.douyin.com/EULdbQEydtc/', 'https://v.douyin.com:443/EULdbQEydtc/',
    'https://v.douyin.com/EULdbQEydtc/#fragment', 'https://v.douyin.com/EULdbQEydtc/\\evil', 'https://v.douyin.com/EULdbQEydtc/\u0000evil',
    'https://www.douyin.com/video/0123456', 'https://www.douyin.com/video/12345', 'https://www.douyin.com/video/123456789012345678901',
    'https://www.douyin.com/video/%37' + douyinId.slice(1), 'https://v26.douyinvod.com/video/owned.mp4', 'https://p3.douyinpic.com/cover.webp']) {
    assert.equal(extractQqMediaShare(input), undefined, input)
  }
  for (const input of [{ type: 'douyin', aweme_id: douyinId }, { type: 'douyin', data: { aweme_id: douyinId } },
    { type: 'douyin', play_url: douyinPage }, { type: 'douyin', cover_url: douyinPage },
    { type: 'douyin', music_url: douyinPage }, { type: 'douyin', images: [douyinPage] },
    { type: 'douyin', page_url: page }, { type: 'json', data: { aweme_id: douyinId, author: 'native metadata' } }]) assert.equal(extractQqMediaShare([input]), undefined)
})

test('Douyin native getters, CQ duplicate fields, bounded JSON and snapshots fail closed without executing getters', () => {
  let touched = 0
  const native = { type: 'douyin', get short_url() { touched++; throw Error('private getter') } }
  assert.equal(extractQqMediaShare([native]), undefined)
  assert.equal(extractQqMediaShare(`[CQ:douyin,url=${douyinPage},url=${douyinPage}]`), undefined)
  let nested = douyinCard; for (let i = 0; i < 20; i++) nested = { wrapper: nested }
  for (const input of [[{ type: 'json', data: nested }], [{ type: 'json', data: { qqdocurl: douyinPage, desc: 'x'.repeat(65537) } }],
    [{ type: 'douyin', data: { short_url: douyinPage, metadata: new Date() } }]]) assert.equal(extractQqMediaShare(input), undefined)
  assert.equal(touched, 0)
})

test('Douyin source is verified independently from card authors and authorized twice without exposing native metadata', async () => {
  const seen = [], response = message({ message: douyinCanonical })
  const result = await direct(response).read(group, '71', options({ async allowsSource(source) {
    seen.push(source); assert.equal(source.sender.id, author.id); assert.equal(source.text, '')
    assert.equal(source.quote, undefined); assert.deepEqual(source.parts, [{ kind: 'extension', platform: 'qq', type: 'json' }])
    for (const forbidden of ['999999', 'qqdocurl', 'douyinpic', '卡片作者']) assert.equal(JSON.stringify(source).includes(forbidden), false)
    if (seen.length === 1) response.data.message = canonical
    return true
  } }))
  assert.deepEqual(result.share, douyinShare); assert.equal(seen.length, 2); assert.equal(seen[0], seen[1]); assert.ok(Object.isFrozen(result.message))
})

test('Douyin source mismatches, unauthorized policies and changed guards cannot return a share', async () => {
  for (const extra of [{ self_id: '987654' }, { group_id: '987654' }, { message_type: 'private' }, { message_id: 72 },
    { user_id: '987654' }, { sender: { user_id: '987654' } }, { time: occurredAt / 1000 + 1 },
    { user_id: account.id, sender: { user_id: account.id } }, { post_type: 'message_sent' }]) {
    let authorized = false
    assert.equal(await direct(message({ message: douyinCanonical, ...extra })).read(group, '71', options({ allowsSource: async () => { authorized = true; return true } })), undefined)
    assert.equal(authorized, false)
  }
  let calls = 0
  assert.equal(await direct(message({ message: douyinCanonical })).read(group, '71', options({ allowsSource: async () => ++calls === 1 })), undefined)
  assert.equal(calls, 2)
  let changed = false
  const guard = options({ allowsSource: async () => { guard.expectedSource.author.id = '987654'; changed = true; return true } })
  assert.equal(await direct(message({ message: douyinCanonical })).read(group, '71', guard), undefined); assert.equal(changed, true)
})

test('Xiaohongshu text, CQ and every JSON envelope expose only a frozen safe share while access stays in the verified reader', async () => {
  for (const input of [[{ type: 'text', data: { text: `分享小红书 ${xhsPage}` } }], xhsPage, cq(xhsCard), xhsCanonical,
    [{ type: 'json', data: JSON.stringify(xhsCard) }], [{ type: 'json', data: xhsCard }], [{ type: 'json', data: { data: xhsCard } }],
    [{ type: 'json', data: { data: JSON.stringify(JSON.stringify(xhsCard)) } }], [{ type: 'json', data: { wrapper: JSON.stringify(xhsCard) } }]]) {
    const safe = extractQqMediaShare(input)
    assert.deepEqual(safe, xhsShare); assert.ok(Object.isFrozen(safe)); assert.ok(Object.isFrozen(safe.reference))
    assert.deepEqual(Object.keys(safe), ['provider', 'reference']); assert.deepEqual(Object.keys(safe.reference), ['kind', 'id'])
    for (const forbidden of [xhsToken, encodeURIComponent(xhsToken), 'xsec', '999999', 'ugcimg', '卡片']) assert.equal(JSON.stringify(safe).includes(forbidden), false)
    let calls = 0
    const read = await direct(message({ message: input })).read(group, '71', options({ allowsSource: async () => { calls++; return true } }))
    assert.deepEqual(read.share, xhsShare); assert.deepEqual(read.access, xhsAccess); assert.ok(Object.isFrozen(read.access)); assert.equal(calls, 2)
  }
  for (const input of [[{ type: 'json' }], [{ type: 'json', data: '{invalid' }], [{ type: 'text', data: { text: 'ordinary' } }]]) {
    assert.deepEqual(extractQqMediaShare(input, cq(xhsCard)), xhsShare)
    const read = await direct(message({ message: input, raw_message: cq(xhsCard) })).read(group, '71', options())
    assert.deepEqual(read.share, xhsShare); assert.deepEqual(read.access, xhsAccess)
  }
})

test('YouTube text, CQ and every JSON envelope reuse the Core parser and expose only a frozen video reference', async () => {
  const escaped = { meta: { detail_1: { qqdocurl: youtubePage.replace(/\//gu, '\\/').replace(/&/gu, '&amp;') } } }
  for (const input of [youtubePage, [{ type: 'text', text: youtubePage }], [{ type: 'text', data: { text: `分享 ${youtubePage}` } }],
    cq(youtubeCard), youtubeCanonical, [{ type: 'json', data: JSON.stringify(youtubeCard) }], [{ type: 'json', data: youtubeCard }],
    [{ type: 'json', data: { data: youtubeCard } }], [{ type: 'json', data: { data: JSON.stringify(JSON.stringify(youtubeCard)) } }],
    [{ type: 'json', data: { wrapper: JSON.stringify(youtubeCard) } }], [{ type: 'json', data: escaped }]]) {
    const safe = extractQqMediaShare(input)
    assert.deepEqual(safe, youtubeShare); assert.ok(Object.isFrozen(safe)); assert.ok(Object.isFrozen(safe.reference))
    assert.deepEqual(Object.keys(safe), ['provider', 'reference']); assert.deepEqual(Object.keys(safe.reference), ['kind', 'id'])
    for (const forbidden of ['feature', '999999', 'ytimg', 'qqdocurl', '卡片']) assert.equal(JSON.stringify(safe).includes(forbidden), false)
    let calls = 0
    const read = await direct(message({ message: input })).read(group, '71', options({ allowsSource: async () => { calls++; return true } }))
    assert.deepEqual(read.share, youtubeShare); assert.equal(read.access, undefined); assert.equal(calls, 2)
  }
  for (const input of [[{ type: 'json' }], [{ type: 'json', data: '{invalid' }], [{ type: 'text', data: { text: 'ordinary' } }]]) {
    assert.deepEqual(extractQqMediaShare(input, cq(youtubeCard)), youtubeShare)
    assert.deepEqual((await direct(message({ message: input, raw_message: cq(youtubeCard) })).read(group, '71', options())).share, youtubeShare)
  }
})

test('YouTube native URL fields accept official forms without trusting IDs, metadata or CDN resources', () => {
  for (const url of [`https://youtu.be/${youtubeId}?si=tracking`, youtubePage, `https://m.youtube.com/shorts/${youtubeId}`,
    `https://music.youtube.com/watch?v=${youtubeId}`, `https://www.youtube.com/embed/${youtubeId}`, `https://www.youtube.com/live/${youtubeId}`]) {
    for (const key of ['short_url', 'page_url', 'video_url', 'final_url', 'qqdocurl', 'url', 'jumpUrl']) {
      for (const input of [[{ type: 'youtube', [key]: url, video_id: 'forged', title: 'forged', metadata_status: 'ready' }],
        [{ type: 'youtube', data: { [key]: url, video_id: 'forged', cover_url: 'https://evil.invalid/cover' } }]]) {
        assert.deepEqual(extractQqMediaShare(input), youtubeShare)
      }
    }
  }
  for (const input of [youtubeId, [{ type: 'youtube', video_id: youtubeId, metadata_status: 'ready' }],
    [{ type: 'youtube', title: youtubePage, description: youtubePage, play_url: youtubePage, cover_url: youtubePage }],
    [{ type: 'youtube', page_url: 'https://rr1---sn-fixture.googlevideo.com/videoplayback?id=' + youtubeId }],
    [{ type: 'youtube', page_url: 'https://i.ytimg.com/vi/' + youtubeId + '/hqdefault.jpg' }],
    [{ type: 'json', data: { video_id: youtubeId, title: 'YouTube', metadata_status: 'ready' } }],
    `https://youtube.com.evil.test/watch?v=${youtubeId}`, `https://www.youtube.com/watch?v=too_short`]) assert.equal(extractQqMediaShare(input), undefined)
})

test('YouTube stays after Douyin and before Xiaohongshu without changing native blockers or Bilibili scanning', async () => {
  const text = text => ({ type: 'text', data: { text } }), native = { type: 'youtube', page_url: youtubePage }
  for (const input of [[text(youtubePage), ...canonical], [...youtubeCanonical, ...canonical], [native, ...canonical],
    [{ type: 'youtube', video_id: youtubeId }, ...canonical]]) assert.deepEqual(extractQqMediaShare(input), share)
  for (const input of [[text(youtubePage), ...douyinCanonical], [...youtubeCanonical, ...douyinCanonical], [native, text(douyinPage)],
    [native, { type: 'douyin', short_url: douyinPage }], [{ type: 'youtube', video_id: youtubeId }, ...douyinCanonical]]) {
    assert.deepEqual(extractQqMediaShare(input), douyinShare)
  }
  for (const input of [[...xhsCanonical, ...youtubeCanonical], [{ type: 'xiaohongshu', page_url: xhsPage }, native],
    [text(xhsPage), text(youtubePage)], [{ type: 'youtube', video_id: youtubeId }, ...xhsCanonical, ...youtubeCanonical]]) {
    const read = await direct(message({ message: input })).read(group, '71', options())
    assert.deepEqual(read.share, youtubeShare); assert.equal(read.access, undefined)
  }
  assert.deepEqual(extractQqMediaShare([native], page), share)
  assert.deepEqual(extractQqMediaShare([native], douyinPage), douyinShare)
  assert.deepEqual(extractQqMediaShare(xhsCanonical, youtubePage), youtubeShare)
  assert.equal(extractQqMediaShare([{ type: 'douyin', data: {} }, ...youtubeCanonical]), undefined)
  assert.equal(extractQqMediaShare([{ type: 'bilibili', data: {} }, ...youtubeCanonical]), undefined)
  assert.deepEqual(extractQqMediaShare([{ type: 'youtube', video_id: youtubeId }, ...youtubeCanonical]), youtubeShare)
  assert.deepEqual(extractQqMediaShare([{ type: 'youtube', video_id: youtubeId }, ...xhsCanonical]), xhsShare)
  for (const url of [page, douyinPage]) assert.equal(extractQqMediaShare([{ type: 'json', data: { title: 'mixed', qqdocurl: youtubePage, another: url } }]).provider,
    url === page ? 'bilibili' : 'douyin')
  assert.deepEqual(extractQqMediaShare([{ type: 'json', data: { title: 'mixed', qqdocurl: xhsPage, another: youtubePage } }]), youtubeShare)
})

test('Pixiv text, CQ and JSON cards expose a frozen artwork reference without metadata or source queries', async () => {
  const escaped = { meta: { detail_1: { qqdocurl: pixivPage.replace(/\//gu, '\\/').replace(/&/gu, '&amp;') } } }
  for (const input of [pixivPage, [{ type: 'text', text: pixivPage }], [{ type: 'text', data: { text: `分享 ${pixivPage}` } }],
    cq(pixivCard), pixivCanonical, [{ type: 'json', data: JSON.stringify(pixivCard) }], [{ type: 'json', data: pixivCard }],
    [{ type: 'json', data: { data: pixivCard } }], [{ type: 'json', data: { data: JSON.stringify(JSON.stringify(pixivCard)) } }],
    [{ type: 'json', data: { wrapper: JSON.stringify(pixivCard) } }], [{ type: 'json', data: escaped }]]) {
    const safe = extractQqMediaShare(input)
    assert.deepEqual(safe, pixivShare); assert.ok(Object.isFrozen(safe)); assert.ok(Object.isFrozen(safe.reference))
    assert.deepEqual(Object.keys(safe), ['provider', 'reference']); assert.deepEqual(Object.keys(safe.reference), ['kind', 'id'])
    for (const forbidden of ['utm_', '999999', 'pximg', 'qqdocurl', '卡片']) assert.equal(JSON.stringify(safe).includes(forbidden), false)
    let calls = 0
    const read = await direct(message({ message: input })).read(group, '71', options({ allowsSource: async () => { calls++; return true } }))
    assert.deepEqual(read.share, pixivShare); assert.equal(read.access, undefined); assert.equal(calls, 2)
  }
  for (const input of [[{ type: 'json' }], [{ type: 'json', data: '{invalid' }], [{ type: 'text', data: { text: 'ordinary' } }]]) {
    assert.deepEqual(extractQqMediaShare(input, cq(pixivCard)), pixivShare)
    assert.deepEqual((await direct(message({ message: input, raw_message: cq(pixivCard) })).read(group, '71', options())).share, pixivShare)
  }
})

test('Pixiv native official URL fields support artwork and legacy routes without trusting raw IDs or images', () => {
  for (const url of [pixivPage, `https://pixiv.net/en/artworks/${pixivId}`, `http://www.pixiv.net/ja/artworks/${pixivId}`,
    `https://www.pixiv.net/member_illust.php?mode=medium&illust_id=${pixivId}`]) {
    for (const key of ['short_url', 'page_url', 'final_url', 'qqdocurl', 'url', 'jumpUrl']) for (const input of [
      [{ type: 'pixiv', [key]: url, artwork_id: 'forged', title: 'forged', metadata_status: 'resolved' }],
      [{ type: 'pixiv', data: { [key]: url, artwork_id: 'forged', cover_url: 'https://evil.invalid/cover' } }],
    ]) assert.deepEqual(extractQqMediaShare(input), pixivShare)
  }
  for (const input of [pixivId, [{ type: 'pixiv', artwork_id: pixivId, metadata_status: 'resolved' }],
    [{ type: 'pixiv', title: pixivPage, description: pixivPage, video_url: pixivPage, cover_url: pixivPage, image_url: pixivPage, images: [pixivPage] }],
    [{ type: 'pixiv', page_url: 'https://i.pximg.net/img-original/img/2026/11/16/00/00/00/' + pixivId + '_p0.png' }],
    [{ type: 'json', data: { artwork_id: pixivId, title: 'Pixiv', metadata_status: 'resolved' } }],
    `https://pixiv.net.evil.test/artworks/${pixivId}`, 'https://www.pixiv.net/artworks/0', 'https://www.pixiv.net/artworks/1234567890123']) {
    assert.equal(extractQqMediaShare(input), undefined)
  }
})

test('Pixiv stays after YouTube and before Xiaohongshu while Bilibili, native Douyin and malformed blockers retain priority', async () => {
  const text = text => ({ type: 'text', data: { text } }), native = { type: 'pixiv', page_url: pixivPage }
  for (const [higher, expected] of [[canonical, share], [douyinCanonical, douyinShare], [youtubeCanonical, youtubeShare]]) {
    for (const input of [[text(pixivPage), ...higher], [...pixivCanonical, ...higher], [native, ...higher], [{ type: 'pixiv', artwork_id: pixivId }, ...higher]]) {
      assert.deepEqual(extractQqMediaShare(input), expected)
    }
  }
  for (const input of [[...xhsCanonical, ...pixivCanonical], [{ type: 'xiaohongshu', page_url: xhsPage }, native],
    [text(xhsPage), text(pixivPage)], [{ type: 'pixiv', artwork_id: pixivId }, ...xhsCanonical, ...pixivCanonical]]) {
    const read = await direct(message({ message: input })).read(group, '71', options()); assert.deepEqual(read.share, pixivShare); assert.equal(read.access, undefined)
  }
  for (const [raw, expected] of [[page, share], [douyinPage, douyinShare], [youtubePage, youtubeShare]]) assert.deepEqual(extractQqMediaShare([native], raw), expected)
  assert.deepEqual(extractQqMediaShare(xhsCanonical, pixivPage), pixivShare)
  assert.equal(extractQqMediaShare([{ type: 'douyin', data: {} }, ...pixivCanonical]), undefined)
  assert.equal(extractQqMediaShare([{ type: 'bilibili', data: {} }, ...pixivCanonical]), undefined)
  assert.deepEqual(extractQqMediaShare([{ type: 'pixiv', artwork_id: pixivId }, ...pixivCanonical]), pixivShare)
  assert.deepEqual(extractQqMediaShare([{ type: 'pixiv', artwork_id: pixivId }, ...xhsCanonical]), xhsShare)
  for (const [url, expected] of [[page, share], [douyinPage, douyinShare], [youtubePage, youtubeShare]]) {
    assert.deepEqual(extractQqMediaShare([{ type: 'json', data: { title: 'mixed', qqdocurl: pixivPage, another: url } }]), expected)
  }
  assert.deepEqual(extractQqMediaShare([{ type: 'json', data: { title: 'mixed', qqdocurl: xhsPage, another: pixivPage } }]), pixivShare)
})

test('Pixiv source snapshots retain the verified author and original text while metadata and replacement cards stay detached', async () => {
  const response = message({ message: pixivCanonical }), seen = []
  const read = await direct(response).read(group, '71', options({ async allowsSource(source) {
    seen.push(source); assert.equal(source.sender.id, author.id); assert.equal(source.occurredAt, occurredAt); assert.equal(source.text, '')
    for (const value of ['999999', 'pximg', '卡片', 'qqdocurl']) assert.equal(JSON.stringify(source).includes(value), false)
    if (seen.length === 1) response.data.message = [{ type: 'pixiv', page_url: `https://www.pixiv.net/artworks/${pixivOtherId}` }]
    return true
  } }))
  assert.deepEqual(read.share, pixivShare); assert.equal(read.access, undefined); assert.equal(seen.length, 2); assert.equal(seen[0], seen[1]); assert.ok(Object.isFrozen(read.message))
  assert.equal((await direct(message({ message: [{ type: 'text', data: { text: pixivPage } }] })).read(group, '71', options())).message.text, pixivPage)
  for (const extra of [{ self_id: '987654' }, { group_id: '987654' }, { message_type: 'private' }, { message_id: 72 },
    { user_id: '987654' }, { sender: { user_id: '987654' } }, { time: occurredAt / 1000 + 1 }]) {
    let authorized = false
    assert.equal(await direct(message({ message: pixivCanonical, ...extra })).read(group, '71', options({ allowsSource: async () => { authorized = true; return true } })), undefined)
    assert.equal(authorized, false)
  }
  let calls = 0
  assert.equal(await direct(message({ message: pixivCanonical })).read(group, '71', options({ allowsSource: async () => ++calls === 1 })), undefined); assert.equal(calls, 2)
})

test('YouTube source snapshots preserve verified author and original text while card metadata and mutations stay outside Core', async () => {
  const response = message({ message: youtubeCanonical }), seen = []
  const read = await direct(response).read(group, '71', options({ async allowsSource(source) {
    seen.push(source); assert.equal(source.sender.id, author.id); assert.equal(source.occurredAt, occurredAt); assert.equal(source.text, '')
    for (const value of ['999999', 'ytimg', '卡片', 'qqdocurl']) assert.equal(JSON.stringify(source).includes(value), false)
    if (seen.length === 1) response.data.message = [{ type: 'youtube', page_url: `https://youtu.be/${youtubeOtherId}` }]
    return true
  } }))
  assert.deepEqual(read.share, youtubeShare); assert.equal(read.access, undefined); assert.equal(seen.length, 2); assert.equal(seen[0], seen[1])
  assert.ok(Object.isFrozen(read.message)); assert.ok(Object.isFrozen(read.share))
  const original = await direct(message({ message: [{ type: 'text', data: { text: youtubePage } }] })).read(group, '71', options())
  assert.equal(original.message.text, youtubePage)
  for (const extra of [{ self_id: '987654' }, { group_id: '987654' }, { message_type: 'private' }, { message_id: 72 },
    { user_id: '987654' }, { sender: { user_id: '987654' } }, { time: occurredAt / 1000 + 1 }]) {
    let authorized = false
    assert.equal(await direct(message({ message: youtubeCanonical, ...extra })).read(group, '71', options({ allowsSource: async () => { authorized = true; return true } })), undefined)
    assert.equal(authorized, false)
  }
  let calls = 0
  assert.equal(await direct(message({ message: youtubeCanonical })).read(group, '71', options({ allowsSource: async () => ++calls === 1 })), undefined)
  assert.equal(calls, 2)
})

test('Xiaohongshu native URL fields and legacy text preserve business access while raw IDs and downloaded resources stay untrusted', async () => {
  for (const input of [[{ type: 'text', text: xhsPage }], [{ type: 'text', data: { text: xhsPage } }],
    ...['short_url', 'page_url', 'final_url', 'qqdocurl', 'url', 'jumpUrl'].flatMap(key => [
      [{ type: 'xiaohongshu', [key]: xhsPage, note_id: 'forged', xsec_token: 'forged', media_kind: 'image' }],
      [{ type: 'xiaohongshu', data: { [key]: xhsPage, note_id: 'forged', xsec_token: 'forged' } }],
    ])]) {
    const read = await direct(message({ message: input })).read(group, '71', options())
    assert.deepEqual(read.share, xhsShare); assert.deepEqual(read.access, xhsAccess)
  }
  const short = 'https://xhslink.com/aBC123'
  assert.deepEqual(extractQqMediaShare(short), { provider: 'xiaohongshu', reference: { kind: 'short', id: 'aBC123' } })
  for (const input of [xhsId, [{ type: 'xiaohongshu', note_id: xhsId, xsec_token: xhsToken }],
    [{ type: 'xiaohongshu', play_url: xhsPage, cover_url: xhsPage, images: [xhsPage] }],
    [{ type: 'xiaohongshu', page_url: 'https://sns-video-v6.xhscdn.com/stream/file.mp4' }],
    [{ type: 'json', data: { note_id: xhsId, title: '小红书', xsec_token: xhsToken } }]]) assert.equal(extractQqMediaShare(input), undefined)
})

test('Xiaohongshu remains the last provider without changing Bilibili or native Douyin precedence and blocking rules', async () => {
  const text = text => ({ type: 'text', data: { text } }), xhsNative = { type: 'xiaohongshu', page_url: xhsPage }
  for (const input of [[text(xhsPage), ...canonical], [...xhsCanonical, ...canonical], [xhsNative, ...canonical],
    [{ type: 'xiaohongshu', note_id: xhsId }, ...canonical]]) assert.deepEqual(extractQqMediaShare(input), share)
  for (const input of [[text(xhsPage), ...douyinCanonical], [...xhsCanonical, ...douyinCanonical], [xhsNative, text(douyinPage)],
    [xhsNative, { type: 'douyin', short_url: douyinPage }], [{ type: 'xiaohongshu', note_id: xhsId }, ...douyinCanonical]]) {
    const read = await direct(message({ message: input })).read(group, '71', options())
    assert.deepEqual(read.share, douyinShare); assert.equal(read.access, undefined)
  }
  assert.deepEqual(extractQqMediaShare([xhsNative], page), share)
  assert.deepEqual(extractQqMediaShare([xhsNative], douyinPage), douyinShare)
  assert.equal(extractQqMediaShare([{ type: 'douyin', data: {} }, ...xhsCanonical]), undefined)
  assert.equal(extractQqMediaShare([{ type: 'bilibili', data: {} }, ...xhsCanonical]), undefined)
  assert.deepEqual(extractQqMediaShare([{ type: 'xiaohongshu', note_id: xhsId }, ...xhsCanonical]), xhsShare)
  assert.deepEqual(extractQqMediaShare([{ type: 'json', data: { title: 'mixed', qqdocurl: xhsPage, another: page } }]), share)
  assert.deepEqual(extractQqMediaShare([{ type: 'json', data: { title: 'mixed', qqdocurl: xhsPage, another: douyinPage } }]), douyinShare)
})

test('Xiaohongshu access belongs only to the actual selected official URL, never another field, message, provider or same-note fallback', async () => {
  const other = `https://www.xiaohongshu.com/explore/${otherXhsId}?xsec_token=${encodeURIComponent(otherXhsToken)}`
  const tokenSameNote = `${xhsSafePage}?xsec_token=${encodeURIComponent(otherXhsToken)}`
  for (const input of [[{ type: 'text', data: { text: `${xhsSafePage} ${tokenSameNote}` } }],
    [{ type: 'xiaohongshu', page_url: xhsSafePage, xsec_token: xhsToken, final_url: tokenSameNote }],
    [{ type: 'json', data: { meta: { news: { jumpUrl: xhsSafePage, desc: tokenSameNote } } } }]]) {
    const read = await direct(message({ message: input, raw_message: tokenSameNote })).read(group, '71', options())
    assert.deepEqual(read.share, xhsShare); assert.deepEqual(read.access, { provider: 'xiaohongshu' })
  }
  const selected = await direct(message({ message: [{ type: 'json', data: { meta: { news: { title: other, jumpUrl: xhsPage } } } }], raw_message: other })).read(group, '71', options())
  assert.deepEqual(selected.share, xhsShare); assert.deepEqual(selected.access, xhsAccess)
  const first = await direct(message({ message: [{ type: 'text', data: { text: `${other} ${xhsPage}` } }] })).read(group, '71', options())
  assert.deepEqual(first.share.reference.id, otherXhsId); assert.deepEqual(first.access, { provider: 'xiaohongshu', xsecToken: otherXhsToken })
  const bili = await direct(message({ message: [...xhsCanonical, ...canonical] })).read(group, '71', options())
  assert.deepEqual(bili.share, share); assert.equal(bili.access, undefined)
})

test('Xiaohongshu source snapshots retain original neutral text for both authorizations but isolate all native card metadata', async () => {
  const native = [{ type: 'text', data: { text: xhsPage } }, { type: 'at', data: { qq: author.id } }]
  const response = message({ message: native }), seen = []
  const read = await direct(response).read(group, '71', options({ async allowsSource(source) {
    seen.push(source); assert.equal(source.text, xhsPage); assert.equal(source.sender.id, author.id)
    assert.equal(source.occurredAt, occurredAt); assert.ok(Object.isFrozen(source)); assert.equal(source.quote, undefined)
    if (seen.length === 1) { native[0].data.text = xhsSafePage; response.data.sender.user_id = '999999' }
    return true
  } }))
  assert.equal(seen.length, 2); assert.equal(seen[0], seen[1]); assert.deepEqual(read.access, xhsAccess)
  assert.equal(read.message.text, xhsPage)
  const cardRead = await direct(message({ message: xhsCanonical })).read(group, '71', options({ allowsSource: async source => {
    for (const forbidden of ['999999', 'ugcimg', 'jumpUrl', '卡片', xhsToken]) assert.equal(JSON.stringify(source).includes(forbidden), false)
    return true
  } }))
  assert.deepEqual(cardRead.access, xhsAccess)
})

test('Xiaohongshu source mismatches and either rejected authorization never expose selected access', async () => {
  for (const extra of [{ self_id: '987654' }, { group_id: '987654' }, { message_type: 'private' }, { message_id: 72 },
    { user_id: '987654' }, { sender: { user_id: '987654' } }, { time: occurredAt / 1000 + 1 }]) {
    let calls = 0
    assert.equal(await direct(message({ message: xhsCanonical, ...extra })).read(group, '71', options({ allowsSource: async () => { calls++; return true } })), undefined)
    assert.equal(calls, 0)
  }
  for (const rejectAt of [1, 2]) {
    let calls = 0
    assert.equal(await direct(message({ message: xhsCanonical })).read(group, '71', options({ allowsSource: async () => ++calls !== rejectAt })), undefined)
    assert.equal(calls, rejectAt)
  }
  let recalled = false
  const guard = options({ isCurrent: () => !recalled, allowsSource: async () => { recalled = true; return true } })
  assert.equal(await direct(message({ message: xhsCanonical })).read(group, '71', guard), undefined)
})

test('Xiaohongshu protocol getters, duplicate CQ parameters and oversized snapshots reject without evaluating native behavior', async () => {
  let touched = 0
  const getter = { type: 'xiaohongshu', get page_url() { touched++; return xhsPage } }
  const nestedGetter = { type: 'json', data: { meta: { news: { get jumpUrl() { touched++; return xhsPage } } } } }
  const sparse = []; sparse.length = 1
  for (const input of [[getter], [nestedGetter], sparse, `[CQ:xiaohongshu,url=${xhsPage},url=${xhsPage}]`,
    [{ type: 'xiaohongshu', page_url: xhsPage, title: 'x'.repeat(65537) }]]) {
    assert.equal(extractQqMediaShare(input), undefined)
    assert.equal(await direct(message({ message: input })).read(group, '71', options()), undefined)
  }
  assert.equal(touched, 0)
})

test('bare ids, nonofficial hosts, userinfo, fragments, controls and arbitrary native ids do not become references', () => {
  for (const text of ['BV1xx411c7mD', 'av123', 'https://evil.invalid/?next=https://b23.tv/JvNsiRF',
    'https://b23.tv.evil.invalid/JvNsiRF', 'https://b23.tv@evil.invalid/JvNsiRF', 'https://b23.tv:443/JvNsiRF',
    'https://b23.tv/JvNsiRF#fragment', 'https://b23.tv/JvNsiRF\\evil', 'https://b23.tv/JvNsiRF\u0000evil',
    'https://www.bilibili.com/bangumi/play/ep01', 'https://www.bilibili.com/video/BVshort']) {
    assert.equal(extractQqMediaShare(text), undefined, text)
  }
  assert.equal(extractQqMediaShare([{ type: 'bilibili', data: { bvid: 'BV1xx411c7mD' } }]), undefined)
})

test('bounds, sparse arrays, getters, cycles, symbols and nonordinary native data fail closed without invoking getters', () => {
  let touched = 0
  const accessor = { type: 'json', get data() { touched++; throw new Error('native getter') } }
  const cycle = {}; cycle.self = cycle
  const symbol = { ...card, [Symbol('native')]: 'x' }
  const sparse = []; sparse.length = 1
  const customArray = [...canonical]; customArray.hidden = 1
  let deep = card; for (let i = 0; i < 20; i++) deep = { child: deep }
  for (const input of [[accessor], [{ type: 'json', data: cycle }], [{ type: 'json', data: symbol }], sparse, customArray,
    [{ type: 'json', data: new Date() }], [{ type: 'json', data: deep }], Array(129).fill('x'), 'x'.repeat(65_537),
    [{ type: 'json', data: { title: 'x'.repeat(65_537), qqdocurl: page } }]]) assert.equal(extractQqMediaShare(input), undefined)
  assert.equal(touched, 0)
  assert.equal(extractQqMediaShare([{ type: 'json', data: '{&quot;url&quot;:&quot;&#99999999;&quot;}' }]), undefined)
})

test('get_msg source is fixed to exact account, group, signed message id, author and original event time', async () => {
  let calls = 0
  const d = direct(), guard = options({ async allowsSource(source) {
    calls++
    assert.equal(source.sender.id, author.id)
    assert.equal(source.occurredAt, occurredAt)
    assert.equal(source.conversation.id, group.id)
    assert.equal(source.quote, undefined)
    assert.equal(source.text, '')
    assert.deepEqual(source.parts, [{ kind: 'extension', platform: 'qq', type: 'json' }])
    assert.equal(JSON.stringify(source).includes('qqdocurl'), false)
    assert.equal(JSON.stringify(source).includes('999999'), false)
    return true
  } })
  const result = await d.read(group, '71', guard)
  assert.deepEqual(result.share, share)
  assert.equal(Object.isFrozen(result.message), true)
  assert.equal(Object.isFrozen(result.message.sender), true)
  assert.equal(Object.isFrozen(result.message.parts), true)
  assert.equal(calls, 2)
  assert.deepEqual(d.calls.map(row => [row.action, row.params]), [['get_msg', { message_id: 71 }]])
  assert.equal(d.calls[0].scope.signal.aborted, true)
  const negative = direct(message({ message_id: -2147483648 }))
  assert.deepEqual((await negative.read(group, '-2147483648', options())).share, share)
})

test('mismatched native source evidence is rejected before source authorization', async t => {
  const cases = [
    ['wrong account', { self_id: '987654' }], ['wrong group', { group_id: '987654' }], ['private', { message_type: 'private' }],
    ['wrong id', { message_id: 72 }], ['array id', { message_id: [71] }], ['leading zero id', { message_id: '071' }],
    ['missing user', { user_id: null }], ['author mismatch', { user_id: '987654', sender: { user_id: '987654' } }],
    ['sender mismatch', { sender: { user_id: '987654' } }], ['self authored', { user_id: account.id, sender: { user_id: account.id } }],
    ['time mismatch', { time: occurredAt / 1000 + 1 }], ['text time', { time: String(occurredAt / 1000) }],
    ['outgoing', { post_type: 'message_sent' }], ['self marker', { message_sent_type: 'self' }],
  ]
  for (const [name, value] of cases) await t.test(name, async () => {
    let authorized = false
    assert.equal(await direct(message(value)).read(group, '71', options({ allowsSource: async () => { authorized = true; return true } })), undefined)
    assert.equal(authorized, false)
  })
  for (const response of [{ ...message(), self_id: '987654' }, { ...message(), status: 'failed' }, { ...message(), retcode: '0' }]) {
    assert.equal(await direct(response).read(group, '71', options()), undefined)
  }
})

test('invalid target, expected source, guard and native getters are rejected before dispatch', async () => {
  const d = direct()
  for (const target of [{ ...group, kind: 'private' }, { ...group, kind: 'channel' }, { ...group, id: '0315320' },
    { ...group, account: { ...account, namespace: 'other' } }, { ...group, account: { ...account, id: '987654' } }]) {
    assert.equal(await d.read(target, '71', options()), undefined)
  }
  for (const guard of [options({ expectedSource: undefined }), options({ expectedSource: { author: account, occurredAt } }),
    options({ expectedSource: { author: { ...author, namespace: 'other' }, occurredAt } }),
    options({ expectedSource: { author, occurredAt: '1700000000000' } }), options({ allowsSource: undefined }),
    options({ signal: new Proxy(new AbortController().signal, { get() { throw new Error('signal getter') } }) }),
    { ...options(), get isCurrent() { throw new Error('guard getter') } }]) assert.equal(await d.read(group, '71', guard), undefined)
  for (const id of ['0', '071', '+71', '2147483648', '-2147483649', '1e2']) assert.equal(await d.read(group, id, options()), undefined)
  assert.equal(d.calls.length, 0)
  let touched = 0
  const response = message(); Object.defineProperty(response.data, 'message', { get() { touched++; throw new Error('native getter') } })
  assert.equal(await direct(response).read(group, '71', options()), undefined)
  assert.equal(touched, 0)
})

test('native content is snapshotted before policy callbacks and source is authorized twice', async () => {
  const response = message(), sourceObjects = []; let calls = 0
  const result = await direct(response).read(group, '71', options({ async allowsSource(source) {
    sourceObjects.push(source)
    if (++calls === 1) response.data.message = [{ type: 'text', data: { text: 'https://www.bilibili.com/video/BV1xx411c7mD' } }]
    return true
  } }))
  assert.deepEqual(result.share, share)
  assert.equal(sourceObjects.length, 2)
  assert.equal(sourceObjects[0], sourceObjects[1])
  let authorized = 0
  assert.equal(await direct().read(group, '71', options({ allowsSource: async () => ++authorized === 1 })), undefined)
  assert.equal(authorized, 2)
  authorized = 0
  assert.equal(await direct().read(group, '71', options({ allowsSource: async () => { authorized++; return false } })), undefined)
  assert.equal(authorized, 1)
})

test('source text and mentions survive sanitization while quoted/card author payloads do not', async () => {
  const result = await direct(message({ message: [
    { type: 'reply', data: { id: 999, user_id: '999999' } }, { type: 'at', data: { qq: account.id } },
    { type: 'text', data: { text: `群友原文 ${page}` } }, ...canonical,
  ] })).read(group, '71', options())
  assert.deepEqual(result.share, share)
  assert.equal(result.message.quote, undefined)
  assert.equal(result.message.text, `群友原文 ${page}`)
  assert.deepEqual(result.message.mentions, [account])
  assert.equal(result.message.directedToAccount, true)
  assert.equal(JSON.stringify(result.message).includes('999999'), false)
})

for (const stage of ['get_msg', 'first authorization', 'second authorization']) {
  test(`cancellation during ${stage} returns promptly and ignores a late result`, async () => {
    const controller = new AbortController(); let entered = false, release, count = 0
    const stalled = () => { entered = true; return new Promise(resolve => { release = resolve }) }
    const d = direct(stage === 'get_msg' ? stalled : message())
    const pending = d.read(group, '71', options({ signal: controller.signal, allowsSource: async () => {
      count++
      return stage === 'first authorization' && count === 1 || stage === 'second authorization' && count === 2 ? stalled() : true
    } }))
    await waitFor(() => entered); controller.abort()
    assert.equal(await Promise.race([pending, delay(500).then(() => 'timeout')]), undefined)
    release(stage === 'get_msg' ? message() : true)
    await delay(5)
    assert.equal(d.calls.length, 1)
  })
}

for (const mutation of ['target', 'expected author', 'expected time', 'expected object', 'account', 'current', 'authorize']) {
  test(`${mutation} changes during authorization revoke the in-flight source`, async () => {
    const mutableAccount = { ...account }, target = { ...group, account: { ...account } }; let entered = false, resume, current = true
    const guard = options({ isCurrent: () => current, allowsSource: async () => { entered = true; return new Promise(resolve => { resume = resolve }) } })
    const d = direct(message(), mutableAccount), pending = d.read(target, '71', guard)
    await waitFor(() => entered)
    if (mutation === 'target') target.id = '987654'
    if (mutation === 'expected author') guard.expectedSource.author.id = '987654'
    if (mutation === 'expected time') guard.expectedSource.occurredAt++
    if (mutation === 'expected object') guard.expectedSource = { author: { ...author }, occurredAt }
    if (mutation === 'account') mutableAccount.id = '987654'
    if (mutation === 'current') current = false
    if (mutation === 'authorize') guard.allowsSource = async () => true
    assert.equal(await Promise.race([pending, delay(500).then(() => 'timeout')]), undefined)
    resume(true)
  })
}

test('get_msg has a 1.5 second deadline inside the 10 second overall reader budget', { timeout: 4000 }, async () => {
  assert.equal(QQ_MEDIA_SHARE_READ_TIMEOUT_MS, 10_000)
  assert.equal(QQ_MEDIA_SHARE_GET_MESSAGE_TIMEOUT_MS, 1_500)
  let captured
  const d = direct((_action, _params, scope) => { captured = scope; return new Promise(() => {}) })
  const started = Date.now()
  assert.equal(await Promise.race([d.read(group, '71', options()), delay(3000).then(() => 'timeout')]), undefined)
  assert.ok(Date.now() - started >= 1400)
  assert.equal(captured.signal.aborted, true)
})

async function fixture(t, transport) {
  const requests = [], peers = []; let peerSocket, server, url, handler = () => message()
  const attach = socket => {
    peerSocket = socket; peers.push(socket); socket.on('error', () => {})
    socket.on('message', raw => {
      const request = JSON.parse(String(raw)); requests.push(request)
      const response = request.action === 'get_login_info' ? ok({ user_id: account.id, nickname: '媒体分享合成验收' }) : handler(request)
      if (response) socket.send(JSON.stringify({ ...response, echo: request.echo }))
    })
    return socket
  }
  if (transport === 'forward-websocket') {
    server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(server, 'listening')
    server.on('connection', (socket, request) => { assert.equal(request.headers.authorization, 'Bearer media-read-fixture'); attach(socket) })
    url = `ws://127.0.0.1:${server.address().port}`
  } else {
    const allocator = createServer(); allocator.listen(0, '127.0.0.1'); await once(allocator, 'listening')
    url = `ws://127.0.0.1:${allocator.address().port}/onebot`; await new Promise(resolve => allocator.close(resolve))
  }
  const adapter = createOneBotConnection({ connection: { id: 'media-read-local', account }, transport, url, accessToken: 'media-read-fixture',
    onDisconnect() {}, onReconnect() {}, onError() {}, onEventError() {} })
  t.after(async () => { adapter.stop(); for (const socket of peers) socket.terminate(); if (server) await new Promise(resolve => server.close(resolve)) })
  assert.equal(await adapter.readMediaShare(group, '71', options()), undefined)
  const start = adapter.start(async () => {}); void start.catch(() => {})
  if (transport === 'reverse-websocket') await waitFor(async () => {
    const socket = attach(new WebSocket(url, { headers: { Authorization: 'Bearer media-read-fixture', 'X-Self-ID': account.id, 'X-Client-Role': 'Universal' } }))
    try { await once(socket, 'open'); return true } catch { socket.terminate(); return false }
  })
  await start
  return { adapter, requests, socket: () => peerSocket, setHandler(value) { handler = value } }
}

for (const transport of ['forward-websocket', 'reverse-websocket']) {
  test(`${transport} reads Pixiv text, CQ, JSON and native URL shares after two verified source checks`, { timeout: 8000 }, async t => {
    const f = await fixture(t, transport)
    for (const native of [[{ type: 'text', data: { text: pixivPage } }], cq(pixivCard), pixivCanonical,
      [{ type: 'pixiv', page_url: pixivPage, artwork_id: 'untrusted', title: 'untrusted', images: ['https://evil.invalid/native.png'] }]]) {
      let calls = 0; f.setHandler(() => message({ message: native }))
      const read = await f.adapter.readMediaShare(group, '71', options({ allowsSource: async source => {
        calls++; assert.equal(source.sender.id, author.id); assert.equal(source.occurredAt, occurredAt); assert.equal(JSON.stringify(source).includes('untrusted'), false); return true
      } }))
      assert.equal(calls, 2); assert.deepEqual(read.share, pixivShare); assert.equal(read.access, undefined); assert.ok(Object.isFrozen(read.share))
    }
    assert.deepEqual(f.requests.map(row => row.action), ['get_login_info', 'get_msg', 'get_msg', 'get_msg', 'get_msg'])
  })
  test(`${transport} cancels Pixiv at the second source check and rereads replacement, time mismatch and recall without cache`, { timeout: 8000 }, async t => {
    const f = await fixture(t, transport), controller = new AbortController(); let calls = 0, entered = false, finish
    f.setHandler(() => message({ message: pixivCanonical }))
    const pending = f.adapter.readMediaShare(group, '71', options({ signal: controller.signal, allowsSource: async () => {
      if (++calls === 1) return true
      entered = true; return new Promise(resolve => { finish = resolve })
    } }))
    await waitFor(() => entered); controller.abort(); assert.equal(await Promise.race([pending, delay(600).then(() => 'timeout')]), undefined)
    finish(true); await delay(10); assert.equal(calls, 2)
    f.setHandler(() => message({ message: [{ type: 'pixiv', page_url: `https://www.pixiv.net/artworks/${pixivOtherId}` }] }))
    assert.deepEqual((await f.adapter.readMediaShare(group, '71', options())).share, { provider: 'pixiv', reference: { kind: 'artwork', id: pixivOtherId } })
    f.setHandler(() => message({ message: pixivCanonical, time: occurredAt / 1000 + 1 })); assert.equal(await f.adapter.readMediaShare(group, '71', options()), undefined)
    f.setHandler(() => ({ status: 'failed', retcode: 1200, data: null })); assert.equal(await f.adapter.readMediaShare(group, '71', options()), undefined)
    assert.deepEqual(f.requests.map(row => row.action), ['get_login_info', 'get_msg', 'get_msg', 'get_msg', 'get_msg'])
  })
  test(`${transport} reads YouTube text, CQ, JSON and native references after two source checks without trusting card metadata`, { timeout: 8000 }, async t => {
    const f = await fixture(t, transport)
    for (const native of [[{ type: 'text', data: { text: youtubePage } }], cq(youtubeCard), youtubeCanonical,
      [{ type: 'youtube', page_url: youtubePage, video_id: 'untrusted', title: 'untrusted', play_url: 'https://evil.invalid/native.mp4' }]]) {
      let calls = 0; f.setHandler(() => message({ message: native }))
      const read = await f.adapter.readMediaShare(group, '71', options({ allowsSource: async source => {
        calls++; assert.equal(source.sender.id, author.id); assert.equal(source.occurredAt, occurredAt)
        assert.equal(JSON.stringify(source).includes('untrusted'), false); return true
      } }))
      assert.equal(calls, 2); assert.deepEqual(read.share, youtubeShare); assert.equal(read.access, undefined); assert.ok(Object.isFrozen(read.share))
    }
    assert.deepEqual(f.requests.map(row => row.action), ['get_login_info', 'get_msg', 'get_msg', 'get_msg', 'get_msg'])
  })
  test(`${transport} cancels YouTube at the second source check and rereads changed or recalled shares without cache`, { timeout: 8000 }, async t => {
    const f = await fixture(t, transport), controller = new AbortController(); let calls = 0, entered = false, finish
    f.setHandler(() => message({ message: youtubeCanonical }))
    const pending = f.adapter.readMediaShare(group, '71', options({ signal: controller.signal, allowsSource: async () => {
      if (++calls === 1) return true
      entered = true; return new Promise(resolve => { finish = resolve })
    } }))
    await waitFor(() => entered); controller.abort(); assert.equal(await Promise.race([pending, delay(600).then(() => 'timeout')]), undefined)
    finish(true); await delay(10); assert.equal(calls, 2)
    f.setHandler(() => message({ message: [{ type: 'youtube', page_url: `https://youtu.be/${youtubeOtherId}` }] }))
    assert.deepEqual((await f.adapter.readMediaShare(group, '71', options())).share, { provider: 'youtube', reference: { kind: 'video', id: youtubeOtherId } })
    f.setHandler(() => message({ message: youtubeCanonical, time: occurredAt / 1000 + 1 }))
    assert.equal(await f.adapter.readMediaShare(group, '71', options()), undefined)
    f.setHandler(() => ({ status: 'failed', retcode: 1200, data: null }))
    assert.equal(await f.adapter.readMediaShare(group, '71', options()), undefined)
    assert.deepEqual(f.requests.map(row => row.action), ['get_login_info', 'get_msg', 'get_msg', 'get_msg', 'get_msg'])
  })
  test(`${transport} reads Xiaohongshu text, CQ, JSON and native references with selected access only after two source authorizations`, { timeout: 8000 }, async t => {
    const f = await fixture(t, transport)
    for (const native of [[{ type: 'text', data: { text: xhsPage } }], cq(xhsCard), xhsCanonical,
      [{ type: 'xiaohongshu', page_url: xhsPage, note_id: 'untrusted', xsec_token: 'untrusted', play_url: 'https://evil.invalid/file.mp4' }]]) {
      let calls = 0; f.setHandler(() => message({ message: native }))
      const read = await f.adapter.readMediaShare(group, '71', options({ allowsSource: async source => {
        calls++; assert.equal(source.sender.id, author.id); assert.equal(source.occurredAt, occurredAt)
        assert.equal(JSON.stringify(source).includes('untrusted'), false); return true
      } }))
      assert.equal(calls, 2); assert.deepEqual(read.share, xhsShare); assert.deepEqual(read.access, xhsAccess)
      assert.ok(Object.isFrozen(read.access)); assert.equal(JSON.stringify(read.share).includes('xsec'), false)
    }
    assert.deepEqual(f.requests.map(row => row.action), ['get_login_info', 'get_msg', 'get_msg', 'get_msg', 'get_msg'])
  })
  for (const rejectAt of [1, 2]) test(`${transport} cancels Xiaohongshu during authorization ${rejectAt} without returning access or accepting late policy results`, { timeout: 8000 }, async t => {
    const f = await fixture(t, transport), controller = new AbortController(); let calls = 0, entered = false, finish
    f.setHandler(() => message({ message: xhsCanonical }))
    const pending = f.adapter.readMediaShare(group, '71', options({ signal: controller.signal, allowsSource: async () => {
      if (++calls !== rejectAt) return true
      entered = true; return new Promise(resolve => { finish = resolve })
    } }))
    await waitFor(() => entered); controller.abort()
    assert.equal(await Promise.race([pending, delay(600).then(() => 'timeout')]), undefined)
    finish(true); await delay(10); assert.equal(calls, rejectAt)
    assert.equal(f.requests.filter(row => row.action === 'get_msg').length, 1)
  })
  test(`${transport} rereads the exact Xiaohongshu source and never reuses earlier access after replacement or recall`, { timeout: 8000 }, async t => {
    const f = await fixture(t, transport)
    f.setHandler(() => message({ message: xhsCanonical }))
    assert.deepEqual((await f.adapter.readMediaShare(group, '71', options())).access, xhsAccess)
    f.setHandler(() => message({ message: [{ type: 'text', data: { text: xhsSafePage } }] }))
    const replaced = await f.adapter.readMediaShare(group, '71', options())
    assert.deepEqual(replaced.share, xhsShare); assert.deepEqual(replaced.access, { provider: 'xiaohongshu' })
    f.setHandler(() => message({ message: xhsCanonical, time: occurredAt / 1000 + 1 }))
    assert.equal(await f.adapter.readMediaShare(group, '71', options()), undefined)
    f.setHandler(() => ({ status: 'failed', retcode: 1200, data: null }))
    assert.equal(await f.adapter.readMediaShare(group, '71', options()), undefined)
    assert.deepEqual(f.requests.map(row => row.action), ['get_login_info', 'get_msg', 'get_msg', 'get_msg', 'get_msg'])
  })
  test(`${transport} decodes Douyin text, CQ, JSON and native shares through the same read-only verified source port`, { timeout: 8000 }, async t => {
    const f = await fixture(t, transport)
    for (const native of [[{ type: 'text', data: { text: `复制打开抖音 ${douyinPage}` } }], cq(douyinCard), douyinCanonical,
      [{ type: 'douyin', short_url: douyinPage, aweme_id: 'untrusted', author: 'untrusted', play_url: 'https://evil.invalid/native.mp4' }]]) {
      f.setHandler(() => message({ message: native })); let authorizations = 0
      const result = await f.adapter.readMediaShare(group, '71', options({ allowsSource: async source => {
        authorizations++; assert.equal(source.sender.id, author.id); assert.equal(source.occurredAt, occurredAt)
        assert.equal(JSON.stringify(source).includes('untrusted'), false); return true
      } }))
      assert.deepEqual(result.share, douyinShare); assert.equal(authorizations, 2)
      assert.deepEqual(Object.keys(result.share), ['provider', 'reference']); assert.ok(Object.isFrozen(result.share))
    }
    assert.deepEqual(f.requests.map(row => row.action), ['get_login_info', 'get_msg', 'get_msg', 'get_msg', 'get_msg'])
  })
  test(`${transport} revokes a decoded Douyin source while awaiting authorization without retry or late delivery`, { timeout: 8000 }, async t => {
    const f = await fixture(t, transport); f.setHandler(() => message({ message: douyinCanonical }))
    let entered = false, finish
    const controller = new AbortController(), pending = f.adapter.readMediaShare(group, '71', options({ signal: controller.signal,
      allowsSource: async () => { entered = true; return new Promise(resolve => { finish = resolve }) } }))
    await waitFor(() => entered); controller.abort()
    assert.equal(await Promise.race([pending, delay(600).then(() => 'timeout')]), undefined)
    finish(true); await delay(10)
    assert.equal(f.requests.filter(row => row.action === 'get_msg').length, 1)
  })
  test(`${transport} exposes the read-only media source port without media delivery configuration`, { timeout: 8000 }, async t => {
    const f = await fixture(t, transport)
    assert.deepEqual((await f.adapter.readMediaShare(group, '71', options())).share, share)
    const before = f.requests.length
    assert.equal(await f.adapter.readMediaShare({ ...group, kind: 'private' }, '71', options()), undefined)
    assert.equal(f.requests.length, before)
    assert.deepEqual(f.requests.filter(row => row.action !== 'get_login_info').map(row => [row.action, row.params]), [['get_msg', { message_id: 71 }]])
  })
  for (const mode of ['abort', 'stop', 'disconnect', 'rebind']) {
    test(`${transport} ${mode} cancels a pending lookup without retry or late source delivery`, { timeout: 8000 }, async t => {
      const f = await fixture(t, transport), controller = new AbortController(); let current = true
      f.setHandler(() => undefined)
      const pending = f.adapter.readMediaShare(group, '71', options({ signal: controller.signal, isCurrent: () => current }))
      const request = await waitFor(() => f.requests.find(row => row.action === 'get_msg'))
      if (mode === 'abort') controller.abort()
      else if (mode === 'stop') f.adapter.stop()
      else if (mode === 'disconnect') f.socket().terminate()
      else current = false
      assert.equal(await Promise.race([pending, delay(600).then(() => 'timeout')]), undefined)
      if (f.socket().readyState === WebSocket.OPEN) f.socket().send(JSON.stringify({ ...message(), echo: request.echo }))
      await delay(5)
      assert.equal(f.requests.filter(row => row.action === 'get_msg').length, 1)
    })
  }
  test(`${transport} disconnect during authorization invalidates the already-read socket scope`, { timeout: 8000 }, async t => {
    const f = await fixture(t, transport); let entered = false, resume
    const pending = f.adapter.readMediaShare(group, '71', options({ allowsSource: async () => {
      entered = true; return new Promise(resolve => { resume = resolve })
    } }))
    await waitFor(() => entered); f.socket().terminate()
    assert.equal(await Promise.race([pending, delay(600).then(() => 'timeout')]), undefined)
    resume(true)
    assert.equal(f.requests.filter(row => row.action === 'get_msg').length, 1)
  })
}
