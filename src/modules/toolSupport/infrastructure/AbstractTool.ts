export interface ParameterSchema {type?:string;items?:ParameterSchema;pattern?:string;enum?:unknown[];minimum?:number;maximum?:number;[key:string]:unknown}
export interface ToolParameters {type:string;properties:Record<string,ParameterSchema>;required:string[];additionalProperties?:boolean}
/**
 * 抽象工具类，所有具体工具需继承此类并实现func方法
 */
import { buildVisibleFailureDetail } from "../../models/domain/visibleFailure.js"
import type { AgentDiagnosticDetails } from '../../../contracts/agentDiagnostics.js'
type ParameterIssue = Pick<AgentDiagnosticDetails, 'field' | 'rule' | 'limit'>

export class AbstractTool {
 /** Captured only by the platform-neutral host tool bridge. */
 agentDataPolicy?: 'ephemeral';
 /** Optional Core host admission before action receipts or temporary-data handling. */
 agentPreflight?(input: Record<string, unknown>, event: unknown, onInvalid?: (issue: ParameterIssue) => void): string | undefined;
 /** Core host tools can emit their own execution receipt. */
 agentDiagnosesExecution = false;
 name:string;parameters:ToolParameters;description:string;skill:Record<string,unknown>|null;
  constructor() {
    this.name = '';
    this.parameters = {
      type: 'object',
      properties: {},
      required: []
    };
    this.description = '';
    this.skill = null;
  }

  getSkill() {
    return this.skill || {
      name: this.name,
      purpose: this.description,
      instructions: '只在用户意图与该能力匹配时调用；参数必须符合 schema，缺少必要信息时先追问。'
    };
  }

  normalizeParameters(params:unknown,_context?:{event:unknown}):Record<string,unknown> {
    return params && typeof params === 'object' && !Array.isArray(params) ? {...params} : {};
  }

  /**
   * 验证参数是否符合工具的要求
   * @param {Object} params - 参数对象
   * @returns {boolean|string} - 如果参数有效则返回true，否则返回错误信息
   */
  validateParameters(params:Record<string,unknown>, onInvalid?: (issue: ParameterIssue) => void) {
    const reject = (rule: string, message: string, field?: string, limit?: number) => {
      onInvalid?.({ rule, ...(field && /^[A-Za-z][A-Za-z0-9_]{0,47}$/u.test(field) ? { field } : {}), ...(limit === undefined ? {} : { limit }) });
      return message;
    };
    if (!params || typeof params !== 'object') {
      return reject('type', '参数必须是一个对象');
    }
  
    const requiredFields = new Set(this.parameters.required || []);
    if (this.parameters.required) {
      for (const required of requiredFields) {
        if (!(required in params)) {
          return reject('required', `缺少必填参数: ${required}`, required);
        }
      }
    }
  
    const { properties } = this.parameters;
    for (const [key, value] of Object.entries(params)) {
      const schema = properties[key];
      if (!schema) continue;

      // Normalizers commonly use an empty value to mean an omitted optional
      // filter. It must not fail an enum intended for actual supplied values.
      if (!requiredFields.has(key) && (value === undefined || value === null || value === '')) {
        continue;
      }
  
      // 处理数组类型
      if (schema.type === 'array') {
        // 如果输入是字符串，自动转换为单元素数组
        if (typeof value === 'string') {
          params[key] = [value];
          continue;
        }
        
        // 验证是否为数组
        if (!Array.isArray(value)) {
          return reject('type', `参数 ${key} 类型错误，应为 array`, key);
        }
  
        // 如果定义了数组元素类型，验证每个元素
        if (schema.items && schema.items.type) {
          const invalidItem = value.some(item => schema.items?.type === 'integer'
            ? !Number.isSafeInteger(item) : typeof item !== schema.items?.type);
          if (invalidItem) {
            return reject('item_type', `参数 ${key} 的数组元素类型错误，应为 ${schema.items.type}`, key);
          }
        }
        continue;
      }
  
      // 处理其他类型
      if (schema.type === 'integer' && (typeof value !== 'number' || !Number.isSafeInteger(value))) {
        return reject('integer', `参数 ${key} 类型错误，应为 integer`, key);
      }
      if (schema.type && schema.type !== 'integer' && typeof value !== schema.type) {
        // 自动类型转换
        if (schema.type === 'string' && typeof value === 'number') {
          params[key] = String(value);
          continue;
        }
        if (schema.type === 'number' && typeof value === 'string' && !isNaN(Number(value))) {
          params[key] = Number(value);
          continue;
        }
        return reject('type', `参数 ${key} 类型错误，应为 ${schema.type}`, key);
      }
  
      if (schema.pattern && !new RegExp(schema.pattern).test(String(value))) {
        return reject('pattern', `参数 ${key} 格式不正确`, key);
      }

      if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
        return reject('enum', `参数 ${key} 必须是以下值之一: ${schema.enum.join(', ')}`, key);
      }
  
      if (['number', 'integer'].includes(schema.type || '') && typeof value==='number') {
        if (schema.minimum !== undefined && value < schema.minimum) {
          return reject('minimum', `参数 ${key} 不能小于 ${schema.minimum}`, key, schema.minimum >= 0 && Number.isSafeInteger(schema.minimum) ? schema.minimum : undefined);
        }
        if (schema.maximum !== undefined && value > schema.maximum) {
          return reject('maximum', `参数 ${key} 不能大于 ${schema.maximum}`, key, schema.maximum >= 0 && Number.isSafeInteger(schema.maximum) ? schema.maximum : undefined);
        }
      }
    }
  
    return true;
  }

  /**
   * 获取工具的基本信息
   * @returns {Object} - 工具的名称、描述和参数
   */
  getToolInfo() {
    if (!this.name) {
      throw new Error('工具名称是必需的');
    }

    if (!this.description) {
      throw new Error('工具描述是必需的');
    }

    return {
      name: this.name,
      description: this.description,
      parameters: this.parameters
    };
  }

  /**
   * 执行工具的主要方法
   * @param {Object} params - 工具的参数
   * @param {Object} event - 事件对象
   * @returns {Promise<unknown>} - 工具执行的结果或错误信息
   */
  async execute(params:unknown, event:unknown, observe?: { invalid(issue: ParameterIssue): void; failed(error: unknown): void }):Promise<unknown> {
    let normalizedParams;
    try {
      normalizedParams = this.normalizeParameters(params, { event });
    } catch (error) {
      observe?.invalid({ rule: 'normalization' });
      return `error: 参数规范化失败: ${buildVisibleFailureDetail(error)}`;
    }
    let reported = false;
    const validation = this.validateParameters(normalizedParams, observe && (issue => { reported = true; observe.invalid(issue) }));
    if (validation !== true) {
      if (!reported) observe?.invalid({ rule: 'business_rule' });
      // 返回错误信息而不是抛出错误
      return `error: ${validation}`;
    }
    try {
      return await this.func(normalizedParams, event);
    } catch (error) {
      observe?.failed(error);
      if (error !== null && typeof error === 'object' && 'uncertain' in error && error.uncertain === true) {
        return {kind:'tool_outcome',status:'unknown',tool:this.name,error:{message:`执行结果未知，可能已产生外部动作；核实前不重复执行。${buildVisibleFailureDetail(error)}`}};
      }
      // 返回错误信息而不是抛出错误
      return `error: 工具 ${this.name} 执行失败: ${buildVisibleFailureDetail(error)}`;
    }
  }

  /**
   * 工具函数，具体工具需实现
   * @param {Object} opts - 参数选项
   * @param {Object} e - 事件对象
   */
  async func(opts:Record<string,unknown>, e:unknown):Promise<unknown> {
    throw new Error('工具函数必须实现');
  }
}
