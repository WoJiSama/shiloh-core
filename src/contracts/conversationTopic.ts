/** Temporary same-scene evidence. The host must revalidate it before use or delivery. */
export interface ConversationTopicRecall {
  readonly text: string
  readonly messageIds: readonly string[]
  isCurrent(): Promise<boolean>
}

export interface ConversationTopicCommitment {
  readonly id: string
  readonly authorId: string
  readonly sourceId: string
  readonly intent: string
  readonly status: string
  readonly due: number
}
