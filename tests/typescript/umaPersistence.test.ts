import {test} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {createUmaRaceManager} from '../../src/modules/games/infrastructure/uma/UmaRaceManager.js'
import {decodeUmaPoints} from '../../src/modules/games/infrastructure/uma/umaState.js'
test('Uma persistence preserves training and personality fields and rejects corrupt players',()=>{
 const fixture={players:{'1':{userId:'1',nickname:'user',points:25,wins:1,races:2,podiums:2,trainingPity:{basic:{speed:3}},uma:{name:'horse',personality:'calm',attributes:{speed:8},total:40,createdAt:'today',trait:{key:'calm',label:'calm',description:'calm',fit:{normal:4},tagFit:{corner:3},riskAdjust:0.04,luckBonus:2},proficiency:{steady:10}}}}}
 const value=decodeUmaPoints(fixture).players['1']!
 assert.equal(value.podiums,2);assert.equal(value.uma?.createdAt,'today');assert.deepEqual(value.uma?.trait?.fit,{normal:4});assert.equal(value.uma?.trait?.luckBonus,2);assert.equal(value.trainingPity?.basic?.speed,3)
 for(const invalid of [{players:[]},{players:{a:{}}},{players:{a:null}}])assert.throws(()=>decodeUmaPoints(invalid))
})
test('Uma damaged points fail closed and failed writes do not poison subsequent writes',async t=>{
 const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'uma-state-'));t.after(()=>fs.rmSync(cwd,{recursive:true,force:true}))
 const {UmaRaceManager}=createUmaRaceManager({sendSmartReply:async()=>{}}),manager=new UmaRaceManager({cwd})
 const config={...manager.getConfig(),baseDir:path.join(cwd,'state')}
 fs.mkdirSync(config.baseDir);fs.writeFileSync(manager.getPointsPath(config),'broken')
 assert.throws(()=>manager.readPoints(config),/停止写入/);assert.equal(fs.readFileSync(manager.getPointsPath(config),'utf8'),'broken')
 const bad=path.join(cwd,'file');fs.writeFileSync(bad,'not a directory')
 await assert.rejects(manager.writePoints({players:{}},{...config,baseDir:bad}))
 await manager.writePoints({players:{}},config)
 assert.deepEqual(manager.readPoints(config),{players:{}})
})

test('Uma mutations serialize complete snapshots across managers and groups', async t => {
 const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'uma-concurrent-'));t.after(()=>fs.rmSync(cwd,{recursive:true,force:true}))
 const {UmaRaceManager}=createUmaRaceManager({sendSmartReply:async()=>{}})
 const first=new UmaRaceManager({cwd}),second=new UmaRaceManager({cwd})
 const adopted=await Promise.all([
  first.adoptUma({user_id:'10001',group_id:'200001',msg:'.赛马娘 领养 alpha calm'}),
  second.adoptUma({user_id:'10002',group_id:'200002',msg:'.赛马娘 领养 beta brave'})
 ])
 assert.ok(adopted.every(message=>message.startsWith('领养成功')))
 assert.deepEqual(Object.keys(first.readPoints().players).sort(),['10001','10002'])
 await Promise.all(Array.from({length:12},(_,index)=>(index%2?first:second).adjustScore({isMaster:true,msg:'.赛马娘 加积分 10001 1'})))
 const players=first.readPoints().players
 assert.equal(players['10001']?.points,12)
 assert.equal(players['10002']?.uma?.name,'beta')
 const failed=first.adjustScore({isMaster:true,msg:'.赛马娘 加积分 10001 1'})
 await failed
 assert.equal(first.readPoints().players['10001']?.points,13)
})

test('Uma point updates remain atomic across independent Node processes', async t => {
 const {spawn}=await import('node:child_process')
 const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'uma-processes-'));t.after(()=>fs.rmSync(cwd,{recursive:true,force:true}))
 const moduleUrl=new URL('../../src/modules/games/infrastructure/uma/UmaRaceManager.js',import.meta.url).href
 const script=`import {createUmaRaceManager} from ${JSON.stringify(moduleUrl)};const {UmaRaceManager}=createUmaRaceManager({sendSmartReply:async()=>{}});const manager=new UmaRaceManager({cwd:${JSON.stringify(cwd)}});await Promise.all(Array.from({length:5},()=>manager.adjustScore({isMaster:true,msg:'.赛马娘 加积分 10001 1'})));`
 await Promise.all(Array.from({length:3},()=>new Promise<void>((resolve,reject)=>{
  const child=spawn(process.execPath,['--input-type=module','-e',script],{stdio:['ignore','pipe','pipe']})
  let errors='';child.stderr.on('data',chunk=>errors+=chunk)
  child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error(errors||`child exited ${code}`)))
 })))
 const {UmaRaceManager}=createUmaRaceManager({sendSmartReply:async()=>{}})
 assert.equal(new UmaRaceManager({cwd}).readPoints().players['10001']?.points,15)
})
