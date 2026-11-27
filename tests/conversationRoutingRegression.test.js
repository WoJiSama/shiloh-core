import { test } from "node:test"
import { readPluginSources, readSource } from "./helpers/pluginSources.js"
import assert from "node:assert/strict"
import ts from "typescript"
import { createTurnPlan, deriveTurnPlanRequest } from "../dist/backend/modules/conversation/infrastructure/turnPlan.js"
import { buildChatRequestData } from "../dist/backend/modules/models/domain/modelGateway.js"

const source = readPluginSources()

test("ordinary casual emoji replies retain the optional tool for model selection", () => {
  const emoji = { type: "function", function: { name: "sendLocalEmojiTool", parameters: { type: "object", properties: {} } } }
  const plan = createTurnPlan({ intentText: "哈哈", availableCapabilities: [emoji.function.name] })
  assert.deepEqual(plan.capabilities.required, [])
  assert.deepEqual(plan.capabilities.optional, [emoji.function.name])
  assert.equal(plan.execution.mode, "tool")
  const request = buildChatRequestData({ useTools: true }, [{ role: "user", content: "哈哈" }], [emoji], deriveTurnPlanRequest(plan).toolChoice)
  assert.deepEqual(request.tools, [emoji])
  assert.equal(request.tool_choice, "auto", "the model can choose either the admitted reaction or ordinary text")
})

test("knowledge replies use TurnPlan instead of optional emoji capability routing", () => {
  const emoji = { type: "function", function: { name: "sendLocalEmojiTool", parameters: { type: "object", properties: {} } } }
  const plan = createTurnPlan({ responseKind: "knowledge", intentText: "解释什么是比热容", availableCapabilities: [emoji.function.name], requiredCapabilities: [emoji.function.name] })
  assert.deepEqual(plan.capabilities.required, [], "an optional emoji candidate cannot turn a knowledge answer into a required action")
  assert.equal(plan.execution.mode, "chat")
  assert.equal(plan.presentation.kind, "knowledge")
  const request = buildChatRequestData({ useTools: true }, [{ role: "user", content: "解释什么是比热容" }], [emoji], deriveTurnPlanRequest(plan).toolChoice)
  assert.equal(request.tools, undefined)
  assert.equal(request.tool_choice, undefined)
})

test("card replies acknowledge before generation and keep the card body free of process text", () => {
  const composerSrc = readSource("utils/turnPromptComposer.js")
  assert.match(source, /session\.cardPresentation = resolveCardPresentation/)
  assert.match(source, /const cardRequestText = \[args, msg, userContent\]/)
  assert.doesNotMatch(source, /isEducationalExplanationRequest\(currentIntentText\) \? "knowledge" : "chat"\n\s*\)\n\s*\? \[/)
  assert.match(source, /承诺类确认已入队/)
  assert.match(composerSrc, /卡面正文边界/)
  assert.match(source, /已剥离模型开场/)
  const acknowledgement = source.indexOf("const acknowledgement = cardAcknowledgement")
  const request = source.indexOf("const requestData = buildChatRequestData(host.config,", acknowledgement)
  assert.ok(acknowledgement > 0 && request > acknowledgement)
})

test("committed memory actions override later generic chat failures", () => {
  assert.match(source, /recordActionOutcomes\(session, "group_knowledge", savedKnowledgeEntries\)/)
  assert.match(source, /const committedReply = buildCommittedActionReply\(context\?\.session\)/)
})

test("proactive freshness is anchored to the source message and checked before sending", () => {
  assert.match(source, /e\._incomingMessageAt = incomingAt/)
  assert.match(source, /markProactiveReply\(e, e\?\._incomingMessageAt/)
  const freshness = source.indexOf("shouldCancelProactiveReply(e")
  const sanitize = source.indexOf("sanitizeFinalReplyText(output)", freshness)
  assert.ok(freshness > 0 && sanitize > freshness)
})

test("all direct replies in the main agent use one observed delivery method", () => {
  const parsed = ts.createSourceFile("plugin.ts", source, ts.ScriptTarget.Latest, true)
  const deliveryMethods = []
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "e" && node.expression.name.text === "reply") {
      let scope = node.parent
      while (scope && !ts.isFunctionDeclaration(scope) && !ts.isMethodDeclaration(scope)) scope = scope.parent
      deliveryMethods.push(scope?.name?.getText(parsed))
    }
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  assert.deepEqual(deliveryMethods, ["sendObservedReply"])
})
