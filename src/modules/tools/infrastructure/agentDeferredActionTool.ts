import type {AgentTool,AgentToolContext} from '../../../contracts/agentTool.js'
import type {createAgentDeferredActionRuntime} from '../../runtime/infrastructure/agentDeferredActionRuntime.js'
import {formatCommitmentLine,parseOnceTime} from '../../commitments/domain/commitments.js'
import {authorizeAgentToolContext} from './agentToolAuthorization.js'
import {validateAgentToolInput} from './agentToolSchema.js'

/** Keep this in the human simulation registry; text mode keeps the static commitmentTool. */
export function createAgentDeferredActionTool(options:{
  runtime:ReturnType<typeof createAgentDeferredActionRuntime>
  /** Time from the verified original human message, not a model argument. */
  sourceAt(context:AgentToolContext):number
}):AgentTool {
  const tool:AgentTool = {
    name:'reminderTool',
    effect:{actor:'user',metadata:['request']},
    description:'登记一次性固定提醒及明确授权的附加工具动作。extra_action 参数在登记时冻结，到期只尝试一次，不会重新规划。只能使用宿主明确允许延期的工具；群文字仍用 commitmentTool 登记固定文字，私聊仅可查看和取消已接续提醒。',
    parameters:{type:'object',properties:{
      action:{type:'string',enum:['create','list','cancel']},
      reminder_time:{type:'string',description:'一次性排期，ISO 8601，含时区'},
      content:{type:'string',description:'用户原话中的提醒事项'},
      reminder_message:{type:'string',description:'到期发送的固定正文'},
      extra_action:{type:'object',properties:{tool:{type:'string'},params:{type:'object'}},required:['tool','params'],additionalProperties:false},
      reminder_id:{type:'string',description:'list返回的完整编号'},
    },required:['action'],additionalProperties:false},
    async execute(input,context){
      const creator=context.actor.user,request=context.request
      if(!validateAgentToolInput(tool,input))return {status:'failed',content:'延期提醒参数无效，未操作。'}
      if(!creator||!request||context.binding.source!=='configured'||!context.isCurrent()||context.signal.aborted||!authorizeAgentToolContext(tool,input,context))return {status:'failed',content:'延期提醒需要当前真人请求，未操作。'}
      await context.ensureCurrent?.()
      if(!context.isCurrent()||context.signal.aborted)return {status:'failed',content:'当前请求已失效，未操作。'}
      if(input.action==='list'){
        const records=await options.runtime.list(context.binding,creator)
        return {status:'succeeded',content:records.length?['你的延期提醒（unknown需核实，不自动补发）：',...records.map(task=>formatCommitmentLine(task,Date.now()))].join('\n'):'你目前没有延期提醒。'}
      }
      if(input.action==='cancel'){
        const id=typeof input.reminder_id==='string'?input.reminder_id:''
        if(!id)return {status:'failed',content:'请提供 list 中的完整 reminder_id。'}
        const cancelled=await options.runtime.cancel(id,context.binding,creator,()=>context.isCurrent()&&!context.signal.aborted)
        return {status:cancelled?'succeeded':'failed',content:cancelled?'已取消，后续不会继续执行；已经在途的动作需按实际结果核实。':'这条提醒不属于你、已结束或当前请求已失效。'}
      }
      if(input.action!=='create')return {status:'failed',content:'可用操作为 create、list、cancel。'}
      if(context.binding.target.kind!=='group')return {status:'failed',content:'私聊仅支持查看和取消已接续提醒。'}
      const extra=input.extra_action
      if(!extra||typeof extra!=='object'||Array.isArray(extra))return {status:'failed',content:'固定文字提醒请使用 commitmentTool；本工具需要明确的 extra_action。'}
      const action=extra as Record<string,unknown>,at=parseOnceTime(input.reminder_time)
      if(!at||typeof action.tool!=='string'||typeof input.content!=='string'||!input.content.trim())return {status:'failed',content:'需要明确的提醒时间、事项和附加工具。'}
      const message=typeof input.reminder_message==='string'&&input.reminder_message?input.reminder_message:`提醒你：${input.content}`
      const result=await options.runtime.create({binding:context.binding,creator,creatorName:creator.id,
        source:{kind:'message',messageId:request.messageId,at:options.sourceAt(context)},requestText:request.text,
        dueAt:at,content:input.content,message,tool:action.tool,params:action.params,signal:context.signal,isCurrent:context.isCurrent})
      if(result.code.startsWith('existing_'))return {status:'failed',content:`这条来源已有延期提醒，当前状态 ${result.code.slice(9)}，编号 ${result.id}。没有重新登记或重放；结果未知须先核实。`}
      return result.status==='succeeded'?{status:'succeeded',content:`延期提醒已登记，编号 ${result.id}。附加动作结果未知时会停止后续正文，需先核实。`}
        :{status:'failed',content:`延期提醒未登记（${result.code}）。当前规则没有授予的工具不能延期调用。`}
    },
  }
  return tool
}
