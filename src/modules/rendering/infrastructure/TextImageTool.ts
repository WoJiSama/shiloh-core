import type {TextImagePorts,TextImageEvent,RenderLogger,RenderPage} from '../../../contracts/rendering.js'
import {renderRecord,renderError} from './renderDecoders.js'
import {buildDocumentHtml,buildKnowledgeHtml,buildTextImageChatSvg,prepareTextImageContent} from './textImageTemplates.js'
export {hasLatexMath,extractLatexMath,shouldUseDocumentTemplateForTextImage,normalizeMarkdownHeadings,markdownToDocumentHtml,markdownToKnowledgeHtml} from './textImageTemplates.js'
import fs from 'node:fs'
import {pathToFileURL} from 'node:url'
import path from 'node:path'
import sharp from 'sharp'
import {AbstractTool} from '../../toolSupport/infrastructure/AbstractTool.js'

const DELETE_RETRY_DELAYS_MS = [0, 200, 1000]

async function fetchAvatarDataUrl(avatarUrl:string) {
  if (!avatarUrl) return ""

  try {
    const response = await fetch(avatarUrl)
    if (!response.ok) return ""

    const contentType = response.headers.get("content-type") || "image/png"
    const buffer = Buffer.from(await response.arrayBuffer())
    return `data:${contentType};base64,${buffer.toString("base64")}`
  } catch {
    return ""
  }
}

function wait(ms:number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function deleteGeneratedFile(filePath:string,logger?:RenderLogger) {
  for (let index = 0; index < DELETE_RETRY_DELAYS_MS.length; index++) {
    const delay = DELETE_RETRY_DELAYS_MS[index]!
    if (delay > 0) await wait(delay)

    try {
      await fs.promises.unlink(filePath)
      return
    } catch (error) {
      if (renderError(error).code === "ENOENT") return

      const canRetry = ["EBUSY", "EPERM"].includes(renderError(error).code) && index < DELETE_RETRY_DELAYS_MS.length - 1
      if (canRetry) continue

      logger?.warn?.(`[textImageTool] 清理临时图片失败：${renderError(error).message}`)
      return
    }
  }
}

export class TextImageTool extends AbstractTool {
  constructor(readonly ports:TextImagePorts) {
    super()
    this.name = "textImageTool"
    this.description =
      "把文字、Markdown 或代码内容渲染成图片并发送。普通短文本使用 QQ 聊天气泡；代码、Markdown 用 document 文档卡；科普、技术讲解、推导和入门路线用 knowledge 知识卡，它会把标题、结论、步骤、清单、提示和代码块排成易读的层级。数学公式直接写 LaTeX（行内 \\( ... \\)、独立行 \\[ ... \\] 或 $$ ... $$），会渲染成排版公式而不是源码。用户明确要求纯文本、Markdown 原文或代码原文时不要擅自转图。"
    this.parameters = {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "需要转成图片发送的完整内容。用户要求写代码、示例代码、算法实现、Markdown/MD 文档、科普讲解、公式推导时，请把生成好的完整内容放在这里"
        },
        nickname: {
          type: "string",
          description: "图片中显示的昵称，不填则使用机器人昵称"
        },
        avatarUrl: {
          type: "string",
          description: "图片左侧头像链接，不填则使用机器人 QQ 头像"
        },
        template: {
          type: "string",
          enum: ["chat", "document", "knowledge"],
          description: "渲染模板。chat 为普通短文本聊天气泡；document 为代码或 Markdown 文档卡；knowledge 为科普和技术讲解的结构化知识卡"
        }
      },
      required: ["text"],
      additionalProperties: false
    }
  }

  async func(rawOpts:unknown, rawEvent:unknown) {
    const opts=renderRecord(rawOpts),event=renderRecord(rawEvent)
    if(typeof event.reply!=="function")throw new TypeError("文字转图需要可回复的消息事件")
    const e=rawEvent as TextImageEvent
    const text=this.ports.guardText(String(opts.text||"").trim(),e)
    if (!text) return "error: text 不能为空"

    const {template,text:safeText} = prepareTextImageContent(text,String(opts.template || ''))
    const nickname = String(opts.nickname || "").trim()
    const avatarUrl = String(opts.avatarUrl || "").trim()
    let imagePath = ""
    const startedAt = Date.now()

    try {
      imagePath = template === "document" || template === "knowledge"
        ? await this.renderDocumentImage({ text: safeText, template })
        : await this.renderChatImage({
            text: safeText,
            nickname,
            avatarUrl
          })

      const renderedAt = Date.now()
      await e.reply(this.ports.image(imagePath))
      const sentAt = Date.now()
      this.ports.logger?.info?.(`[textImageTool] timing template=${template} render=${renderedAt - startedAt}ms send=${sentAt - renderedAt}ms total=${sentAt - startedAt}ms`)
      return "已将文字、Markdown 或代码转为图片发送成功，不需要再重复发送原始内容，绝对不要以文本形式发送代码和markdown内容，会导致严重群内刷屏！！！。"
    } finally {
      if (imagePath) await deleteGeneratedFile(imagePath,this.ports.logger)
    }
  }

  async renderDocumentImage({ text, template = "document" }:{text:string;template?:string}) {
    const outputDir = path.join(process.cwd(), "resources", "shiloh-plugin", "safe_text_images")
    await fs.promises.mkdir(outputDir, { recursive: true })
    const outputPath = path.join(
      outputDir,
      `safe_text_${template}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.png`
    )
    // 卡面可能引用 file:// 的 katex 样式与字体;setContent 的 about:blank 页面
    // 会拦截 file:// 子资源,必须落盘成临时 HTML 再以 file:// 打开
    const htmlPath = outputPath.replace(/\.png$/, ".html")

    let page:RenderPage|undefined
    try {
      const browser = await this.ports.getSharedBrowser()
      page = await browser.newPage()
      await page.setViewport({ width: 980, height: 1200, deviceScaleFactor: 2 })
      const html = template === "knowledge" ? buildKnowledgeHtml(text) : buildDocumentHtml(text)
      await fs.promises.writeFile(htmlPath, html)
      await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "load", timeout: 60000 })
      await page.evaluate(() => document.fonts.ready)
      const clip = await page.evaluate(() => {
        const body = document.body
        const height = Math.ceil(body.getBoundingClientRect().height)
        return { x: 0, y: 0, width: 980, height: Math.max(1, height) }
      })
      await page.screenshot({ path: outputPath, clip, type: "png" })
      return outputPath
    } catch (error) {
      await deleteGeneratedFile(outputPath,this.ports.logger)
      throw error
    } finally {
      if (page) await page.close().catch(() => {})
      await deleteGeneratedFile(htmlPath,this.ports.logger)
      this.ports.scheduleSharedBrowserClose()
    }
  }

  async renderChatImage({ text, nickname, avatarUrl }:{text:string;nickname:string;avatarUrl:string}) {
    const outputDir = path.join(process.cwd(), "resources", "shiloh-plugin", "safe_text_images")
    await fs.promises.mkdir(outputDir, { recursive: true })

    const avatarDataUrl = await fetchAvatarDataUrl(avatarUrl)
    const {svg} = buildTextImageChatSvg({text,nickname,avatarDataUrl})

    const outputPath = path.join(
      outputDir,
      `safe_text_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.png`
    )

    try {
      await sharp(Buffer.from(svg)).png().toFile(outputPath)
      return outputPath
    } catch (error) {
      await deleteGeneratedFile(outputPath,this.ports.logger)
      throw error
    }
  }
}
