export const WEB_EVIDENCE_CLEANUP_PARTITION = 'public-web-evidence'

/** Host metadata from a static public-web response. An unavailable page retires its snapshot. */
export interface PublicWebRead {
  readonly requestedUrl: string
  readonly url: string
  readonly title: string
  readonly text: string
  /** Omitted when the response must not be retained. Zero permits historical use only. */
  readonly freshForMs?: number
}

export interface WebEvidenceQuestion {
  readonly messageId: string
  readonly authorId: string
  readonly at: number
  readonly text: string
}

export interface WebEvidenceRecall {
  readonly text: string
  isCurrent(): Promise<boolean>
}
