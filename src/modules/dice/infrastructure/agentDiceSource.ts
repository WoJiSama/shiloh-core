import {createHash} from 'node:crypto'
import {types} from 'node:util'
import type {IncomingMessage} from '../../../contracts/platformMessage.js'

type Json=null|boolean|number|string|readonly Json[]|{readonly [key:string]:Json}
const invalid=()=>new Error('骰子来源指纹无效')
function field(input:unknown,key:string):unknown {
  if(!input||typeof input!=='object'||types.isProxy(input)||Array.isArray(input)||![Object.prototype,null].includes(Object.getPrototypeOf(input)))throw invalid()
  const descriptor=Object.getOwnPropertyDescriptor(input,key)
  if(!descriptor||!('value'in descriptor)||!descriptor.enumerable)throw invalid()
  return descriptor.value
}
function closed(input:unknown,seen=new Set<object>(),depth=0):Json {
  if(depth>32)throw invalid()
  if(input===null||typeof input==='boolean'||typeof input==='string')return input
  if(typeof input==='number'&&Number.isFinite(input))return input
  if(!input||typeof input!=='object'||types.isProxy(input)||seen.has(input))throw invalid()
  const array=Array.isArray(input),prototype=Object.getPrototypeOf(input),keys=Reflect.ownKeys(input)
  if(array?prototype!==Array.prototype:prototype!==Object.prototype&&prototype!==null)throw invalid()
  if(keys.length>4096||keys.some(key=>typeof key!=='string'||['__proto__','prototype','constructor'].includes(key)))throw invalid()
  seen.add(input)
  try{
    if(array){
      if(keys.length!==input.length+1)throw invalid()
      const output:Json[]=[]
      for(let index=0;index<input.length;index++){
        const descriptor=Object.getOwnPropertyDescriptor(input,String(index))
        if(!descriptor||!('value'in descriptor)||!descriptor.enumerable)throw invalid()
        output.push(closed(descriptor.value,seen,depth+1))
      }
      return output
    }
    const output:Record<string,Json>={}
    for(const key of (keys as string[]).sort())output[key]=closed(field(input,key),seen,depth+1)
    return output
  }finally{seen.delete(input)}
}
/** Stable original-message identity. Display names and embedded quote content
 * never become authority. Adapters and the neutral bridge share this exact hash. */
export function agentDiceSourceFingerprint(message:IncomingMessage):string {
  const value:Record<string,Json>={}
  for(const key of ['messageId','conversation','sender','occurredAt','text','parts','mentions'])value[key]=closed(field(message,key))
  if(typeof value.messageId!=='string'||!value.messageId||value.messageId==='0'||typeof value.occurredAt!=='number'||!Number.isSafeInteger(value.occurredAt)||value.occurredAt<=0||typeof value.text!=='string'||!Array.isArray(value.parts)||!Array.isArray(value.mentions))throw invalid()
  const quoteDescriptor=Object.getOwnPropertyDescriptor(message,'quote')
  if(quoteDescriptor){
    if(!('value'in quoteDescriptor)||!quoteDescriptor.enumerable)throw invalid()
    const id=field(quoteDescriptor.value,'messageId')
    if(typeof id!=='string'||!id||id==='0')throw invalid()
    value.quoteMessageId=id
  }else value.quoteMessageId=null
  const encoded=JSON.stringify(closed(value))
  if(Buffer.byteLength(encoded)>1024*1024)throw invalid()
  return createHash('sha256').update(encoded).digest('hex')
}
