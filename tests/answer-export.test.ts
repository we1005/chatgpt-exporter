import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiConversationWithId } from '../src/api'

const downloadFile = vi.hoisted(() => vi.fn())
const alertMock = vi.hoisted(() => vi.fn())
const chat = vi.hoisted(() => ({ conversation: null as unknown }))

// The userscript client touches `document` and constants read `location` at import time.
vi.mock('vite-plugin-monkey/dist/client', () => ({ unsafeWindow: {} }))
vi.stubGlobal('location', { href: 'https://chatgpt.com/' })
vi.stubGlobal('document', { documentElement: { lang: 'en' } })
vi.stubGlobal('alert', alertMock)

vi.mock('../src/i18n', () => ({ default: { t: (key: string) => key } }))
vi.mock('../src/page', () => ({ getUserAvatar: async () => '', checkIfConversationStarted: () => true }))
vi.mock('../src/temporaryChat', () => ({ checkIfTemporaryChatIsExportable: () => true }))
vi.mock('../src/utils/storage', () => ({ ScriptStorage: { get: () => null } }))
vi.mock('../src/utils/utils', async importOriginal => ({
    ...await importOriginal<typeof import('../src/utils/utils')>(),
    getColorScheme: () => 'light',
}))
vi.mock('../src/utils/download', async importOriginal => ({
    ...await importOriginal<typeof import('../src/utils/download')>(),
    downloadFile,
}))
vi.mock('../src/api', async importOriginal => ({
    ...await importOriginal<typeof import('../src/api')>(),
    getCurrentChatId: async () => 'chat-id',
    fetchConversation: async () => chat.conversation,
    withImageAssets: async (conversation: unknown) => conversation,
}))

const { selectAnswer, processConversation } = await import('../src/api')
const { exportToMarkdown } = await import('../src/exporter/markdown')
const { exportToHtml } = await import('../src/exporter/html')

function message(id: string, role: 'user' | 'assistant', text: string) {
    return { id, author: { role }, recipient: 'all', content: { content_type: 'text', parts: [text] }, metadata: {} }
}

/**
 * Two questions. The first answer is a reply split across `a1` and `a2`,
 * which processConversation merges, the second is `b1`.
 */
function conversation(): ApiConversationWithId {
    const chain = [
        message('u1', 'user', 'First question'),
        message('a1', 'assistant', '# Plan\n\nFirst half.'),
        message('a2', 'assistant', ' Second half.'),
        message('u2', 'user', 'Second question'),
        message('b1', 'assistant', '## Result\n\nOnly this one.'),
    ]
    const mapping = Object.fromEntries(chain.map((m, i) => [m.id, {
        id: m.id,
        parent: chain[i - 1]?.id ?? null,
        children: chain[i + 1] ? [chain[i + 1].id] : [],
        message: m,
    }]))
    return { id: 'chat-id', title: 'My Chat', create_time: 1, update_time: 2, current_node: 'b1', mapping } as unknown as ApiConversationWithId
}

describe('selectAnswer', () => {
    const processed = () => processConversation(conversation())

    it('finds an answer by the id of its message', () => {
        const answer = selectAnswer(processed(), ['b1'])
        expect(answer.conversationNodes.map(node => node.id)).toEqual(['b1'])
        expect(answer.answerIndex).toBe(2)
    })

    it('finds a merged answer by the id of a reply merged into it', () => {
        const answer = selectAnswer(processed(), ['a2'])
        expect(answer.conversationNodes.map(node => node.id)).toEqual(['a1'])
        expect(answer.answerIndex).toBe(1)
    })

    it('keeps the answer once when the page lists the ids of both replies', () => {
        const answer = selectAnswer(processed(), ['a1', 'a2'])
        expect(answer.conversationNodes).toHaveLength(1)
    })

    it('never takes a question for an answer', () => {
        expect(selectAnswer(processed(), ['u1']).conversationNodes.map(node => node.id)).toEqual(['u1'])
        expect(selectAnswer(processed(), ['missing']).conversationNodes).toEqual([])
    })
})

describe('exporting one answer', () => {
    beforeEach(() => {
        downloadFile.mockClear()
        alertMock.mockClear()
        chat.conversation = conversation()
    })

    const downloaded = () => {
        const [fileName, mimeType, content] = downloadFile.mock.calls[0]
        return { fileName: fileName as string, mimeType: mimeType as string, content: content as string }
    }

    it('writes the markdown of the answer alone', async () => {
        expect(await exportToMarkdown('{title}', [], ['b1'])).toBe(true)

        const { fileName, mimeType, content } = downloaded()
        expect(mimeType).toBe('text/markdown')
        expect(fileName).toBe('My_Chat-answer-2.md')
        // No title, no role heading, no question. The headings keep their level.
        expect(content).toBe('## Result\n\nOnly this one.\n')
    })

    it('joins the replies of a merged answer', async () => {
        await exportToMarkdown('{title}', [], ['a1', 'a2'])

        const { fileName, content } = downloaded()
        expect(fileName).toBe('My_Chat-answer-1.md')
        expect(content).toBe('# Plan\n\nFirst half. Second half.\n')
    })

    it('puts the front matter first', async () => {
        await exportToMarkdown('{title}', [{ name: 'title', value: '{title}' }, { name: 'source', value: '{source}' }], ['b1'])

        const { content } = downloaded()
        expect(content.startsWith('---\n')).toBe(true)
        expect(content).toContain('source: https://chatgpt.com/c/chat-id')
        expect(content.endsWith('---\n\n## Result\n\nOnly this one.\n')).toBe(true)
    })

    it('still writes the whole conversation without ids', async () => {
        await exportToMarkdown('{title}', [])

        const { fileName, content } = downloaded()
        expect(fileName).toBe('My_Chat.md')
        expect(content).toContain('# My Chat')
        expect(content).toContain('First question')
        expect(content).toContain('Only this one.')
    })

    it('writes the HTML of the answer alone', async () => {
        expect(await exportToHtml('{title}', [], ['b1'])).toBe(true)

        const { fileName, mimeType, content } = downloaded()
        expect(mimeType).toBe('text/html')
        expect(fileName).toBe('My_Chat-answer-2.html')
        expect(content).toContain('Only this one.')
        expect(content).not.toContain('Second question')
        expect(content).not.toContain('First half')
        expect(content.match(/class="conversation-item"/g)).toHaveLength(1)
    })

    it('tells the user when the answer is not in the conversation', async () => {
        expect(await exportToMarkdown('{title}', [], ['missing'])).toBe(false)
        expect(await exportToHtml('{title}', [], ['missing'])).toBe(false)

        expect(downloadFile).not.toHaveBeenCalled()
        expect(alertMock).toHaveBeenCalledTimes(2)
        expect(alertMock).toHaveBeenCalledWith('The answer could not be found')
    })
})
