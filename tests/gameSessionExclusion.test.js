import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {createUmaRaceManager} from '../dist/backend/modules/games/infrastructure/uma/UmaRaceManager.js'
import {TurtleSoupManager} from '../dist/backend/modules/games/infrastructure/turtleSoup/TurtleSoupManager.js'
import {claimGameGroup,releaseGameGroup} from '../dist/backend/modules/games/infrastructure/gameSessionRegistry.js'

function fixture(t) {
 const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'game-claim-'))
 const {UmaRaceManager}=createUmaRaceManager({sendSmartReply:async()=>{}})
 const uma=new UmaRaceManager({cwd})
 const soup=new TurtleSoupManager({cwd,sendSmartReply:async()=>{},host:{},generator:{ensureFreshPool:async()=>({added:0,failed:0})}})
 t.after(()=>{for(const groupId of [...uma.rooms.keys()])uma.cancelRace({group_id:groupId,isMaster:true});soup.stop();fs.rmSync(cwd,{recursive:true,force:true})})
 const event={group_id:'200001',user_id:'10001',msg:'.赛马娘 领养 alpha calm'}
 return {cwd,uma,soup,event}
}

test('all game entry paths claim one group atomically and release it on cancellation',async t=>{
 const {uma,soup,event}=fixture(t)
 await uma.adoptUma(event)
 assert.match(await soup.openGame(event),/报名开始/)
 assert.match(await uma.startRace(event),/海龟汤/)
 assert.match(await uma.joinRace(event),/海龟汤/)
 assert.equal(uma.rooms.size,0)
 await soup.cancelGame(event)
 assert.match(await uma.joinRace(event),/报名|加入|自动|参赛|选择/)
 assert.equal(uma.rooms.size,1)
 assert.match(await soup.openGame(event),/赛马娘/)
 uma.cancelRace(event)
 assert.match(await soup.openGame(event),/报名开始/)
})

test('concurrent cross-game starts produce only one occupied session',async t=>{
 const {uma,soup,event}=fixture(t)
 await uma.adoptUma(event)
 await Promise.all([soup.openGame(event),uma.startRace(event)])
 assert.equal(Number(!!soup.getSession(String(event.group_id)))+Number(uma.rooms.has(String(event.group_id))),1)
})

test('restored soup sessions retain their claim and failed persistence releases new claims',async t=>{
 const {cwd,uma,soup,event}=fixture(t)
 await uma.adoptUma(event)
 await soup.openGame(event)
 soup.stop()
 const restored=new TurtleSoupManager(soup.ports)
 t.after(()=>restored.stop())
 assert.match(await uma.joinRace(event),/海龟汤/)
 await restored.cancelGame(event)
 const badGroup='200002',save=restored.store.saveSession.bind(restored.store)
 restored.store.saveSession=async()=>{throw Error('fixture disk failed')}
 await assert.rejects(restored.openGame({...event,group_id:badGroup}),/fixture disk failed/)
 const owner={}
 assert.equal(claimGameGroup(badGroup,'uma',owner,cwd),true)
 releaseGameGroup(badGroup,owner,cwd)
 restored.store.saveSession=save
})

test('cancelling while an async join is pending cannot recreate the old room',async t=>{
 const {uma,event}=fixture(t)
 await uma.adoptUma(event)
 let release
 const gate=new Promise(resolve=>release=resolve)
 const original=uma.ensurePlayerUmaTrait.bind(uma)
 uma.ensurePlayerUmaTrait=async(...args)=>{await gate;return original(...args)}
 const opening=uma.startRace(event)
 assert.equal(uma.rooms.size,1)
 uma.cancelRace(event)
 release()
 assert.match(await opening,/结束|取消/)
 assert.equal(uma.rooms.size,0)
})

test('restoration conflict rolls back earlier group claims',async t=>{
 const {cwd,soup,event}=fixture(t)
 await soup.openGame(event)
 await soup.openGame({...event,group_id:'200002'})
 soup.stop()
 const blocker={},probe={}
 assert.equal(claimGameGroup('200002','uma',blocker,cwd),true)
 t.after(()=>{releaseGameGroup('200002',blocker,cwd);releaseGameGroup('200001',probe,cwd)})
 assert.throws(()=>new TurtleSoupManager(soup.ports),/已有其他游戏运行/)
 assert.equal(claimGameGroup('200001','uma',probe,cwd),true)
 assert.equal(claimGameGroup('200002','uma',probe,cwd),false)
})

test('failed restart rolls back newly reacquired claims',async t=>{
 const {cwd,soup,event}=fixture(t)
 await soup.openGame(event)
 await soup.openGame({...event,group_id:'200002'})
 soup.stop()
 const blocker={},probe={}
 assert.equal(claimGameGroup('200002','uma',blocker,cwd),true)
 t.after(()=>{releaseGameGroup('200002',blocker,cwd);releaseGameGroup('200001',probe,cwd)})
 assert.throws(()=>soup.start(),/已有其他游戏运行/)
 assert.equal(claimGameGroup('200001','uma',probe,cwd),true)
 assert.equal(claimGameGroup('200002','uma',probe,cwd),false)
})

test('failed group reacquisition preserves claims already held by the manager',async t=>{
 const {cwd,soup,event}=fixture(t)
 await soup.openGame(event)
 await soup.openGame({...event,group_id:'200002'})
 const blocker={},probe={}
 releaseGameGroup('200002',soup,cwd)
 assert.equal(claimGameGroup('200002','uma',blocker,cwd),true)
 t.after(()=>releaseGameGroup('200002',blocker,cwd))
 assert.throws(()=>soup.start(),/已有其他游戏运行/)
 assert.equal(claimGameGroup('200001','uma',probe,cwd),false)
 assert.equal(claimGameGroup('200002','uma',probe,cwd),false)
})

test('failed persistence keeps active claims but releases claims after a revealed session',async t=>{
 const {cwd,soup,event}=fixture(t)
 await soup.openGame(event)
 const save=soup.store.saveSession.bind(soup.store)
 soup.store.saveSession=async()=>{throw Error('fixture disk failed')}
 const probe={}
 t.after(()=>releaseGameGroup(String(event.group_id),probe,cwd))
 await assert.rejects(soup.joinGame({...event,user_id:'10002'}),/fixture disk failed/)
 assert.equal(claimGameGroup(String(event.group_id),'uma',probe,cwd),false)
 soup.store.saveSession=save
 const revealed={...soup.getSession(String(event.group_id)),phase:'reveal'}
 await soup.persist(revealed)
 soup.store.saveSession=async()=>{throw Error('fixture disk failed')}
 await assert.rejects(soup.persist({...revealed,phase:'joining'}),/fixture disk failed/)
 assert.equal(claimGameGroup(String(event.group_id),'uma',probe,cwd),true)
})

for (const transition of ['reopen','switch']) test(`failed soup ${transition} leaves no group claim`,async t=>{
 const {cwd,soup,event}=fixture(t)
 await soup.store.savePuzzle({id:'p1',title:'灯光',surface:'灯为什么亮着？',solution:'有人开灯',keyPoints:['开灯'],hints:['看开关'],difficulty:'normal',tags:[],source:'manual',createdAt:1,status:'active',ratingSum:0,ratingCount:0})
 await soup.openGame(event)
 await soup.startGame(event)
 assert.equal(soup.getSession(String(event.group_id)).phase,'playing')
 if(transition==='reopen')await soup.endGame(event)
 soup.store.saveSession=async()=>{throw Error('fixture disk failed')}
 await assert.rejects(transition==='reopen'?soup.openGame(event):soup.switchPuzzle(event),/fixture disk failed/)
 assert.equal(soup.getSession(String(event.group_id)),undefined)
 const probe={}
 t.after(()=>releaseGameGroup(String(event.group_id),probe,cwd))
 assert.equal(claimGameGroup(String(event.group_id),'uma',probe,cwd),true)
})
