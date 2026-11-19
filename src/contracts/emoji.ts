export interface EmojiItem {hash:string;file:string;tags:string[];useCases:string[];description:string;embedding:number[]|null;usedCount:number;lastUsedAt:string|null;registeredAt:string;source?:string;isBanned:boolean;noFileFlag?:boolean}
export interface EmojiCriteria {query:string;tags:string[];useCases:string[]}
export interface EmojiCandidate {item:EmojiItem;score:number}
export interface EmojiSelection {item:EmojiItem|null;strategy:string;score?:number;criteria?:EmojiCriteria;familiarity?:number;firstUse?:boolean}
export interface EmojiAddOptions {source?:string;autoTag?:boolean;autoEmbed?:boolean}
export type EmojiAddResult={added:true;item:EmojiItem}|{added:false;reason:string;item?:EmojiItem;size?:number;width?:number;height?:number;ratio?:string;error?:string;filterReason?:string;confidence?:number;hitTags?:string[]}
export interface EmojiLogger {info?(message:string):void;warn?(message:string):void;error?(message:string):void}
/** Explicit host-owned settings avoid reading any plugin configuration. */
export interface EmojiStandaloneSettings {
  readonly rootDirectory: string
  readonly config: Readonly<Record<string, unknown>>
  readonly analysisAiConfig?: Readonly<Record<string, string>>
  readonly embeddingAiConfig?: Readonly<Record<string, string>>
  readonly toolsAiConfig?: Readonly<Record<string, string>>
}
/** Storage implementations retain the calling operation's authority across waits and commits. */
export interface EmojiStoragePort {
  ensureDirs(): Promise<void>
  loadItems(): Promise<EmojiItem[]>
  saveItems(items: readonly EmojiItem[]): Promise<void>
  writeImage(name: string, bytes: Buffer): Promise<void>
  removeImage(name: string): Promise<void>
  fileAvailable(name: string): boolean
  listImages(): Promise<readonly string[]>
  /** Explicit hosts can quarantine records from automatic repair, replacement and removal. */
  allowsMaintenance?(item: Readonly<EmojiItem>): boolean
}
export interface EmojiPorts {
  logger?:EmojiLogger|undefined
  fetch?:typeof fetch
  readonly standalone?: EmojiStandaloneSettings
  readonly storage?: EmojiStoragePort
  readonly ensureCurrent?: () => Promise<void>
  readonly assertCurrent?: () => void
}
export interface EmojiMaintenance {skipped?:boolean;markedMissing?:number;unmarkedRestored?:number;orphanRegistered?:number;cleanedUntagged?:number;prunedStale?:number;prunedHashes?:string[];total?:number}
export interface EmojiEvent {msg:string;reply(message:unknown):Promise<unknown>}
export interface EmojiPluginBase {}
export type EmojiPluginConstructor=new(options:Record<string,unknown>)=>EmojiPluginBase
export type EmojiHashResolution={ok:false;error:string}|{ok:true;results:({hash:string;item:EmojiItem|null;error?:undefined}|{hash:null;item:null;error:string})[]}
