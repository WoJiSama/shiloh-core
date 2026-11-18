import { ref } from 'vue'
import { ConsoleBindingError, createConsoleBindings } from './consoleBindings'
import { consoleRestart, isConfigurationRead, isConfigurationWrite } from './consoleRestart'
import { parseWorkspace } from './workspaceModel'
import { parseConfigurationCommitResult } from './workspaceChangeModel'
const TOKEN_KEY = 'bl-console-token'
let storedToken = ''
try {
  storedToken = localStorage.getItem(TOKEN_KEY) || ''
} catch {
  /* Token links and cookie sessions also work when storage is blocked. */
}
try {
  const url = new URL(location.href)
  const queryToken = url.searchParams.get('token')
  if (queryToken) {
    storedToken = queryToken
    try {
      localStorage.setItem(TOKEN_KEY, queryToken)
    } catch {}
    url.searchParams.delete('token')
    history.replaceState(history.state, '', url)
  }
} catch {
  /* Cookie sessions work without local storage. */
}
export class ApiError extends Error {
  status: number
  details: Record<string, any>
  constructor(status: number, details: Record<string, any>) {
    super(details.error || `请求失败 (${status})`)
    this.status = status
    this.details = details
  }
}
let sessionCheck: Promise<void> | null = null
async function checkSession(headers: Headers) {
  if (!sessionCheck)
    sessionCheck = (async () => {
      try {
        const response = await fetch('/api/auth/state', { headers, credentials: 'same-origin' })
        if (!response.ok) return
        const state = await response.json()
        if (!state.username && !state.tokenWorks)
          window.dispatchEvent(new CustomEvent('console:unauthorized'))
      } catch {
        /* An unavailable upstream does not establish that the console session expired. */
      }
    })().finally(() => {
      sessionCheck = null
    })
  await sessionCheck
}
async function request<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers)
  if (options.body && !(options.body instanceof FormData) && !headers.has('content-type'))
    headers.set('content-type', 'application/json')
  if (storedToken) headers.set('x-console-token', storedToken)
  const response = await fetch(path, { ...options, headers, credentials: 'same-origin' })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    if (response.status === 401 && !path.startsWith('/api/auth/')) {
      if (path.startsWith('/bl-chat/')) await checkSession(headers)
      else window.dispatchEvent(new CustomEvent('console:unauthorized'))
    }
    throw new ApiError(response.status, data)
  }
  return data as T
}
const conversationBindings = createConsoleBindings((signal) =>
  request('/api/bindings', signal ? { signal } : {})
)
export async function api<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  const method = options.method || 'GET'
  consoleRestart.assertAllowed(path, method)
  const generation = consoleRestart.state.generation
  const ticket =
    consoleRestart.state.standalone && isConfigurationWrite(path, method)
      ? consoleRestart.begin(path)
      : undefined
  let selected: { path: string; options: RequestInit }
  try {
    selected = await conversationBindings.prepare(path, options)
  } catch (error) {
    if (ticket) consoleRestart.failed(ticket, error, path)
    if (error instanceof ConsoleBindingError)
      throw new ApiError(error.status, {
        error: error.message,
        code: error.status === 409 ? 'conflict' : 'unavailable'
      })
    throw error
  }
  try {
    if (!ticket) consoleRestart.assertAllowed(path, method)
    let result: T = await request<T>(selected.path, selected.options)
    if (path === '/api/configuration/commit' && method.toUpperCase() === 'POST')
      result = parseConfigurationCommitResult(result) as T
    if (path === '/api/workspace') {
      if (generation !== consoleRestart.state.generation)
        throw new DOMException('工作区读取已过期，请重新检查', 'AbortError')
      parseWorkspace(result)
    } else if (path === '/api/config-state') {
      if (generation !== consoleRestart.state.generation)
        throw new DOMException('配置状态读取已过期，请重新检查', 'AbortError')
      consoleRestart.process(result)
    } else if (ticket) consoleRestart.complete(ticket, result)
    else if (!path.startsWith('/api/auth/')) consoleRestart.observe(result, generation)
    conversationBindings.observe(selected.path, selected.options, result)
    return result
  } catch (error) {
    if (ticket) consoleRestart.failed(ticket, error, path)
    else if (generation === consoleRestart.state.generation) {
      consoleRestart.failed(undefined, error, path)
      if (
        method.toUpperCase() === 'GET' &&
        isConfigurationRead(path) &&
        (error as { status?: number })?.status === 409
      )
        consoleRestart.invalidate()
    }
    throw error
  }
}
export function imageUrl(path: string): string {
  if (!path || /^(data:|blob:)/.test(path)) return path
  const url = new URL(path, location.origin)
  if (url.origin !== location.origin) return path
  if (storedToken && (url.pathname.startsWith('/img/') || url.pathname.startsWith('/bl-chat/')))
    url.searchParams.set('token', storedToken)
  return `${url.pathname}${url.search}${url.hash}`
}
export function clearToken() {
  storedToken = ''
  conversationBindings.reset()
  try {
    localStorage.removeItem(TOKEN_KEY)
  } catch {}
}
export interface AuthState {
  hasUser: boolean
  username: string | null
  tokenWorks: boolean
  via?: string
}
export const authState = ref<AuthState | null>(null)
