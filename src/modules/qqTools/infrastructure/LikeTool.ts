import type { QqToolEvent, QqToolBot, QqToolPorts } from '../../../contracts/qqTools.js'
import { apiOk, captureQqToolScope, errorText, QqToolBindingChanged, requireQqToolBot, type QqToolScope } from './qqToolRuntime.js'
import { AbstractTool } from '../../toolSupport/infrastructure/AbstractTool.js';
import { collectMentionTargetIds } from '../../conversation/domain/mentionTargets.js';

// LikeTool.js
export function createLikeTool(ports: QqToolPorts) {
class LikeTool extends AbstractTool {
  keywords: string[]; intent: string;
  constructor() {
    super();
    this.name = 'likeTool';
    this.description = '点赞工具';
    this.keywords = ['点赞', '赞', '给赞'];
    this.intent = '用户请求点赞相关的操作，包括给他人点赞或请求他人给自己点赞';
    this.parameters = {
      type: "object",
      required: [],
      properties: {
        qq: {
          type: 'string',
          description: '目标用户QQ号。留空则使用at或发送者QQ'
        },
        count: {
          type: 'number',
          description: '点赞次数(最多20次)',
          default: 10,
          minimum: 1,
          maximum: 20
        },
        random: {
          type: 'boolean',
          description: '是否随机选择成员点赞',
          default: false
        }
      }
    };
  }


  async func(opts:Record<string,unknown>,e:QqToolEvent) {
    const count=typeof opts.count==='number'&&Number.isFinite(opts.count)?Math.min(20,Math.max(1,Math.floor(opts.count))):10
    const random=opts.random===true
    try {
      const scope=captureQqToolScope(e),bot=requireQqToolBot(scope,ports)
      let target=String(opts.qq??'').trim()
      if(!target||random) {
        target=collectMentionTargetIds(e,bot.uin)[0]??''
        if(!target&&random) {
          if(!e.group_id)return {status:'error',error:'随机点赞仅支持群聊'}
          const group=await bot.pickGroup(e.group_id)
          const members=await scope.effect(()=>group.getMemberMap(),bot)
          const available=[...members.keys()].filter(id=>String(id)!==String(bot.uin)&&String(id)!==String(e.sender?.user_id??e.user_id))
          target=String(available[Math.floor(Math.random()*available.length)]??'')
        } else if(!target)target=String(e.sender?.user_id??e.user_id??'')
      }
      if(!/^\d+$/.test(target)||Number(target)<=0)return {status:'error',error:'没有可用的目标用户'}
      const result=await this.thumbUp(bot,Number(target),count,scope)
      return result.code===0?{status:'success',target,count,isRandom:random,message:result.msg}:{status:'error',target,error:result.msg}
    }catch(error){return {status:'error',error:errorText(error)}}
  }
  async thumbUp(bot:QqToolBot,uid:number,times=1,scope=captureQqToolScope({bot})){return this.origThumbUp(bot,uid,Math.min(20,Math.max(1,Math.floor(times))),scope)}
  async origThumbUp(bot:QqToolBot,uid:number,times:number,scope:QqToolScope=captureQqToolScope({bot})) {
    // Select a supported transport before sending, never retry after dispatch.
    try {
      scope.assertCurrent()
      const friend=bot.pickFriend?.(uid)
      const send=friend?.thumbUp?.bind(friend)
      const result=await scope.effect(()=>send ? send(times) : bot.sendApi('send_like',{user_id:uid,times}),bot)
      return apiOk(result)?{code:0,msg:'点赞成功'}:{code:1,msg:'点赞响应未确认成功，请勿重复执行'}
    }catch(error){return {code:1,msg:error instanceof QqToolBindingChanged ? error.message : `点赞结果未确认，请勿重复执行：${errorText(error)}`}}
  }
}
return {LikeTool}
}
