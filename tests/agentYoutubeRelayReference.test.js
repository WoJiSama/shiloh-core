import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repo = fileURLToPath(new URL('../', import.meta.url)), release = path.resolve(process.env.BL_CHAT_AGENT_RELEASE_DIR || repo)
const load = name => import(pathToFileURL(path.join(release, 'dist/backend/modules/media/infrastructure', name)).href)
const { parseAgentYoutubeReference } = await load('agentYoutubeRelayReference.js')
const { validateAgentMediaShare, agentMediaSharePageUrl, validateAgentMediaPreparedPageUrl } = await load('agentMediaRelayReference.js')
const ID = 'Ab_Cd-9xYz0', OTHER = 'Zy_Xw-8vUt1', page = `https://www.youtube.com/watch?v=${ID}`
const share = (id = ID, kind = 'video') => ({ provider: 'youtube', reference: { kind, id } })

test('YouTube official watch, shorts, embed, live and short-host routes preserve the exact video ID', () => {
  for (const host of ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com']) {
    for (const route of [`/watch?v=${ID}&feature=share`, `/shorts/${ID}?si=public-tracking`, `/embed/${ID}`, `/live/${ID}?t=12`]) {
      for (const protocol of ['http', 'https']) assert.deepEqual(parseAgentYoutubeReference(`${protocol}://${host}${route}`), share())
    }
  }
  for (const input of [`https://youtu.be/${ID}`, `https://youtu.be/${ID}?si=public-tracking&t=12`,
    `http://youtu.be:80/${ID}`, `https://www.youtube.com:443/watch?v=${ID}`, `HTTPS://WWW.YOUTUBE.COM/watch?v=${ID}`,
    `https://www.youtube.com/watch?feature=share&v=${ID}`, `https://www.youtube.com/watch?%76=${ID}`,
    `${page}&list=PLPublicPlaylist&index=3&t=12&start=5`]) {
    assert.deepEqual(parseAgentYoutubeReference(input), share(), input)
  }
  const selected = validateAgentMediaShare(share())
  assert.deepEqual(selected, share()); assert.ok(Object.isFrozen(selected)); assert.ok(Object.isFrozen(selected.reference))
  assert.equal(agentMediaSharePageUrl(selected), page)
  assert.notEqual(agentMediaSharePageUrl(share(ID.toLowerCase())), page)
})

test('YouTube references reject deceptive authorities, invalid IDs, encoded paths and unsupported routes', () => {
  for (const input of [`https://www.youtube.com.evil.test/watch?v=${ID}`, `https://evil.test/https://youtu.be/${ID}`,
    `https://user@www.youtube.com/watch?v=${ID}`, `https://user:private@youtu.be/${ID}`, `https://www.youtube.com@evil.test/watch?v=${ID}`,
    `https://www.youtube.com:444/watch?v=${ID}`, `http://youtu.be:443/${ID}`, `https://youtu.be:80/${ID}`, `https://www.youtu.be/${ID}`,
    `https://youtu.be/${ID}/extra`, `https://youtu.be/${ID}/`, `https://www.youtube.com/shorts/${ID}/extra`,
    `https://www.youtube.com/%73horts/${ID}`, `https://www.youtube.com/a/../shorts/${ID}`, `https://www.youtube.com/embed/%41${ID.slice(1)}`,
    `https://www.youtube.com/channel/${ID}`, `https://www.youtube.com/watch/extra?v=${ID}`, `https://www.youtube.com/watch?V=${ID}`,
    `https://youtu.be/${ID.slice(0, 10)}`, `https://youtu.be/${ID}A`, `https://youtu.be/${ID.slice(0, 10)}!`,
    `https://youtu.be/${ID}#`, `https://youtu.be/${ID}#part`, `https://youtu.be/${ID}\\tail`,
    `ftp://youtu.be/${ID}`, `//youtu.be/${ID}`, `youtu.be/${ID}`, ID, `${'x'.repeat(64_001)} ${page}`]) {
    assert.equal(parseAgentYoutubeReference(input), undefined, input.slice(0, 140))
  }
  for (const invalid of [share(ID.slice(0, 10)), share(ID + 'A'), share(ID + '\n'), share('!'.repeat(11)), share(ID, 'short'),
    { ...share(), url: page }, { provider: 'youtube', reference: { kind: 'video', id: ID, cookie: 'PRIVATE' } },
    Object.assign(Object.create({ inherited: true }), share())]) assert.throws(() => validateAgentMediaShare(invalid))
  let touched = false
  assert.throws(() => validateAgentMediaShare({ provider: 'youtube', get reference() { touched = true; return share().reference } }))
  assert.equal(touched, false)
})

test('malformed or duplicate YouTube query identities never become valid candidates', () => {
  for (const query of [`v=${ID}&v=${OTHER}`, `v=${ID}&%76=${OTHER}`, `v=${ID}&V=${OTHER}`, `v=`,
    `v=${ID}&si=%ZZ`, `v=${ID}&si=%`, `v=${ID}&si=%E0%A4`, `v=${ID}&si=%0A`,
    `v=${ID}&si=%5C`, `v=%41${ID.slice(1)}`, `v=${ID}&&feature=share`, `v=${ID}&feature`, `v=${ID}&=value`,
    `v=${ID}&cookie=PRIVATE`, `v=${ID}&access_token=PRIVATE`, `v=${ID}&si=${'x'.repeat(2049)}`]) {
    assert.equal(parseAgentYoutubeReference(`https://www.youtube.com/watch?${query}`), undefined, query.slice(0, 100))
  }
  assert.equal(parseAgentYoutubeReference(`https://youtu.be/${ID}?`), undefined)
  assert.equal(parseAgentYoutubeReference(`https://youtu.be/${ID}?v=${ID}&v=${OTHER}`), undefined)
  assert.deepEqual(parseAgentYoutubeReference(`https://www.youtube.com/watch?v=${ID}&si=a%2520b`), share(), 'safe tracking is validated and then discarded')
})

test('YouTube selects the first fully valid official reference in text order', () => {
  const otherPage = `https://www.youtube.com/shorts/${OTHER}`
  assert.deepEqual(parseAgentYoutubeReference(`前文 https://evil.test/watch?v=${OTHER} ${page} ${otherPage}`), share())
  assert.deepEqual(parseAgentYoutubeReference(`https://www.youtube.com/watch?v=${OTHER}&v=${ID} ${otherPage} ${page}`), share(OTHER))
  assert.deepEqual(parseAgentYoutubeReference(`看看（https://youtu.be/${OTHER}），然后 ${page}`), share(OTHER))
})

test('prepared YouTube pages allow only the same video ID and the one canonical watch query', () => {
  assert.equal(validateAgentMediaPreparedPageUrl(page, share()), page)
  for (const input of [`https://www.youtube.com/watch?v=${OTHER}`, page + '&feature=share', page + '#', page + '\n',
    `http://www.youtube.com/watch?v=${ID}`, `https://youtube.com/watch?v=${ID}`, `https://youtu.be/${ID}`,
    `https://www.youtube.com/shorts/${ID}`, `https://www.youtube.com/watch?%76=${ID}`, page + '&v=' + ID,
    'https://www.xiaohongshu.com/explore/6ad4a9c200000000290162d4', 'https://www.douyin.com/video/7123456789012345678',
    'https://www.bilibili.com/video/BV1234567890']) assert.throws(() => validateAgentMediaPreparedPageUrl(input, share()), input)
  for (const original of [{ provider: 'bilibili', reference: { kind: 'video', id: 'BV1234567890' } },
    { provider: 'douyin', reference: { kind: 'video', id: '7123456789012345678' } },
    { provider: 'xiaohongshu', reference: { kind: 'note', id: '6ad4a9c200000000290162d4' } }]) {
    assert.throws(() => validateAgentMediaPreparedPageUrl(page, original))
  }
})
