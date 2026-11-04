import JSZip from 'jszip'
import { fetchConversation, getCurrentChatId, getFileAttachmentNames, processConversation, selectAnswer, shouldSkipMessageInExport, withImageAssets } from '../api'
import { KEY_SOURCES_ENABLED, KEY_THINKING_ENABLED, KEY_TIMESTAMP_24H, KEY_TIMESTAMP_ENABLED, KEY_TIMESTAMP_MARKDOWN, baseUrl } from '../constants'
import i18n from '../i18n'
import { checkIfConversationStarted } from '../page'
import { checkIfTemporaryChatIsExportable } from '../temporaryChat'
import { escapeMarkdownText, replaceMarkers, transformContentReferences } from '../utils/citations'
import { buildZipFileName, downloadFile, getFileNameWithFormat } from '../utils/download'
import { addImageFilesToZip, extractImageFiles, getImageMode } from '../utils/imageFiles'
import { protectMath } from '../utils/latex'
import { codeFence, fromMarkdown, isLocalImageSrc, plainTextToMarkdown, toMarkdown } from '../utils/markdown'
import { ScriptStorage } from '../utils/storage'
import { decodeTypedLineBreaks, standardizeLineBreaks } from '../utils/text'
import { transformAuthor } from '../utils/author'
import type { ApiConversation, ApiConversationWithId, ConversationNodeMessage, ConversationResult, ThinkingContent } from '../api'
import type { ExportMeta, ImageMode } from '../ui/SettingContext'
import type { PartInfo } from '../utils/download'
import { formatFrontMatter, getMetaVariables, resolveMetaList } from './meta'

/** Omitted images skip the download, the other modes need the image data */
function loadImages<T extends ApiConversation>(conversation: T, imageMode: ImageMode): Promise<T> {
    return imageMode === 'omit' ? Promise.resolve(conversation) : withImageAssets(conversation)
}

/**
 * `answerIds` limits the export to one answer of the conversation, the ids
 * are those of the message blocks the page shows for it.
 */
export async function exportToMarkdown(fileNameFormat: string, metaList: ExportMeta[], answerIds?: string[]) {
    if (!checkIfConversationStarted()) {
        alert(i18n.t('Please start a conversation first'))
        return false
    }

    if (!checkIfTemporaryChatIsExportable()) {
        alert(i18n.t('Temporary chat could not be captured'))
        return false
    }

    const chatId = await getCurrentChatId()
    const imageMode = getImageMode()
    const assets = new Map<string, string>()
    let rawConversation = await loadImages(await fetchConversation(chatId), imageMode)
    if (imageMode === 'files') rawConversation = await extractImageFiles(rawConversation, assets)
    const enableThinking = ScriptStorage.get<boolean>(KEY_THINKING_ENABLED) ?? false
    const processed = processConversation(rawConversation, { enableThinking })
    const answer = answerIds && selectAnswer(processed, answerIds)
    if (answer && answer.conversationNodes.length === 0) {
        alert(i18n.t('The answer could not be found'))
        return false
    }
    const conversation = answer ?? processed
    const markdown = standardizeLineBreaks(conversationToMarkdown(conversation, metaList, imageMode, !!answer))

    const title = answer ? `${conversation.title}-answer-${answer.answerIndex}` : conversation.title
    const fileName = getFileNameWithFormat(fileNameFormat, 'md', { title, chatId, createTime: conversation.createTime, updateTime: conversation.updateTime })
    // A conversation without images stays a plain Markdown file
    if (assets.size === 0) {
        downloadFile(fileName, 'text/markdown', markdown)
        return true
    }

    const zip = new JSZip()
    zip.file(fileName, markdown)
    addImageFilesToZip(zip, assets)
    downloadFile(fileName.replace(/\.md$/, '.zip'), 'application/zip', await generateZip(zip))

    return true
}

export async function exportAllToMarkdown(fileNameFormat: string, apiConversations: ApiConversationWithId[], metaList?: ExportMeta[], projectName?: string, partIndex?: number, totalParts?: number) {
    const zip = new JSZip()
    const filenameMap = new Map<string, number>()
    const enableThinking = ScriptStorage.get<boolean>(KEY_THINKING_ENABLED) ?? false
    const imageMode = getImageMode()
    // Shared by every conversation in the zip, file names are content hashes so they never collide
    const assets = new Map<string, string>()
    const rawConversations = imageMode === 'files'
        ? await Promise.all(apiConversations.map(x => extractImageFiles(x, assets)))
        : apiConversations
    const conversations = rawConversations.map(x => processConversation(x, { enableThinking }))
    conversations.forEach((conversation) => {
        let fileName = getFileNameWithFormat(fileNameFormat, 'md', {
            title: conversation.title,
            chatId: conversation.id,
            createTime: conversation.createTime,
            updateTime: conversation.updateTime,
        })
        if (filenameMap.has(fileName)) {
            const count = filenameMap.get(fileName) ?? 1
            filenameMap.set(fileName, count + 1)
            fileName = `${fileName.slice(0, -3)} (${count}).md`
        }
        else {
            filenameMap.set(fileName, 1)
        }
        const content = standardizeLineBreaks(conversationToMarkdown(conversation, metaList, imageMode))
        zip.file(fileName, content)
    })
    addImageFilesToZip(zip, assets)

    const blob = await generateZip(zip)
    const partInfo: PartInfo | undefined = (partIndex != null && totalParts != null)
        ? { part: partIndex, total: totalParts }
        : undefined
    downloadFile(buildZipFileName('markdown', projectName, partInfo), 'application/zip', blob)

    return true
}

function generateZip(zip: JSZip) {
    return zip.generateAsync({
        type: 'blob',
        compression: 'DEFLATE',
        compressionOptions: {
            level: 9,
        },
    })
}

/** Answers keep their own headings, so they sit below the role headings of the export. */
const ASSISTANT_HEADING_OFFSET = 2

/**
 * `answerOnly` is for one answer taken out of its conversation. It is the
 * markdown of the answer itself, without the title and the role headings.
 */
function conversationToMarkdown(conversation: ConversationResult, metaList: ExportMeta[] | undefined, imageMode: ImageMode, answerOnly = false) {
    const { id, title, conversationNodes } = conversation
    const source = `${baseUrl}/c/${id}`

    const frontMatter = formatFrontMatter(resolveMetaList(metaList, getMetaVariables(conversation, source)))

    const enableTimestamp = ScriptStorage.get<boolean>(KEY_TIMESTAMP_ENABLED) ?? false
    const timeStampMarkdown = ScriptStorage.get<boolean>(KEY_TIMESTAMP_MARKDOWN) ?? false
    const timeStamp24H = ScriptStorage.get<boolean>(KEY_TIMESTAMP_24H) ?? false
    const enableSources = ScriptStorage.get<boolean>(KEY_SOURCES_ENABLED) ?? true
    // Same placeholder as the text export. Images are embedded or saved as
    // files, one that ChatGPT loads from a URL is left out.
    const renderImage = imageMode === 'omit'
        ? () => '[image]'
        : (src: string) => isLocalImageSrc(src) ? `![image](${src})` : ''
    // Numbered once for the whole document, every message cites from 1
    const footnotes = { next: 1 }
    const headingOffset = answerOnly ? 0 : ASSISTANT_HEADING_OFFSET

    const content = conversationNodes.map(({ message, thinking }) => {
        if (!message || !message.content) return null

        if (shouldSkipMessageInExport(message)) return null

        const timestamp = message?.create_time ?? ''
        const showTimestamp = enableTimestamp && timeStampMarkdown && timestamp
        let timestampHtml = ''
        if (showTimestamp) {
            const date = new Date(timestamp * 1000)
            // format: 20:12 / 08:12 PM
            const conversationTime = date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: !timeStamp24H })
            timestampHtml = `<time datetime="${date.toISOString()}" title="${date.toLocaleString()}">${conversationTime}</time>\n\n`
        }

        const author = transformAuthor(message.author)
        const thinkingBlock = thinking ? formatThinkingMarkdown(thinking) : ''

        const isAssistant = message.author.role === 'assistant'
        const postSteps: Array<(input: string) => string> = []
        if (isAssistant) {
            // Handle new-style content references (web search citations with Unicode markers)
            postSteps.push(input => transformContentReferences(input, message.metadata, {
                includeSourceList: enableSources,
                sourceListLabel: i18n.t('Sources'),
                includeImages: false,
                // The pages come as a list after the answer, not as links inside its sentences
                includeCitations: false,
            }))
            // Handle old-style footnotes (【11†(PrintWiki)】 format)
            postSteps.push(input => transformFootNotes(input, message.metadata, footnotes))
            // Only message from assistant will be reformatted
            postSteps.push((input) => {
                // Keep formulas out of the markdown round trip, which would escape them
                const { text, restore } = protectMath(input)
                return restore(toMarkdown(fromMarkdown(text), text, { headingOffset, dropRemoteImages: true }))
            })
        }
        const postProcess = (input: string) => postSteps.reduce((acc, fn) => fn(acc), input)
        // The text of a user is markdown when ChatGPT stored it as markdown, a line break is
        // a backslash then. Any other text is plain text, ChatGPT shows it as typed.
        const isMarkdownText = message.metadata?.serialization_metadata?.render_format === 'markdown'
        const markdownText = (input: string) => {
            // The positions of the tree are those of the text it was read from
            const typedText = decodeTypedLineBreaks(input)
            return toMarkdown(fromMarkdown(typedText), typedText, { headingOffset, dropRemoteImages: true })
        }
        const prose = isAssistant ? postProcess : isMarkdownText ? markdownText : plainTextToMarkdown
        const block = isAssistant ? postProcess : (input: string) => input
        const content = transformContent(message.content, message.metadata, prose, block, renderImage)
        const attachments = getFileAttachmentNames(message).map(name => `- 📎 ${name}`).join('\n')
        const attachmentsBlock = attachments ? `\n\n${attachments}` : ''

        // A message of images that are left out has nothing to show
        if (!content.trim() && !attachments && !thinkingBlock) return null

        const heading = answerOnly ? '' : `## ${author}:\n`
        return `${heading}${timestampHtml}${thinkingBlock}${content}${attachmentsBlock}`
    }).filter(Boolean).join('\n\n')

    const markdown = answerOnly ? `${frontMatter}${content.trimEnd()}\n` : `${frontMatter}# ${title.replace(/\s+/g, ' ').trim()}\n\n${content}`

    return markdown
}

/**
 * Transform foot notes in assistant's message
 */
function transformFootNotes(
    input: string,
    metadata: ConversationNodeMessage['metadata'],
    footnotes: { next: number },
) {
    // 【11†(PrintWiki)】
    const footNoteMarkRegex = /【(\d+)†\((.+?)\)】/g

    // A message cites from 1, the document numbers its notes once. A note is
    // defined once per message, however often it is cited.
    const numbers = new Map<number, number>()
    const definitions: string[] = []
    const output = input.replace(footNoteMarkRegex, (match, citeIndex, _evidenceText) => {
        const citation = metadata?.citations?.find(cite => cite.metadata?.extra?.cited_message_idx === +citeIndex)
        if (!citation) return match

        let number = numbers.get(+citeIndex)
        if (number == null) {
            number = footnotes.next++
            numbers.set(+citeIndex, number)
            const citeTitle = citation.metadata?.title ?? 'No title'
            const url = citation.metadata?.url
            definitions.push(`[^${number}]: ${url ? `[${escapeMarkdownText(citeTitle)}](<${url}>)` : citeTitle}`)
        }

        // Use markdown caret to represent foot note ([^1])
        return `[^${number}]`
    })

    // Foot notes are placed at the end of the conversation node, not the end of the whole document
    return definitions.length > 0 ? `${output}\n\n${definitions.join('\n')}` : output
}

/** Every line of the text, in a quote. */
function quote(text: string) {
    return text.split('\n').map(line => `> ${line}`).join('\n')
}

/**
 * Convert the content based on the type of message.
 * `prose` reads text as the message's author wrote it, `block` is for the
 * markdown this exporter writes itself.
 */
function transformContent(
    content: ConversationNodeMessage['content'],
    metadata: ConversationNodeMessage['metadata'],
    prose: (input: string) => string,
    block: (input: string) => string,
    renderImage: (src: string) => string,
) {
    switch (content.content_type) {
        case 'text':
            return prose(content.parts?.join('\n') || '')
        case 'code':
            return block(`Code:\n${codeFence(content.text)}`)
        case 'execution_output':
            if (metadata?.aggregate_result?.messages) {
                return metadata.aggregate_result.messages
                    .filter(msg => msg.message_type === 'image')
                    .map(msg => renderImage(msg.image_url))
                    .filter(Boolean)
                    .join('\n\n')
            }
            return block(`Result:\n${codeFence(content.text ?? '')}`)
        case 'tether_quote':
            return block(quote(content.title || content.text || ''))
        case 'tether_browsing_code':
            return block('') // TODO: implement
        case 'tether_browsing_display': {
            const metadataList = metadata?._cite_metadata?.metadata_list
            if (Array.isArray(metadataList) && metadataList.length > 0) {
                return block(metadataList.map(({ title, url }) => `> [${escapeMarkdownText(title)}](<${url}>)`).join('\n'))
            }
            return block('')
        }
        case 'multimodal_text': {
            // Parts are paragraphs, a text and an image must not run together
            return content.parts?.map((part) => {
                if (typeof part === 'string') return prose(part)
                if (part.content_type === 'image_asset_pointer') return renderImage(part.asset_pointer)
                if (part.content_type === 'audio_transcription') return `[audio] ${plainTextToMarkdown(part.text)}`
                if (part.content_type === 'audio_asset_pointer') return null
                if (part.content_type === 'real_time_user_audio_video_asset_pointer') return null
                return block('[Unsupported multimodal content]')
            }).filter(Boolean).join('\n\n') || ''
        }
        default:
            console.warn('[Exporter] Unsupported Content:', content.content_type, content)
            return block(`[Unsupported Content: ${content.content_type}]`)
    }
}

function formatThinkingMarkdown(thinking: ThinkingContent): string {
    const durationLabel = thinking.durationSeconds != null
        ? i18n.t('Thought for {{seconds}} seconds', { seconds: thinking.durationSeconds })
        : i18n.t('Thinking')

    const parts: string[] = []

    if (thinking.activities?.length) {
        parts.push(thinking.activities.map(a => `- ${replaceMarkers(a, 'markdown')}`).join('\n'))
    }

    const thoughts = thinking.thoughts
        .map(t => t.content || t.summary)
        .filter(Boolean)
        .map(text => replaceMarkers(text, 'markdown'))
        .join('\n\n')
    if (thoughts) parts.push(thoughts)

    const body = parts.join('\n\n')

    if (!body) return ''

    return `<details>\n<summary>${durationLabel}</summary>\n\n${body}\n\n</details>\n\n`
}
