import test from "node:test"
import assert from "node:assert/strict"
import { decideToolContinuation } from "../utils/toolContinuationPolicy.js"

test("returns exact Excel results directly", () => {
  assert.equal(decideToolContinuation([{ toolName: "excelWorkbookTool" }]), "direct_result")
})

test("returns exact group-knowledge deletion results directly", () => {
  assert.equal(decideToolContinuation([{ toolName: "forgetGroupKnowledgeTool" }]), "direct_result")
})

test("routes synthetic tool calls to chat-only summary instead of a thinking tool continuation", () => {
  assert.equal(
    decideToolContinuation([{ toolName: "googleImageAnalysisTool" }], { syntheticToolCall: true }),
    "chat_only"
  )
})

test("keeps provider-native tool calls in the normal tool loop", () => {
  assert.equal(decideToolContinuation([{ toolName: "searchInformationTool" }]), "tool_loop")
})

test("structured failure cannot take the direct-success path", () => {
  assert.equal(decideToolContinuation([{toolName:'memberInfoTool',result:JSON.stringify({success:false,message:'暂不可用'})}]),'tool_loop')
  assert.equal(decideToolContinuation([{toolName:'memberInfoTool',result:JSON.stringify({success:true,data:{nickname:'失败乃成功之母'}})}]),'direct_result')
})
