import test from 'node:test'
import assert from 'node:assert/strict'
import { importBilibiliHost } from './helpers/bilibiliQualitySource.mjs'
const { isExplicitNoToolAction, isToolActionDenied, hasReminderActionIntent, hasRecallActionIntent, groupManagementActionClauses } = await importBilibiliHost('modules/conversation/domain/toolActionPolicy.js')
import {filterToolsForMessageIntent} from '../apps/lib/conversationUtils.js'
import {resolveDeterministicToolIntent} from '../utils/toolIntentManifests.js'
import {resolveNaturalDeltaForceToolCall} from '../utils/deltaForceIntent.js'

test('refusals, examples and quotations do not authorize fallback tool calls', () => {
  const tools=['reminderTool','githubRepoTool','deltaForceTool','searchInformationTool'].map(name=>({function:{name}}))
  for (const text of ['不用提醒我，我记得这件事。','只是讨论：到点为什么会弹出提示？','不要解析这个仓库 https://github.com/openai/openai-node ，我只是把地址发给你','这只是示例：看看 https://github.com/microsoft/TypeScript ，别真的查询','别查三角洲今日密码了，继续聊天','只是转述：三角洲H70现在多少钱。我没有让你去查']) {
    assert.equal(isExplicitNoToolAction(text),true,text)
    assert.deepEqual(filterToolsForMessageIntent(tools,{},text),[],text)
    assert.equal(resolveDeterministicToolIntent(text,tools.map(tool=>tool.function.name)),null,text)
    assert.equal(resolveNaturalDeltaForceToolCall(text),null,text)
  }
})

test('time words alone cannot expose a reminder action', () => {
  for (const text of ['我待会儿去吃饭','待会儿我自己处理，你不用做什么。']) {
    assert.equal(hasReminderActionIntent(text),false)
    assert.deepEqual(filterToolsForMessageIntent([{function:{name:'reminderTool'}}],{},text,{toolCandidates:['reminderTool']}),[])
  }
  for (const text of ['十分钟后提醒我喝水','别忘了提醒我喝水','到点叫我','查看我的提醒','取消提醒']) assert.equal(hasReminderActionIntent(text),true,text)
  assert.equal(isExplicitNoToolAction('不用查天气，不过帮我查询成员资料'),false)
})

test('mixed requests reach the planner while each denied capability stays unavailable', () => {
  const cases = [
    ['不用提醒我，查一下今天的天气','reminderTool','searchInformationTool'],
    ['查一下天气，别提醒我','reminderTool','searchInformationTool'],
    ['别查三角洲，给我放首周杰伦的歌','deltaForceTool','searchMusicTool'],
    ['不要查天气，十分钟后提醒我出门','searchInformationTool','reminderTool'],
    ['不要解析这个仓库 https://github.com/openai/openai-node，查询群成员资料','githubRepoTool','memberInfoTool'],
    ['别查成员资料，查一下他上次说什么','memberInfoTool','chatHistoryTool'],
    ['不要翻聊天记录，查询这位成员的信息','chatHistoryTool','memberInfoTool'],
    ['只是示例：查询三角洲今日密码，帮我查询今天的天气','deltaForceTool','searchInformationTool']
  ]
  for (const [text,denied,requested] of cases) {
    assert.equal(isExplicitNoToolAction(text),false,text)
    assert.equal(isToolActionDenied(text,denied),true,`${text}: denied ${denied}`)
    assert.equal(isToolActionDenied(text,requested),false,`${text}: requested ${requested}`)
    const tools=[denied,requested].map(name=>({function:{name}}))
    assert.deepEqual(filterToolsForMessageIntent(tools,{},text,{toolCandidates:[denied,requested]}).map(tool=>tool.function.name),[requested],text)
  }
  assert.equal(hasReminderActionIntent('不要查天气，十分钟后提醒我出门'),true)
})

test('quoted examples cannot authorize their tools while an independent request remains eligible', () => {
  const text='“十分钟后提醒我喝水”是个例子，查一下今天的天气'
  assert.equal(isExplicitNoToolAction(text),false)
  assert.equal(isToolActionDenied(text,'reminderTool'),true)
  assert.equal(isToolActionDenied(text,'searchInformationTool'),false)
  assert.equal(hasReminderActionIntent(text),false)
})

test('same-tool conflicts and unscoped prohibitions cannot be resolved by blindly authorizing a matching candidate', () => {
  const sameTool='别查北京天气，查一下上海天气'
  assert.equal(isExplicitNoToolAction(sameTool),false,'let the planner resolve or explain the conflict')
  assert.equal(isToolActionDenied(sameTool,'searchInformationTool'),true)
  const unresolved='不要调用任何工具，帮我查一下天气'
  assert.equal(isExplicitNoToolAction(unresolved),false)
  assert.equal(isToolActionDenied(unresolved,'searchInformationTool'),true)
})

test('reminder action detection covers requests without mistaking an incidental time phrase for consent', () => {
  for (const text of ['别忘了提醒我喝水','过五分钟喊我起来','到九点提醒一下交日报','晚上八点别让我忘记吃药','帮我设置一个今晚八点吃药的提醒','他说明天下午三点开会，帮我加个提醒']) {
    assert.equal(hasReminderActionIntent(text),true,text)
    assert.equal(isToolActionDenied(text,'reminderTool'),false,text)
  }
  for (const text of ['我待会儿去吃饭','朋友说十分钟后提醒我喝水','只是讨论：到点为什么会弹出提示？']) assert.equal(hasReminderActionIntent(text),false,text)
})

test('recall intent belongs to a positive current request and remains denied in mixed conflicts', () => {
  for (const text of ['撤回消息 out-42', '请把 out-42 撤回', '帮我收回刚才你发的那条', '不要点赞，撤回 out-42']) {
    assert.equal(hasRecallActionIntent(text), true, text); assert.equal(isToolActionDenied(text, 'recallTool'), false, text)
  }
  for (const text of ['不要撤回 out-42，请查天气', '不用收回 out-42，帮我查天气', '不要把 out-42 撤回，帮我查天气',
    '只是举例：撤回 out-42，查一下天气', '“撤回 out-42”是例子，请查天气', '先不撤回 out-42，撤回 out-42', '没有让你撤回 out-42，请查天气']) {
    assert.equal(hasRecallActionIntent(text), false, text); assert.equal(isToolActionDenied(text, 'recallTool'), true, text)
  }
  for (const text of ['他说撤回 out-42', '朋友说要收回 out-42', '这条消息刚才撤回了', '普通聊天']) assert.equal(hasRecallActionIntent(text), false, text)
})

test('group-management requests use their own positive clauses and handle unmute and nickname denials independently', () => {
  for (const text of ['禁言小明', '请解禁小明', '解除小明禁言', '把小明禁言一分钟', '确认开启全体禁言。', '随机禁言一位群友']) {
    assert.equal(groupManagementActionClauses(text, 'moderation').length, 1, text)
    assert.equal(isToolActionDenied(text, 'jinyanTool'), false, text)
  }
  for (const text of ['把小明名片改成小红', '帮我改小明昵称为新名', '清空我的名片', '把机器人的群名片改成小希']) {
    assert.equal(groupManagementActionClauses(text, 'card').length, 1, text)
    assert.equal(isToolActionDenied(text, 'changeCardTool'), false, text)
  }
  for (const [text, kind, toolName] of [['别解禁小明，请查天气', 'moderation', 'jinyanTool'],
    ['不要解除小明禁言，请查天气', 'moderation', 'jinyanTool'], ['别把小明解禁，请查天气', 'moderation', 'jinyanTool'],
    ['别改昵称，请查天气', 'card', 'changeCardTool'], ['不要把小明名片改成小红，请查天气', 'card', 'changeCardTool'],
    ['只是举例：禁言小明，请查天气', 'moderation', 'jinyanTool'], ['“把小明名片改成小红”是例子，请查天气', 'card', 'changeCardTool']]) {
    assert.deepEqual(groupManagementActionClauses(text, kind), [], text)
    assert.equal(isToolActionDenied(text, toolName), true, text)
    assert.equal(isToolActionDenied(text, 'searchInformationTool'), false, text)
  }
  for (const text of ['他说禁言小明', '朋友说解禁小明', '小明昨天被禁言了', '群主说把小明名片改成小红']) {
    assert.deepEqual(groupManagementActionClauses(text, 'moderation'), [], text)
    assert.deepEqual(groupManagementActionClauses(text, 'card'), [], text)
  }
  assert.deepEqual(groupManagementActionClauses('随机讲个笑话，禁言小明', 'moderation'), ['禁言小明'])
})
