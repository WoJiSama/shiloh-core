import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createDeliveryGatewayModule } from '../../src/modules/messaging/infrastructure/deliveryGateway.js'

test('typed gateway preserves successful message identity and marks unknown receipt uncertain', async () => {
 const root = { uin: 1, sendApi: async () => ({ retcode: 0, data: { message_id: 'receipt-1' } }) }
 const module = createDeliveryGatewayModule({ botRoot: () => root, logDeliveryOutcome() {}, isForwardResourceFailure: () => false })
 const gateway = new module.DeliveryGateway()
 assert.equal((await gateway.sendGroupText({ botId: 1, groupId: 2, text: 'hello' })).messageId, 'receipt-1')
 const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'typed-file-'))
 const file = path.join(dir, 'file.bin'); await fs.writeFile(file, 'content')
 let fallback = 0
 try {
  await assert.rejects(module.sendCompleteLocalFile({ group_id: 1, bot: { sendApi: async () => undefined }, group: { sendFile: async () => { fallback++; return { retcode: 0 } } } }, file), error => error instanceof module.DeliveryError && error.uncertain && !error.retryable)
  assert.equal(fallback, 0)
 } finally { await fs.rm(dir, { recursive: true, force: true }) }
})


test('queued deliveries never fall back from a missing account to the default bot', async () => {
 const sent:string[] = []
 const root = { uin: 1, bots: { '2': { sendApi: async () => { sent.push('2'); return {retcode:0,data:{message_id:'two'}} } } },
  sendApi: async () => { sent.push('1'); return {retcode:0,data:{message_id:'one'}} } }
 const module = createDeliveryGatewayModule({botRoot:()=>root,logDeliveryOutcome(){},isForwardResourceFailure:()=>false})
 const gateway = new module.DeliveryGateway()
 await assert.rejects(gateway.sendGroupText({botId:3,groupId:10,text:'fixture'}), /Bot 3/)
 await assert.rejects(gateway.sendGroupSegments({botId:3,groupId:10,segments:[]}), /Bot 3/)
 assert.deepEqual(sent, [])
 assert.equal((await gateway.sendGroupText({botId:1,groupId:10,text:'fixture'})).messageId, 'one')
 assert.equal((await gateway.sendGroupForward({botId:2,groupId:10,nodes:[]})).messageId, 'two')
 assert.deepEqual(sent, ['1','2'])
})
