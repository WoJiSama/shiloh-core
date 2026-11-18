import {
  Sparkles,
  IdCard,
  AlarmClock,
  MessageCircle,
  Bot,
  Users,
  Gamepad2,
  Drama,
  BrainCircuit,
  Workflow,
  ShieldCheck,
  UserRoundCog,
  Terminal,
  Activity,
  Database,
  ImagePlus,
  Waves,
  Coins,
  ScrollText
} from 'lucide-vue-next'
export const navigation = [
  {
    label: '日常运营',
    items: [
      { path: '/', label: '机器人', icon: Bot, hint: '账号与运行状态' },
      { path: '/groups', label: '群聊', icon: Users, hint: '服务群与收发统计' },
      { path: '/group-admin', label: '群管理', icon: UserRoundCog, hint: '入群验证、广告与群通知' }
    ]
  },
  {
    label: '机器人能力',
    items: [
      {
        path: '/conversation',
        label: '对话设置',
        icon: MessageCircle,
        hint: '触发、权限与回复方式'
      },
      { path: '/persona', label: '人设与绑定', icon: Drama, hint: '人设库与身份分配' },
      { path: '/ai', label: 'AI 模型', icon: BrainCircuit, hint: '渠道与模型配置' },
      { path: '/commands', label: '命令 / 骰子', icon: Terminal, hint: '命令与规则管理' },
      { path: '/semantic', label: '语义记忆', icon: Database, hint: '长期记忆与召回' },
      { path: '/simulation', label: '自主仿真', icon: Waves, hint: 'AI 自主收发与唤醒管理' },
      { path: '/person-profiles', label: '人物记忆', icon: IdCard, hint: '跨群档案与全局好感' },
      { path: '/trusteeship', label: '托付数据', icon: ScrollText, hint: '定时承诺与委托记忆' },
      { path: '/life', label: '作息与生活', icon: AlarmClock, hint: '生物钟与追番动态' },
      { path: '/games', label: '游戏', icon: Gamepad2, hint: '海龟汤题库审核与游戏参数' }
    ]
  },
  {
    label: '消息与运行',
    items: [
      { path: '/pipeline', label: '消息与搬运', icon: Workflow, hint: '可靠管道与平台授权' },
      { path: '/risk', label: '风控策略', icon: ShieldCheck, hint: '审查、限流与通知' },
      { path: '/observe', label: '运行观测', icon: Activity, hint: '请求轨迹与失败原因' },
      { path: '/tokens', label: '令牌与花费', icon: Coins, hint: '模型用量与金额' },
      { path: '/style', label: '风格学习', icon: Sparkles, hint: '学到的表达策略与修剪' }
    ]
  },
  {
    label: '创作工具',
    items: [{ path: '/draw', label: '生图工作台', icon: ImagePlus, hint: '文生图与图生图' }]
  }
]
export const pages = navigation.flatMap((group) =>
  group.items.map((item) => ({ ...item, group: group.label }))
)

// The plugin adapter retains its existing navigation above. Standalone navigation follows the robot's identity.
export const workspaceNavigation = [
  { path: '/', label: '总览', icon: Activity, hint: '本人、连接与待处理事项' },
  { path: '/robots', label: '机器人', icon: Bot, hint: '本人、会话、自我与行动' },
  { path: '/connections', label: '连接', icon: Workflow, hint: '平台账号与会话接入' },
  { path: '/resources', label: '资源库', icon: Database, hint: '人设、模型与创作资源' },
  { path: '/runtime', label: '运行中心', icon: Activity, hint: '观测、任务与用量' },
  { path: '/system', label: '系统', icon: ShieldCheck, hint: '边界、配置与服务状态' }
]
export const workspaceFeatures = {
  persona: {
    label: '人设模板',
    group: '/resources',
    operation: 'persona.read',
    hint: '管理可复用模板及其引用，保存后重启生效'
  },
  ai: {
    label: '模型资源',
    group: '/resources',
    operation: 'providers.read',
    hint: '现有模型渠道与环境变量凭据引用'
  },
  draw: {
    label: '创作工作台',
    group: '/resources',
    operation: 'images.providers',
    hint: '图片生成、编辑与历史'
  },
  games: {
    label: '游戏资源',
    group: '/resources',
    operation: 'turtle-soup.read',
    hint: '题库审核与游戏资源'
  },
  simulation: {
    label: '会话参与',
    group: '/runtime',
    operation: 'simulation.read',
    hint: '各会话的参与方式、预算与自我记录'
  },
  'person-profiles': {
    label: '人物记忆',
    group: '/robots',
    operation: 'profiles.read',
    hint: '按机器人与来源会话查看人物记录'
  },
  trusteeship: {
    label: '托付与承诺',
    group: '/runtime',
    operation: 'trusteeship.read',
    hint: '真实承诺、托付记忆与执行结果'
  },
  observe: {
    label: '运行观测',
    group: '/runtime',
    operation: 'observe.read',
    hint: '真实运行记录与失败原因'
  },
  tokens: {
    label: '模型用量',
    group: '/runtime',
    operation: 'tokens.summary',
    hint: '实例账本中的用量和费用'
  },
  pipeline: {
    label: '消息与搬运',
    group: '/runtime',
    operation: 'pipeline.read',
    hint: '消息任务与投递状态'
  },
  life: {
    label: '作息与生活',
    group: '/runtime',
    operation: 'life.read',
    hint: '当前可用的作息记录与管理'
  },
  style: {
    label: '表达学习',
    group: '/resources',
    operation: 'style.read',
    hint: '已有表达策略及其来源'
  },
  semantic: {
    label: '记忆检索',
    group: '/resources',
    operation: 'semantic.read',
    hint: '当前宿主可用的检索管理'
  },
  commands: {
    label: '骰子边界',
    group: '/system',
    operation: 'config.read',
    hint: '已开放的四项骰子护栏，保存后重启生效'
  },
  conversation: {
    label: '对话配置',
    group: '/system',
    operation: 'conversation.config',
    hint: '当前宿主是否提供对话配置编辑'
  },
  risk: {
    label: '安全配置',
    group: '/system',
    operation: 'risk-control.config',
    hint: '当前宿主是否提供安全配置编辑'
  },
  'group-admin': {
    label: '群管理',
    group: '/connections',
    operation: 'group-admin.read',
    hint: '在明确的连接和会话中管理'
  },
  groups: {
    label: '接入会话',
    group: '/connections',
    operation: 'groups.read',
    hint: '当前接入的完整会话地址'
  }
} as const
export type WorkspaceFeature = keyof typeof workspaceFeatures
