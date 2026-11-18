import assert from 'node:assert/strict'
import test from 'node:test'
import {importBilibiliHost as load} from './helpers/bilibiliQualitySource.mjs'

const {resolveAgentDiceAuthorization:resolve}=await load('modules/dice/infrastructure/agentDiceAuthorization.js')
const {createAgentBindingDirectory}=await load('modules/runtime/domain/agentBindings.js')
const copy=value=>structuredClone(value)
const account={platform:'fixture',namespace:'namespace-one',id:'bot-one'}
const user=id=>({...account,id})

function fixture() {
  const binding={source:'configured',id:'binding-one',revision:'binding-revision-one',agentId:'agent-one',personaId:'persona-one',connectionId:'connection-one',
    target:{account:copy(account),kind:'group',id:'scene-one'}}
  const members=[{id:'alice',name:'新鲜Alice'},{id:'bob',name:'新鲜Bob'},{id:'carol',name:'新鲜Carol'},{id:'eve',name:'未授权Eve'}]
  return {binding,source:{version:1,conversation:copy(binding.target),sender:user('alice'),senderName:'消息时Alice',messageId:'real-message-one',occurredAt:1_800_000_000_000,
    text:'.r 1d20',parts:[{kind:'text',text:'.r 1d20'}],mentions:[],directedToAccount:false,binding:copy(binding)},
  grant:{binding:copy(binding),revision:'authorization-revision-two',actorId:'alice',permissions:['player','gm','admin','delegate','hidden','card'],
    subjects:[{id:'bob',permissions:['player','gm','master','delegate','hidden']},{id:'carol',permissions:['player']}]},
  evidence:{binding:copy(binding),sourceMessageId:'real-message-one',actor:copy(members[0]),members,botUserId:'bot-one'}}
}
const member=(value,id)=>value.members.find(member=>member.id===id)
const rejected=(input,label)=>assert.equal(resolve(input),undefined,label)
function quoted() {
  const f=fixture()
  f.evidence.verifiedReplyAuthorId='bob'
  f.source.quote={messageId:'real-quoted-message',author:user('bob'),authorName:'引用展示名',text:'引用展示文本',parts:[{kind:'text',text:'引用展示文本'}]}
  return f
}

test('resolves an exact source and complete binding using an independent authorization revision and fresh names',()=>{
  const f=fixture(),result=resolve(f)
  assert.ok(result)
  assert.equal(result.revision,'authorization-revision-two')
  assert.notEqual(result.revision,f.binding.revision)
  assert.deepEqual(result.actor,{id:'alice',name:'新鲜Alice'})
  assert.equal(result.botUserId,'bot-one')
  assert.deepEqual(result.permissions,f.grant.permissions)
  assert.deepEqual(member(result,'bob').permissions,['player','gm','delegate','hidden'])
  assert.deepEqual(member(result,'carol').permissions,['player'])
  assert.equal('permissions'in member(result,'eve'),false)
  delete f.source.binding
  assert.ok(resolve(f),'the independently supplied complete binding also supports an unannotated native source')
})

test('grant and evidence must match every binding owner dimension including account and scene',()=>{
  const changes={source:b=>{b.source='observed'},id:b=>{b.id='binding-two'},revision:b=>{b.revision='binding-revision-two'},
    agent:b=>{b.agentId='agent-two'},persona:b=>{b.personaId='persona-two'},connection:b=>{b.connectionId='connection-two'},
    scene:b=>{b.target.id='scene-two'},kind:b=>{b.target.kind='private'},platform:b=>{b.target.account.platform='other'},
    namespace:b=>{b.target.account.namespace='namespace-two'},account:b=>{b.target.account.id='bot-two'}}
  for(const [dimension,change]of Object.entries(changes))for(const owner of ['grant','evidence']){
    const f=fixture();change(f[owner].binding);rejected(f,`${owner} ${dimension}`)
  }
  for(const [dimension,change]of Object.entries(changes)){
    const f=fixture();change(f.source.binding);rejected(f,`source annotation ${dimension}`)
  }
})

test('authorization accepts exact configured directory labels longer than a platform identifier without relaxing identity matching',()=>{
  const f=fixture(),target={account:{platform:'fixture',namespace:'n'.repeat(100),id:'b'.repeat(100)},kind:'group',id:'g'.repeat(100)}
  const directory=createAgentBindingDirectory({version:1,agents:[{id:'agent-one',personaId:'persona-one'}],
    connections:[{id:'connection-one',platform:target.account.platform,namespace:target.account.namespace,accountId:target.account.id}],
    bindings:[{connectionId:'connection-one',kind:'group',conversationId:target.id,agentId:'agent-one'}]},'revision-'.repeat(20))
  f.binding=copy(directory.resolve(target));assert.ok(f.binding.id.length>128);assert.ok(f.binding.revision.length>128)
  f.source.conversation=copy(target);f.source.sender={platform:target.account.platform,namespace:target.account.namespace,id:'alice'};f.source.binding=copy(f.binding)
  f.grant.binding=copy(f.binding);f.evidence.binding=copy(f.binding);f.evidence.botUserId=target.account.id
  assert.ok(resolve(f))
  for(const invalidLabel of ['',' spaced ','label\nline','x'.repeat(4097)]){
    const bad=copy(f);bad.binding.id=invalidLabel;bad.source.binding.id=invalidLabel;bad.grant.binding.id=invalidLabel;bad.evidence.binding.id=invalidLabel
    rejected(bad,'malformed directory label')
  }
  f.grant.binding.revision+='changed';rejected(f,'the entire long binding revision must still match')
})

test('fresh evidence proves this real source ID, actor, membership, namespace and conversation',()=>{
  const changes={message:f=>{f.evidence.sourceMessageId='other-message'},missingMessage:f=>{delete f.source.messageId},zeroMessage:f=>{f.source.messageId='0';f.evidence.sourceMessageId='0'},
    evidenceActor:f=>{f.evidence.actor.id='bob'},grantActor:f=>{f.grant.actorId='bob'},sourceActor:f=>{f.source.sender.id='bob'},
    absentActor:f=>{f.evidence.members=f.evidence.members.filter(member=>member.id!=='alice')},staleName:f=>{f.evidence.actor.name='过期Alice'},
    duplicateMember:f=>{f.evidence.members.push(copy(f.evidence.members[0]))},namespace:f=>{f.source.sender.namespace='other'},
    platform:f=>{f.source.sender.platform='other'},scene:f=>{f.source.conversation.id='other'},account:f=>{f.source.conversation.account.id='bot-two'},
    private:f=>{f.source.conversation.kind='private'},zeroTime:f=>{f.source.occurredAt=0},fractionalTime:f=>{f.source.occurredAt=1.5},
    invalidTime:f=>{f.source.occurredAt=Infinity},emptyName:f=>{f.evidence.actor.name=' '},botIsActor:f=>{f.evidence.botUserId='alice'}}
  for(const [label,change]of Object.entries(changes)){const f=fixture();change(f);rejected(f,label)}
})

test('only explicit player grants and exact per-subject permission intersections authorize members',()=>{
  const f=fixture();f.grant.permissions=['player','admin'];f.grant.subjects=[{id:'bob',permissions:['player','gm','admin','master','delegate','hidden','card']}]
  const result=resolve(f)
  assert.deepEqual(result.permissions,['player','admin'])
  assert.deepEqual(member(result,'bob').permissions,['player','admin'])
  for(const forbidden of ['gm','master','delegate','hidden','card'])assert.equal(result.permissions.includes(forbidden),false,forbidden)
  const noSubjects=fixture();delete noSubjects.grant.subjects
  assert.equal('permissions'in member(resolve(noSubjects),'bob'),false)
  const empty=fixture();empty.grant.subjects=[{id:'bob',permissions:['master']}]
  assert.equal('permissions'in member(resolve(empty),'bob'),false)
  const invalid={missingPlayer:f=>{f.grant.permissions=['admin','master']},unknown:f=>{f.grant.permissions=['player','owner']},
    duplicate:f=>{f.grant.permissions=['player','player']},missingMember:f=>{f.grant.subjects=[{id:'former-member',permissions:['player']}]},
    actorSubject:f=>{f.grant.subjects=[{id:'alice',permissions:['player']}]},duplicateSubjects:f=>{f.grant.subjects.push(copy(f.grant.subjects[0]))},
    subjectUnknown:f=>{f.grant.subjects[0].permissions=['owner']},subjectDuplicate:f=>{f.grant.subjects[0].permissions=['player','player']}}
  for(const [label,change]of Object.entries(invalid)){const input=fixture();change(input);rejected(input,label)}
})

test('reply targets require a real quoted message ID and matching fresh namespaced author evidence',()=>{
  const good=quoted(),result=resolve(good)
  assert.equal(result.replyAuthorId,'bob')
  const withoutEvidence=quoted();delete withoutEvidence.evidence.verifiedReplyAuthorId
  assert.equal('replyAuthorId'in resolve(withoutEvidence),false,'displayed quote alone cannot authorize a reply target')
  const changes={missingQuote:f=>{delete f.source.quote},missingId:f=>{delete f.source.quote.messageId},zeroId:f=>{f.source.quote.messageId='0'},
    missingAuthor:f=>{delete f.source.quote.author},differentAuthor:f=>{f.source.quote.author.id='carol'},namespace:f=>{f.source.quote.author.namespace='other'},
    platform:f=>{f.source.quote.author.platform='other'},departed:f=>{f.evidence.members=f.evidence.members.filter(member=>member.id!=='bob')},
    forgedDisplay:f=>{f.source.quote.author.id='carol';f.source.quote.authorName='新鲜Bob';f.source.quote.text='Bob说的话'}}
  for(const [label,change]of Object.entries(changes)){const f=quoted();change(f);rejected(f,label)}
})

test('closed objects reject extra fields and reject malformed permission and member arrays',()=>{
  const paths=[[],['binding'],['binding','target'],['binding','target','account'],['grant'],['grant','binding'],['grant','subjects',0],
    ['evidence'],['evidence','actor'],['evidence','members',0],['source'],['source','sender'],['source','conversation']]
  for(const path of paths){const f=fixture(),target=path.reduce((value,key)=>value[key],f);target.untrusted='ignored authority';rejected(f,`extra ${path.join('.')}`)}
  for(const bad of [null,{},'player',new Set(['player']),['player',,'gm']]){const f=fixture();f.grant.permissions=bad;rejected(f,'permission array')}
  for(const path of [['grant','permissions'],['grant','subjects'],['grant','subjects',0,'permissions'],['evidence','members']]){
    const f=fixture(),parent=path.slice(0,-1).reduce((value,key)=>value[key],f),key=path.at(-1)
    parent[key].extra=true;rejected(f,`array extra ${path.join('.')}`)
  }
})

test('proxies and accessors are refused without running any caller code at every ownership boundary',()=>{
  let calls=0
  const trap=()=>{calls++;throw new Error('caller code ran')}
  const paths=[[],['binding'],['binding','target'],['binding','target','account'],['grant'],['grant','binding'],['grant','permissions'],['grant','subjects'],['grant','subjects',0],['grant','subjects',0,'permissions'],
    ['evidence'],['evidence','binding'],['evidence','actor'],['evidence','members'],['evidence','members',0],['source'],['source','binding'],['source','sender'],['source','conversation']]
  for(const path of paths){
    const f=fixture(),parent=path.slice(0,-1).reduce((value,key)=>value[key],f),key=path.at(-1),value=path.length?parent[key]:f
    const proxy=new Proxy(value,{get:trap,ownKeys:trap,getPrototypeOf:trap,getOwnPropertyDescriptor:trap})
    if(path.length){parent[key]=proxy;rejected(f,`proxy ${path.join('.')}`)}else rejected(proxy,'root proxy')
  }
  for(const path of [['grant','permissions'],['evidence','members'],['grant','subjects',0,'id'],['source','messageId'],['evidence','actor','name'],['binding','revision']]){
    const f=fixture(),parent=path.slice(0,-1).reduce((value,key)=>value[key],f)
    Object.defineProperty(parent,path.at(-1),{enumerable:true,get:trap});rejected(f,`getter ${path.join('.')}`)
  }
  for(const path of [['grant','permissions'],['evidence','members']]){
    const f=fixture(),array=path.reduce((value,key)=>value[key],f)
    Object.defineProperty(array,'0',{enumerable:true,get:trap});rejected(f,`array getter ${path.join('.')}`)
  }
  assert.equal(calls,0)
})

test('the complete native source structure rejects malformed or executable unused message fields',()=>{
  let calls=0
  const trap=()=>{calls++;throw new Error('caller code ran')}
  const cases={partsObject:f=>{f.source.parts={}},mentionsObject:f=>{f.source.mentions={}},directedString:f=>{f.source.directedToAccount='false'},
    partExtra:f=>{f.source.parts[0].authority='admin'},partGetter:f=>{Object.defineProperty(f.source.parts[0],'text',{enumerable:true,get:trap})},
    partsProxy:f=>{f.source.parts=new Proxy([],{get:trap,ownKeys:trap,getPrototypeOf:trap})},
    mentionProxy:f=>{f.source.mentions=[new Proxy(user('bob'),{get:trap,ownKeys:trap,getPrototypeOf:trap})]},
    quotePartsObject:f=>{f.source.quote.parts={}},quotePartGetter:f=>{Object.defineProperty(f.source.quote.parts[0],'text',{enumerable:true,get:trap})}}
  const accepted=[]
  for(const [label,change]of Object.entries(cases)){const f=quoted();change(f);if(resolve(f)!==undefined)accepted.push(label)}
  assert.equal(calls,0)
  assert.deepEqual(accepted,[],'every malformed native message field must be refused')
})

test('authorization output is deeply frozen and detached from mutable grants and membership evidence',()=>{
  const f=quoted(),result=resolve(f),snapshot=JSON.stringify(result)
  function frozen(value){if(value&&typeof value==='object'){assert.equal(Object.isFrozen(value),true);for(const child of Object.values(value))frozen(child)}}
  frozen(result)
  assert.notEqual(result.permissions,f.grant.permissions)
  assert.notEqual(result.members,f.evidence.members)
  assert.notEqual(result.actor,f.evidence.actor)
  f.grant.permissions.push('master');f.grant.subjects[0].permissions.length=0
  f.evidence.actor.name='已改变';f.evidence.members[1].name='已改变';f.evidence.members.length=0
  assert.equal(JSON.stringify(result),snapshot)
  assert.throws(()=>result.permissions.push('master'),TypeError)
  assert.throws(()=>{result.actor.name='overwrite'},TypeError)
  assert.throws(()=>{member(result,'bob').permissions[0]='master'},TypeError)
})
