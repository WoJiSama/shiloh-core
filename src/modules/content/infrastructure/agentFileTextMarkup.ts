import { AgentFileTextError } from './agentFileTextTypes.js'

/** Inert HTML/XHTML document declarations only. No internal subsets, entities, or resource loading. */
export function stripFileTextHtmlDoctype(input: string): string {
  if (/<!\s*ENTITY/iu.test(input)) throw new AgentFileTextError()
  return input.replace(/<!DOCTYPE[\s\S]*?>/giu, declaration => {
    if (declaration.length > 1024 || /[\[\]]/u.test(declaration) ||
        !/^<!DOCTYPE\s+html(?:\s+(?:PUBLIC\s+(?:"-\/\/W3C\/\/DTD [^"<>]*\/\/EN"|'-\/\/W3C\/\/DTD [^'<>]*\/\/EN')\s+(?:"https?:\/\/www\.w3\.org\/[^"<>]+\.dtd"|'https?:\/\/www\.w3\.org\/[^'<>]+\.dtd')|SYSTEM\s+(?:"https?:\/\/www\.w3\.org\/[^"<>]+\.dtd"|'https?:\/\/www\.w3\.org\/[^'<>]+\.dtd')))?\s*>$/iu.test(declaration)) throw new AgentFileTextError()
    return ''
  })
}
