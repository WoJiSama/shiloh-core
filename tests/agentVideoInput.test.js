import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
const repo=fileURLToPath(new URL('../',import.meta.url)),release=path.resolve(process.env.BL_CHAT_AGENT_RELEASE_DIR||repo)
const {validateAgentVideoInput,validateAgentVideoInputBytes,MAX_AGENT_VIDEO_INPUT_BYTES}=await import(pathToFileURL(path.join(release,'dist/backend/modules/media/domain/agentVideoInput.js')).href)
const mp4=(brand='isom')=>{const bytes=Buffer.alloc(24);bytes.writeUInt32BE(24);bytes.write('ftyp',4);bytes.write(brand,8);bytes.write(brand,16);bytes.write('mp42',20);return bytes}
// Header/container fixtures only. They do not represent codec or playback acceptance.
const webm=Buffer.from([0x1a,0x45,0xdf,0xa3,0x87,0x42,0x82,0x84,0x77,0x65,0x62,0x6d,0x18,0x53,0x80,0x67,0x84,0x1f,0x43,0xb6,0x75])

test('video input makes a frozen owned canonical snapshot with a matching MP4 or WebM container header',()=>{
 for(const [mime,bytes]of [['video/mp4',mp4()],['video/webm',webm]]){
  const input={mime,base64:bytes.toString('base64')},owned=validateAgentVideoInput(input)
  assert.deepEqual(owned,input);assert.notEqual(owned,input);assert.equal(Object.isFrozen(owned),true)
  input.base64='mutated';assert.equal(owned.base64,bytes.toString('base64'))
  const copied=validateAgentVideoInputBytes(bytes);assert.equal(copied.mime,mime);const old=Buffer.from(bytes);bytes.fill(0);assert.equal(copied.base64,old.toString('base64'));old.copy(bytes)
 }
})

test('video inputs reject MIME lies, image/audio brands and malformed container headers',()=>{
 const malformed=mp4();malformed.writeUInt32BE(1000)
 const invalidWebm=Buffer.from(webm);invalidWebm.write('matr',8)
 const duplicateDoc=Buffer.concat([webm.subarray(0,5),webm.subarray(5,12),webm.subarray(5,12),webm.subarray(12)]);duplicateDoc[4]=0x8e
 for(const input of [{mime:'video/webm',base64:mp4().toString('base64')},{mime:'video/mp4',base64:webm.toString('base64')},...['qt  ','avif','heic'].map(brand=>({mime:'video/mp4',base64:mp4(brand).toString('base64')})),...[malformed,invalidWebm,duplicateDoc,webm.subarray(0,16),Buffer.from('not a video')].map(bytes=>({mime:'video/mp4',base64:bytes.toString('base64')}))])assert.throws(()=>validateAgentVideoInput(input))
 const noSegment=Buffer.from(webm);noSegment[12]=0;assert.throws(()=>validateAgentVideoInputBytes(noSegment))
 const highBitMp4=mp4();highBitMp4[4]|=128;assert.throws(()=>validateAgentVideoInputBytes(highBitMp4))
 const highBitWebm=Buffer.from(webm);highBitWebm[8]|=128;assert.throws(()=>validateAgentVideoInputBytes(highBitWebm))
 const unknownSegment=Buffer.from(webm);unknownSegment[16]=0xff;assert.equal(validateAgentVideoInputBytes(unknownSegment).mime,'video/webm')
})

test('closed byte input rejects arbitrary resource handles, getters and permissive base64 aliases',()=>{
 const good=mp4().toString('base64');let accessed=false
 const getter=Object.defineProperty({mime:'video/mp4'},'base64',{enumerable:true,get(){accessed=true;throw Error('PRIVATE_GETTER')}})
 const symbol={mime:'video/mp4',base64:good,[Symbol('hidden')]:'value'}
 for(const input of [null,[],{},'https://qq.example/private.mp4',{mime:'video/mp4',base64:good,url:'https://qq.example/private.mp4'},{mime:'video/mp4',base64:good,path:'/private/video.mp4'},getter,symbol,Object.create({mime:'video/mp4',base64:good}),{mime:'video/quicktime',base64:good},...['',good+'\n',good.slice(0,-1),'-'+good.slice(1),good+'====','data:video/mp4;base64,'+good].map(base64=>({mime:'video/mp4',base64}))])assert.throws(()=>validateAgentVideoInput(input),error=>!String(error).includes('PRIVATE_GETTER'))
 assert.equal(accessed,false)
 const padded=Buffer.concat([mp4(),Buffer.from([0])]).toString('base64'),alias=padded.slice(0,-3)+'B=='
 assert.notEqual(padded,alias);assert.throws(()=>validateAgentVideoInput({mime:'video/mp4',base64:alias}))
})

test('64 MiB is the exact owned input ceiling and over-budget bytes fail before encoding',()=>{
 assert.equal(MAX_AGENT_VIDEO_INPUT_BYTES,64*1024*1024)
 const bytes=Buffer.alloc(MAX_AGENT_VIDEO_INPUT_BYTES+1);mp4().copy(bytes)
 assert.throws(()=>validateAgentVideoInputBytes(bytes));assert.throws(()=>validateAgentVideoInput({mime:'video/mp4',base64:'A'.repeat(Math.ceil(MAX_AGENT_VIDEO_INPUT_BYTES/3)*4+4)}))
})
