import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repo = fileURLToPath(new URL('../', import.meta.url)), release = path.resolve(process.env.BL_CHAT_AGENT_RELEASE_DIR || repo)
const load = name => import(pathToFileURL(path.join(release, 'dist/backend/modules/media/infrastructure', name)).href)
const { parseAgentPixivReference } = await load('agentPixivRelayReference.js')
const { validateAgentMediaShare, agentMediaSharePageUrl, validateAgentMediaPreparedPageUrl } = await load('agentMediaRelayReference.js')
const ID = '126649495', OTHER = '126649496', page = `https://www.pixiv.net/artworks/${ID}`
const share = (id = ID, kind = 'artwork') => ({ provider: 'pixiv', reference: { kind, id } })

test('Pixiv artwork, locale and legacy official references keep only a positive bounded ID', () => {
  for (const host of ['pixiv.net', 'www.pixiv.net']) for (const protocol of ['http', 'https']) {
    for (const route of [`/artworks/${ID}`, `/en/artworks/${ID}`, `/zh/artworks/${ID}?utm_source=qq`,
      `/member_illust.php?illust_id=${ID}`, `/member_illust.php?illust_id=${ID}&mode=medium`,
      `/member_illust.php?mode=medium&illust_id=${ID}&from=share`]) assert.deepEqual(parseAgentPixivReference(`${protocol}://${host}${route}`), share())
  }
  for (const input of [`https://www.pixiv.net:443/artworks/${ID}`, `http://pixiv.net:80/artworks/${ID}`,
    `HTTPS://WWW.PIXIV.NET/artworks/${ID}`, `https://www.pixiv.net/member_illust.php?%69llust_id=${ID}`]) assert.deepEqual(parseAgentPixivReference(input), share())
  for (const id of ['1', '999999999999']) assert.deepEqual(parseAgentPixivReference(`https://pixiv.net/artworks/${id}`), share(id))
  const selected = validateAgentMediaShare(share())
  assert.deepEqual(selected, share()); assert.ok(Object.isFrozen(selected)); assert.ok(Object.isFrozen(selected.reference))
  assert.equal(agentMediaSharePageUrl(selected), page)
})

test('Pixiv rejects deceptive authorities, encoded paths, invalid IDs and unsupported routes', () => {
  for (const input of [`https://pixiv.net.evil.test/artworks/${ID}`, `https://evil.test/https://pixiv.net/artworks/${ID}`,
    `https://user@www.pixiv.net/artworks/${ID}`, `https://user:private@pixiv.net/artworks/${ID}`, `https://pixiv.net@evil.test/artworks/${ID}`,
    `https://www.pixiv.net:444/artworks/${ID}`, `http://pixiv.net:443/artworks/${ID}`, `https://pixiv.net:80/artworks/${ID}`, `https://m.pixiv.net/artworks/${ID}`,
    `https://pixiv.net/artworks/${ID}/extra`, `https://pixiv.net/artworks/${ID}/`, `https://pixiv.net/eng/artworks/${ID}`, `https://pixiv.net/EN/artworks/${ID}`,
    `https://pixiv.net/%61rtworks/${ID}`, `https://pixiv.net/artworks/%31${ID.slice(1)}`, `https://pixiv.net/a/../artworks/${ID}`,
    `https://pixiv.net/users/${ID}`, `https://pixiv.net/artworks/0`, `https://pixiv.net/artworks/0${ID}`, `https://pixiv.net/artworks/${'1'.repeat(13)}`,
    `${page}#`, `${page}#part`, `${page}\\tail`, `ftp://pixiv.net/artworks/${ID}`, `//pixiv.net/artworks/${ID}`, `pixiv.net/artworks/${ID}`, ID,
    `${'x'.repeat(64_001)} ${page}`]) assert.equal(parseAgentPixivReference(input), undefined, input.slice(0, 140))
  for (const value of [share('0'), share('01'), share('1'.repeat(13)), share(ID + '\n'), share('12.3'), share(ID, 'video'),
    { ...share(), url: page }, { provider: 'pixiv', reference: { ...share().reference, cookie: 'PRIVATE' } },
    Object.assign(Object.create({ inherited: true }), share())]) assert.throws(() => validateAgentMediaShare(value))
  let touched = false
  assert.throws(() => validateAgentMediaShare({ provider: 'pixiv', get reference() { touched = true; return share().reference } }))
  assert.equal(touched, false)
})

test('Pixiv rejects malformed queries and ambiguous legacy or path artwork identities', () => {
  for (const query of [`illust_id=${ID}&illust_id=${OTHER}`, `illust_id=${ID}&%69llust_id=${OTHER}`, `illust_id=${ID}&ILLUST_ID=${OTHER}`,
    `illust_id=${ID}&mode=medium&mode=medium`, `illust_id=${ID}&mode=big`, `ILLUST_ID=${ID}`, `illust_id=`, `illust_id=0${ID}`,
    `illust_id=%31${ID.slice(1)}`, `illust_id=${ID}&from=%ZZ`, `illust_id=${ID}&from=%`, `illust_id=${ID}&from=%E0%A4`,
    `illust_id=${ID}&from=%0A`, `illust_id=${ID}&from=%5C`, `illust_id=${ID}&&mode=medium`, `illust_id=${ID}&mode`,
    `illust_id=${ID}&=value`, `illust_id=${ID}&cookie=PRIVATE`, `illust_id=${ID}&access_token=PRIVATE`,
    `illust_id=${ID}&from=${'x'.repeat(2049)}`]) assert.equal(parseAgentPixivReference(`https://www.pixiv.net/member_illust.php?${query}`), undefined, query.slice(0, 120))
  for (const query of ['', `illust_id=${ID}`, `illust_id=${OTHER}`, 'from=%ZZ', 'cookie=PRIVATE']) {
    assert.equal(parseAgentPixivReference(`${page}?${query}`), undefined)
  }
  assert.equal(parseAgentPixivReference('https://pixiv.net/member_illust.php'), undefined)
})

test('Pixiv selects the first fully valid official artwork in text order', () => {
  const other = `https://pixiv.net/ja/artworks/${OTHER}`
  assert.deepEqual(parseAgentPixivReference(`前文 https://evil.test/artworks/${OTHER} ${page} ${other}`), share())
  assert.deepEqual(parseAgentPixivReference(`https://pixiv.net/member_illust.php?illust_id=${ID}&illust_id=${OTHER} ${other} ${page}`), share(OTHER))
  assert.deepEqual(parseAgentPixivReference(`看看（${other}），然后 ${page}`), share(OTHER))
})

test('prepared Pixiv pages allow only the same artwork and exact canonical URL without queries', () => {
  assert.equal(validateAgentMediaPreparedPageUrl(page, share()), page)
  for (const input of [`https://www.pixiv.net/artworks/${OTHER}`, page + '?from=share', page + '#', page + '/', page + '\n',
    `http://www.pixiv.net/artworks/${ID}`, `https://pixiv.net/artworks/${ID}`, `https://www.pixiv.net/en/artworks/${ID}`,
    `https://www.pixiv.net/member_illust.php?illust_id=${ID}`, 'https://www.youtube.com/watch?v=Ab_Cd-9xYz0',
    'https://www.xiaohongshu.com/explore/6ad4a9c200000000290162d4', 'https://www.douyin.com/video/7123456789012345678',
    'https://www.bilibili.com/video/BV1234567890']) assert.throws(() => validateAgentMediaPreparedPageUrl(input, share()), input)
  for (const original of [{ provider: 'bilibili', reference: { kind: 'video', id: 'BV1234567890' } },
    { provider: 'douyin', reference: { kind: 'video', id: '7123456789012345678' } },
    { provider: 'xiaohongshu', reference: { kind: 'note', id: '6ad4a9c200000000290162d4' } },
    { provider: 'youtube', reference: { kind: 'video', id: 'Ab_Cd-9xYz0' } }]) assert.throws(() => validateAgentMediaPreparedPageUrl(page, original))
})
