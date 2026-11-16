import { detectAndPenalize as detect } from '../dist/backend/modules/memory/infrastructure/memorySelfCorrection.js'
export { DEFAULT_CORRECTION_PATTERNS, noteInjectedChunks, confirmMemoryReply, getInjectedChunks, isCorrectionText, __resetMemorySelfCorrectionForTest } from '../dist/backend/modules/memory/infrastructure/memorySelfCorrection.js'
export const detectAndPenalize = (options = {}) => detect({ logger:globalThis.logger, ...options })
