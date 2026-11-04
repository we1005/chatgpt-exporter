import { describe, expect, it, vi } from 'vitest'
import type { ApiConversationWithId } from '../src/api'

// The userscript client touches `document` and constants read `location` at import time.
vi.mock('vite-plugin-monkey/dist/client', () => ({ unsafeWindow: {} }))
vi.stubGlobal('location', { href: 'https://chatgpt.com/' })

const { processConversation } = await import('../src/api')

function message(role: 'user' | 'assistant', text: string, citations: unknown[] = []) {
    return {
        author: { role },
        recipient: 'all',
        content: { content_type: 'text', parts: [text] },
        metadata: { citations },
    }
}

// An assistant reply split across two nodes, which processConversation merges.
function conversation(): ApiConversationWithId {
    return {
        id: 'chat-id',
        title: 'Continuation',
        create_time: 1,
        update_time: 2,
        current_node: 'second',
        mapping: {
            root: { id: 'root', children: ['user'] },
            user: { id: 'user', parent: 'root', children: ['first'], message: message('user', 'Hi') },
            first: { id: 'first', parent: 'user', children: ['second'], message: message('assistant', 'First') },
            second: { id: 'second', parent: 'first', children: [], message: message('assistant', ' second', [{ start_ix: 0 }]) },
        },
    } as unknown as ApiConversationWithId
}

const texts = (raw: ApiConversationWithId) => processConversation(raw).conversationNodes
    .map(node => node.message?.content.content_type === 'text' && node.message.content.parts)

describe('processConversation', () => {
    it('merges continuation nodes', () => {
        expect(texts(conversation())).toEqual([['Hi'], ['First second']])
    })

    it('leaves the raw conversation untouched', () => {
        const raw = conversation()
        const expected = structuredClone(raw)

        processConversation(raw, { enableThinking: true })

        expect(raw).toEqual(expected)
    })

    it('gives the same result when the same conversation is processed twice', () => {
        const raw = conversation()
        texts(raw)

        expect(texts(raw)).toEqual([['Hi'], ['First second']])
    })
})

describe('interactive replies', () => {
    function interactive(markup: string, fallbackMarkdown: string) {
        return {
            ...message('assistant', markup),
            metadata: { model_dil_v2: { code: 'DIL.render(...)', fallbackMarkdown, fallbackMarkdownVersion: 1 } },
        }
    }

    // Two replies of one turn, split by a tool call that the export skips.
    const first = interactive('<box padding={2}>\n  <text>Pick one</text>\n  <segmented-control value={choice} onChange={setChoice}/>\n</box>\n\n', 'Pick one\n\n- red\n- blue')
    const second = interactive('## Next\n\n<text>Compare `a <escape><</escape> b`.</text>', '## Next\n\nCompare `a <escape><</escape> b`.')
    const raw = {
        id: 'chat-id',
        title: 'Interactive',
        create_time: 1,
        update_time: 2,
        current_node: 'second',
        mapping: {
            root: { id: 'root', children: ['user'] },
            user: { id: 'user', parent: 'root', children: ['first'], message: message('user', 'Show me') },
            first: { id: 'first', parent: 'user', children: ['second'], message: first },
            second: { id: 'second', parent: 'first', children: [], message: second },
        },
    } as unknown as ApiConversationWithId

    it('exports the Markdown version instead of the widget markup', () => {
        expect(texts(raw)).toEqual([['Show me'], ['Pick one\n\n- red\n- blue\n\n## Next\n\nCompare `a < b`.']])
    })

    it('leaves the widget markup in the raw conversation', () => {
        texts(raw)

        expect(raw.mapping.first.message?.content).toEqual(first.content)
    })
})

describe('interactive replies that ChatGPT could not convert completely', () => {
    function reply(markup: string, dil: Record<string, unknown>) {
        const raw = {
            id: 'chat-id',
            title: 'Interactive',
            create_time: 1,
            update_time: 2,
            current_node: 'answer',
            mapping: {
                root: { id: 'root', children: ['user'] },
                user: { id: 'user', parent: 'root', children: ['answer'], message: message('user', 'Show me') },
                answer: { id: 'answer', parent: 'user', children: [], message: { ...message('assistant', markup), metadata: { model_dil_v2: { code: 'DIL.render(...)', fallbackMarkdownVersion: 1, ...dil } } } },
            },
        } as unknown as ApiConversationWithId
        return texts(raw)[1][0]
    }

    const markup = [
        '# Answer',
        '',
        '<row><AsyncImage query="x"/><box>',
        '  <text>Pick one</text>',
        '</box></row>',
        '',
        'See <Link url="https://a.example/" title="the docs"/>.<Cite refs={["turn1view0"]}/>',
        '',
        '## Second part',
        '',
        'The text that ChatGPT left out.',
    ].join('\n')
    const cutOff = '# Answer\n\nPick one\n\nSee'

    it('converts the markup when the Markdown version was cut short', () => {
        expect(reply(markup, {
            fallbackMarkdown: cutOff,
            recoveryDiagnostics: [{ code: 'unclosed_block', action: 'recovered_parse', line: 401, column: 1 }],
        })).toBe('# Answer\n\nPick one\n\nSee [the docs](<https://a.example/>).\n\n## Second part\n\nThe text that ChatGPT left out.')
    })

    it('converts the markup when there is no Markdown version', () => {
        expect(reply(markup, {})).toContain('The text that ChatGPT left out.')
        expect(reply(markup, { fallbackMarkdown: '  ' })).toContain('The text that ChatGPT left out.')
    })

    it('still uses a Markdown version that is complete', () => {
        expect(reply(markup, { fallbackMarkdown: cutOff, recoveryDiagnostics: [] })).toBe(cutOff)
        expect(reply(markup, { fallbackMarkdown: cutOff })).toBe(cutOff)
    })

    it('converts the markup when it holds a loop, which the Markdown version leaves out', () => {
        const looped = '# Stages\n\n<box>\n  {#each [["01","Plan"],["02","Build"]] as s}\n    <text>{s[0]} {s[1]}</text>\n  {/each}\n</box>\n\nDone.'
        const result = reply(looped, { fallbackMarkdown: '# Stages\n\nDone.', recoveryDiagnostics: [] })
        expect(result).toBe('# Stages\n\n01 Plan\n\n02 Build\n\nDone.')
    })

    it('keeps the blank line that follows the markup', () => {
        expect(reply(`${markup}\n\n`, { fallbackMarkdown: cutOff, recoveryDiagnostics: [{ code: 'unclosed_block' }] }).endsWith('left out.\n\n')).toBe(true)
    })
})

describe('sources that a reply cites by id', () => {
    const results = (turn: number, ...pages: Array<[string, string]>) => ({
        search_result_groups: [{
            domain: 'example.com',
            entries: pages.map(([url, title], index) => ({ type: 'search_result', url, title, ref_id: { turn_index: turn, ref_type: index % 2 ? 'view' : 'search', ref_index: index } })),
        }],
    })

    function sourcesOf(answerMarkup: string, nodes: Record<string, unknown> = {}) {
        const raw = {
            id: 'chat-id',
            title: 'Cited',
            create_time: 1,
            update_time: 2,
            current_node: 'answer',
            mapping: {
                root: { id: 'root', children: ['user'] },
                user: { id: 'user', parent: 'root', children: ['search'], message: message('user', 'Look it up') },
                // The search ran in a message of its own, before the reply
                search: { id: 'search', parent: 'user', children: ['answer'], message: { ...message('assistant', ''), recipient: 'web.run', metadata: results(7, ['https://a.example/x?utm_source=chatgpt.com', ' Page A '], ['https://b.example/?q=1&utm_source=chatgpt.com', 'Page B'], ['https://c.example/', 'Page C']) } },
                answer: { id: 'answer', parent: 'search', children: [], message: message('assistant', answerMarkup) },
                ...nodes,
            },
        } as unknown as ApiConversationWithId
        const [, answer] = processConversation(raw).conversationNodes
        return { sources: answer.message?.metadata?.cited_sources, metadata: answer.message?.metadata, raw }
    }

    it('lists the cited pages in order of appearance, without repeats and without the tracking parameter', () => {
        const { sources } = sourcesOf('A.<Cite refs={["turn7view1","turn7search0"]}/> B.<Cite refs={["turn7view1","turn7search2"]}/>')
        expect(sources).toEqual([
            { title: 'Page B', url: 'https://b.example/?q=1' },
            { title: 'Page A', url: 'https://a.example/x' },
            { title: 'Page C', url: 'https://c.example/' },
        ])
    })

    it('reads the markers of a converted reply too, and skips ids that were never found', () => {
        const { sources } = sourcesOf('A.citeturn7search0turn9search9')
        expect(sources).toEqual([{ title: 'Page A', url: 'https://a.example/x' }])
    })

    it('leaves a reply without citations alone', () => {
        const { metadata } = sourcesOf('No citations here.')
        expect(metadata?.cited_sources).toBeUndefined()
        expect(metadata?.cite_refs).toBeUndefined()
    })

    it('keeps the raw conversation intact', () => {
        const { raw } = sourcesOf('A.<Cite refs={["turn7search0"]}/>')
        expect((raw.mapping.answer.message?.metadata as any).cited_sources).toBeUndefined()
        expect((raw.mapping.answer.message?.metadata as any).cite_refs).toBeUndefined()
    })
})
