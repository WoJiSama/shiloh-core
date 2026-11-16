import assert from 'node:assert/strict'
import fs from 'node:fs'
import ts from 'typescript'
import { formatSimulationDelivery } from '../../dist/backend/modules/simulation/domain/messageDelivery.js'
import { createQqMessageActionPort } from '../../dist/backend/adapters/qqMessageDelivery.js'
import { encodeQqLegacyParts } from '../../dist/backend/adapters/qqMessage.js'

/** Execute the actual host assembly's sender without importing unrelated singleton services. */
function initializerFor(propertyName) {
  const file = new URL('../../utils/simulationRuntime.js', import.meta.url)
  const source = ts.createSourceFile(file.pathname, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  let initializer
  const visit = node => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'simulationRuntime' && node.initializer && ts.isCallExpression(node.initializer)) {
      const object = node.initializer.arguments[0]
      assert.ok(object && ts.isObjectLiteralExpression(object))
      initializer = object.properties.find(property => ts.isPropertyAssignment(property) && property.name.getText(source) === propertyName)?.initializer
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  assert.ok(initializer, `production runtime assembly must expose ${propertyName}`)
  return initializer.getText(source)
}

export function hostSimulationSender({ settings = () => ({}), bot }) {
  const account = selfId => {
    const client = bot(selfId)
    return client && {uin:selfId, ...client}
  }
  return new Function('readPluginSettings', 'scopedBot', 'formatSimulationDelivery', 'createQqMessageActionPort', 'encodeQqLegacyParts', `return (${initializerFor('sendGroupMessage')})`)(
    settings, account, formatSimulationDelivery, createQqMessageActionPort, encodeQqLegacyParts,
  )
}

export function hostSimulationActions(getBotRoot) {
  return new Function('globalThis', 'createQqMessageActionPort', `return (${initializerFor('messageActions')})`)(
    {get Bot() { return getBotRoot() }}, createQqMessageActionPort,
  )
}

export function hostSimulationModel(YTapi, { property = 'YTapi', resolveCharacterConsistencyRoute } = {}) {
  return new Function('YTapi', 'resolveCharacterConsistencyRoute', `return (${initializerFor(property)})`)(YTapi, resolveCharacterConsistencyRoute)
}
