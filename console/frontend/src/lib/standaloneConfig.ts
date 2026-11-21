export interface StandaloneModel {
  baseUrl: string
  name: string
  apiKeyEnv: string
  apiKeyConfigured: boolean
}
export interface StandaloneAiView {
  mode: 'standalone'
  processEpoch: string
  configRevision: string
  definitions: { configKey: string; title: string; fallbackConfigKey?: string; capabilities?: { probe?: boolean } }[]
  sections: Record<string, StandaloneModel[]>
  revisions: Record<string, string>
}
export interface StandaloneAssignmentView {
  mode: 'standalone'
  processEpoch: string
  configRevision: string
  revision: string
  agents: {
    agentId: string
    personaId: string
    targets: {
      connectionId: string
      scopeKey: string
      bindingToken: string
      target: {
        account: { platform: string; namespace: string; id: string }
        kind: string
        id: string
      }
    }[]
  }[]
  personas: { id: string; name: string }[]
}
export interface StandaloneLibraryView {
  mode: 'standalone'
  processEpoch: string
  configRevision: string
  revision: string
  personas: { id: string; name: string; [key: string]: any }[]
  defaultPersona: Record<string, any>
}
