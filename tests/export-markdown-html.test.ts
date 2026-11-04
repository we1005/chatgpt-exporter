import JSZip from 'jszip'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiConversationWithId } from '../src/api'

const downloadFile = vi.hoisted(() => vi.fn())
const settings = vi.hoisted(() => ({ values: {} as Record<string, unknown> }))
const page = vi.hoisted(() => ({ lang: 'en' }))

// The userscript client touches `document` and constants read `location` at import time.
vi.mock('vite-plugin-monkey/dist/client', () => ({ unsafeWindow: {} }))
vi.stubGlobal('location', { href: 'https://chatgpt.com/' })
vi.stubGlobal('document', {
    documentElement: {
        get lang() {
            return page.lang
        },
    },
})

vi.mock('../src/i18n', () => ({
    default: {
        t: (key: string, options?: Record<string, string | number>) => key.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name: string) => String(options?.[name] ?? '')),
    },
}))
vi.mock('../src/page', () => ({ getUserAvatar: async () => '' }))
vi.mock('../src/temporaryChat', () => ({}))
vi.mock('../src/utils/storage', () => ({ ScriptStorage: { get: (key: string) => settings.values[key] ?? null } }))
vi.mock('../src/utils/utils', async importOriginal => ({
    ...await importOriginal<typeof import('../src/utils/utils')>(),
    getColorScheme: () => 'light',
}))
vi.mock('../src/utils/download', async importOriginal => ({
    ...await importOriginal<typeof import('../src/utils/download')>(),
    downloadFile,
}))

const { exportAllToHtml } = await import('../src/exporter/html')
const { exportAllToMarkdown } = await import('../src/exporter/markdown')
const constants = await import('../src/constants')

interface Message {
    role: string
    content: unknown
    metadata?: unknown
}

function conversation(messages: Message[], title = 'Chat'): ApiConversationWithId {
    const ids = messages.map((_, i) => `m${i}`)
    const mapping = Object.fromEntries(messages.map((message, i) => [ids[i], {
        id: ids[i],
        parent: ids[i - 1] ?? null,
        children: ids[i + 1] ? [ids[i + 1]] : [],
        message: { id: ids[i], author: { role: message.role }, recipient: 'all', content: message.content, metadata: message.metadata ?? {} },
    }]))
    return {
        id: 'chat-id',
        title,
        create_time: 1,
        update_time: 2,
        current_node: ids[ids.length - 1],
        mapping,
    } as unknown as ApiConversationWithId
}

const text = (...parts: string[]) => ({ content_type: 'text', parts })
const user = (...parts: string[]): Message => ({ role: 'user', content: text(...parts) })
const assistant = (part: string, metadata?: unknown): Message => ({ role: 'assistant', content: text(part), metadata })

async function exportFile(exportAll: typeof exportAllToHtml, conv: ApiConversationWithId, metaList: Array<{ name: string, value: string }> = []): Promise<string> {
    downloadFile.mockClear()
    await exportAll('{title}', [conv], metaList)
    const [, , blob] = downloadFile.mock.calls[0]
    const zip = await JSZip.loadAsync(await blob.arrayBuffer())
    return Object.values(zip.files)[0].async('string')
}

const markdownOf = (messages: Message[], title?: string, metaList?: Array<{ name: string, value: string }>) => exportFile(exportAllToMarkdown, conversation(messages, title), metaList)
const htmlOf = (messages: Message[]) => exportFile(exportAllToHtml, conversation(messages))

/** The HTML of the last message */
function lastContent(html: string) {
    const start = html.lastIndexOf('<div class="conversation-content">')
    return html.slice(start, html.indexOf('</div>\n    </div>', start))
}

beforeEach(() => {
    settings.values = {}
    page.lang = 'en'
})

describe('markdown export structure', () => {
    it('keeps the role headings above the headings of an answer', async () => {
        const markdown = await markdownOf([
            user('q'),
            assistant('# One\n\n## Two\n\n### Three\n\n#### Four\n\n###### Six\n\nbody'),
        ])
        const headings = markdown.split('\n').filter(line => /^#{1,6} /.test(line))
        expect(headings).toEqual(['# Chat', '## You:', '## ChatGPT:', '### One', '#### Two', '##### Three', '###### Four', '###### Six'])
    })

    it('does not let a message heading end the message before it', async () => {
        const markdown = await markdownOf([user('q'), assistant('## Plan\n\ntext\n\n# Summary')])
        const roleHeadings = markdown.split('\n').filter(line => line.startsWith('## '))
        expect(roleHeadings).toEqual(['## You:', '## ChatGPT:'])
    })

    it('writes a title on one line', async () => {
        expect((await markdownOf([user('q'), assistant('a')], 'Two\nlines  here')).startsWith('# Two lines here\n\n')).toBe(true)
    })

    it('separates the parts of a message', async () => {
        const markdown = await markdownOf([
            { role: 'user', content: { content_type: 'multimodal_text', parts: ['one', 'two'] } },
            assistant('a'),
        ])
        expect(markdown).toContain('## You:\none\n\ntwo\n\n## ChatGPT:')
    })

    it('quotes every line of a quote', async () => {
        const markdown = await markdownOf([
            user('q'),
            { role: 'assistant', content: { content_type: 'tether_quote', title: 'first\n\nsecond' } },
        ])
        expect(markdown).toContain('> first\n>\n> second')
    })

    it('uses a fence the code cannot close', async () => {
        const markdown = await markdownOf([
            { role: 'assistant', content: { content_type: 'code', text: 'print("""\n```\nx\n```\n""")' } },
        ])
        expect(markdown).toContain('Code:\n\n````\nprint("""\n```\nx\n```\n""")\n````')
    })

    it('writes line breaks as \\n in every export', async () => {
        const markdown = await markdownOf([user('a\r\nb\rc'), assistant('x\r\ny')])
        expect(markdown).not.toContain('\r')
        const html = await htmlOf([user('a\r\nb\rc'), assistant('x\r\ny')])
        expect(html).not.toContain('\r')
    })
})

describe('markdown export of what the user typed', () => {
    it('does not turn a typed heading or list into structure of the document', async () => {
        const markdown = await markdownOf([user('# My title\nSetext\n=====\n---\n> quoted'), assistant('ok')])
        expect(markdown.split('\n').filter(line => /^#{1,6} /.test(line))).toEqual(['# Chat', '## You:', '## ChatGPT:'])
        expect(markdown).toContain('\\# My title  \nSetext  \n\\=====  \n\\---  \n\\> quoted')
    })

    it('does not let a fence that never closes swallow the rest of the document', async () => {
        const markdown = await markdownOf([user('look:\n```\nunclosed fence'), assistant('answer'), user('next'), assistant('more')])
        expect(markdown.split('\n').filter(line => line.startsWith('```'))).toEqual([])
        expect(markdown.split('\n').filter(line => line.startsWith('## '))).toEqual(['## You:', '## ChatGPT:', '## You:', '## ChatGPT:'])
    })

    it('keeps the lines of a message as lines', async () => {
        const markdown = await markdownOf([user('first\nsecond\nthird'), assistant('ok')])
        expect(markdown).toContain('first  \nsecond  \nthird\n')
    })

    it('keeps a fenced block that the user closed', async () => {
        const markdown = await markdownOf([user('run:\n```sh\nls\n```'), assistant('ok')])
        expect(markdown).toContain('run:  \n```sh\nls\n```\n')
    })

    it('keeps the answer text as written', async () => {
        const markdown = await markdownOf([user('q'), assistant('snake_case and [brackets] stay')])
        expect(markdown).toContain('snake_case and [brackets] stay')
    })
})

describe('markdown export front matter', () => {
    const meta = [{ name: 'title', value: '{title}' }, { name: 'source', value: '{source}' }]

    it('is valid YAML for any title', async () => {
        for (const [title, expected] of [
            ['Plain title', 'title: Plain title'],
            ['Foo: bar', 'title: "Foo: bar"'],
            ['[Draft] plan', 'title: "[Draft] plan"'],
            ['#1 idea', 'title: "#1 idea"'],
            ['He said "hi"', 'title: He said "hi"'],
            ['a\nb', 'title: "a\\nb"'],
        ]) {
            const markdown = await markdownOf([user('q'), assistant('a')], title, meta)
            expect(markdown.startsWith(`---\n${expected}\nsource: https://chatgpt.com/c/chat-id\n---\n\n# `)).toBe(true)
        }
    })

    it('is left out without metadata', async () => {
        expect((await markdownOf([user('q'), assistant('a')])).startsWith('# Chat')).toBe(true)
    })
})

describe('markdown export footnotes', () => {
    const cited = (index: number, title: string, url?: string) => ({
        citations: [{ start_ix: 0, end_ix: 1, metadata: { title, url, extra: { cited_message_idx: index } } }],
    })

    it('numbers the notes once for the whole document and links their pages', async () => {
        const markdown = await markdownOf([
            user('q1'),
            assistant('Fact A 【1†(Wiki)】 and again 【1†(Wiki)】', cited(1, 'Wiki A', 'https://a.example/x')),
            user('q2'),
            assistant('Fact B 【1†(Other)】', cited(1, 'Other B', 'https://b.example/y')),
        ])
        expect(markdown).toContain('Fact A [^1] and again [^1]\n\n[^1]: [Wiki A](https://a.example/x)')
        expect(markdown).toContain('Fact B [^2]\n\n[^2]: [Other B](https://b.example/y)')
        expect(markdown.match(/^\[\^\d+\]:/gm)).toHaveLength(2)
    })

    it('adds nothing to a message without notes', async () => {
        const markdown = await markdownOf([user('q'), assistant('No notes here.')])
        expect(markdown).toBe('# Chat\n\n## You:\nq\n\n## ChatGPT:\nNo notes here.\n')
    })

    it('keeps a mark that has no citation', async () => {
        const markdown = await markdownOf([user('q'), assistant('Fact 【9†(Lost)】', cited(1, 'Wiki'))])
        expect(markdown).toContain('Fact 【9†(Lost)】')
        expect(markdown).not.toContain('[^')
    })
})

describe('text of an answer is kept', () => {
    const dashes = 'Range 10\u201320, a\u2014b, \u22125, a\u00A0b, a\u2060b'

    it('keeps dashes and no-break spaces, in text and in code', async () => {
        const body = `${dashes}\n\n\`\`\`py\nprint("${dashes}")\n\`\`\``
        const metadata = { content_references: [{ type: 'grouped_webpages', matched_text: 'x', start_idx: 0, end_idx: 0, items: [{ title: 'T', url: 'https://t.example/' }] }] }
        for (const html of [false, true]) {
            const out = html ? await htmlOf([user('q'), assistant(body, metadata)]) : await markdownOf([user('q'), assistant(body, metadata)])
            expect(out).toContain(dashes)
            expect(out).toContain(`print(${html ? '&quot;' : '"'}${dashes}`)
        }
    })

    it('does not take two prices for a formula', async () => {
        const price = 'Costs $5 to $10 today, or $ 20.'
        expect(await markdownOf([user('q'), assistant(price)])).toContain(price)
        expect(lastContent(await htmlOf([user('q'), assistant(price)]))).toContain(price)
    })

    it('leaves code that holds brackets alone inside a fence within a fence', async () => {
        const regex = String.raw`const re = /\[(.+?)\]\((.+?)\)/g`
        const body = `\`\`\`\`markdown\n# Template\n\n\`\`\`js\n${regex}\n\`\`\`\n\`\`\`\`\n\nAfter.`
        const markdown = await markdownOf([user('q'), assistant(body)])
        expect(markdown).toContain(regex)
        expect(markdown).not.toContain('$$')
        expect(await htmlOf([user('q'), assistant(body)])).toContain(regex.replaceAll('/', '/'))
    })
})

describe('markdown export has no remote images', () => {
    const REMOTE = 'https://images.example/a.png'
    const DATA = 'data:image/png;base64,iVBORw0KGgo='

    it('leaves out an image the answer links to', async () => {
        const markdown = await markdownOf([
            user('q'),
            assistant(`Look:\n\n![x](${REMOTE})\n\n[![y](${REMOTE})](https://page.example/)\n\n<img src="${REMOTE}">\n\nAfter.`),
        ])
        expect(markdown).toContain('Look:\n\nAfter.')
        expect(markdown).not.toContain('![')
        expect(markdown).not.toContain('<img')
        expect(markdown).not.toContain(REMOTE)
        expect(markdown).not.toContain('page.example')
    })

    it('leaves out image search results', async () => {
        const group = '\uE200i\uE202turn0image0\uE202turn0image1\uE201'
        const markdown = await markdownOf([
            user('q'),
            assistant(`Examples:\n\n${group}\n\nDone.`, {
                content_references: [{
                    type: 'image_group',
                    matched_text: group,
                    start_idx: 0,
                    end_idx: 0,
                    alt: `![Image](${REMOTE})`,
                    images: [{ image_result: { title: 'A | b', url: 'https://page.example/', content_url: REMOTE } }],
                }],
            }),
        ])
        expect(markdown).toContain('Examples:\n\nDone.')
        expect(markdown).not.toContain(REMOTE)
        expect(markdown).not.toContain('![')
    })

    it('leaves out an image that ChatGPT loads from a URL, and the message that has nothing else', async () => {
        const markdown = await markdownOf([
            user('draw it'),
            { role: 'tool', content: { content_type: 'multimodal_text', parts: [{ content_type: 'image_asset_pointer', asset_pointer: REMOTE, width: 1, height: 1 }] } },
            assistant('Here you go.'),
        ])
        expect(markdown).toBe('# Chat\n\n## You:\ndraw it\n\n## ChatGPT:\nHere you go.\n')
    })

    it('still embeds the images of the export itself', async () => {
        const markdown = await markdownOf([
            { role: 'user', content: { content_type: 'multimodal_text', parts: [{ content_type: 'image_asset_pointer', asset_pointer: DATA }, 'look'] } },
            assistant(`Mine: ![z](${DATA})`),
        ])
        expect(markdown).toContain(`![image](${DATA})\n\nlook`)
        expect(markdown).toContain(`![z](${DATA})`)
    })

    it('keeps emoji and the paperclip of an attachment', async () => {
        const markdown = await markdownOf([
            { role: 'user', content: text('see file'), metadata: { attachments: [{ id: 'f', name: 'notes.md', mime_type: 'text/markdown' }] } },
            assistant('Done \u2705'),
        ])
        expect(markdown).toContain('- \uD83D\uDCCE notes.md')
        expect(markdown).toContain('Done \u2705')
    })
})

describe('citations in the text', () => {
    const cite = '\uE200cite\uE202turn0search0\uE202turn0search1\uE201'
    const metadata = {
        content_references: [{
            type: 'grouped_webpages',
            matched_text: cite,
            start_idx: 0,
            end_idx: 0,
            items: [
                { title: 'Vite | Next Generation Frontend Tooling', url: 'https://vite.dev/', attribution: 'Vite' },
                { title: 'Second page', url: 'https://vite.dev/guide/', attribution: 'Vite' },
            ],
        }],
    }

    it('are left out of the Markdown, in a sentence and in a table cell', async () => {
        const markdown = await markdownOf([
            user('q'),
            assistant(`Vite builds the site.${cite}\n\n| Name | Note |\n| --- | --- |\n| A | text ${cite} |`, metadata),
        ])
        expect(markdown).toContain('Vite builds the site.\n')
        expect(markdown).not.toContain('vite.dev')
        expect(markdown).not.toMatch(/\(\[|[\uE200-\uE206]/)
        const rows = markdown.split('\n').filter(line => line.startsWith('|'))
        expect(rows).toHaveLength(3)
        for (const row of rows) expect(row.split('|')).toHaveLength(4)
    })

    it('leave the list of their pages after the answer when the answer has one', async () => {
        const withFootnote = {
            content_references: [
                ...metadata.content_references,
                { type: 'sources_footnote', matched_text: ' ', start_idx: 0, end_idx: 0, sources: [{ title: 'Vite | Next Generation Frontend Tooling', url: 'https://vite.dev/', attribution: 'Vite' }] },
            ],
        }
        const markdown = await markdownOf([user('q'), assistant(`Vite builds the site.${cite}`, withFootnote)])
        expect(markdown).toContain('Vite builds the site.\n\n**Sources:**\n\n- [Vite](https://vite.dev/)')
        expect(markdown.split('vite.dev')).toHaveLength(2)
    })

    it('keep what is content: product names stay, uploaded file names go', async () => {
        const product = 'product_entity["turn0product1","Product A"]'
        const file = 'fileciteturn1file0L1-L4'
        const markdown = await markdownOf([
            user('q'),
            assistant(`Buy ${product} now. See ${file}.`, {
                content_references: [
                    { type: 'product_entity', matched_text: product, start_idx: 0, end_idx: 0, safe_urls: [''], refs: [], alt: '[Product A]()' },
                    { type: 'file', matched_text: file, start_idx: 0, end_idx: 0, name: 'notes.md' },
                ],
            }),
        ])
        expect(markdown).toContain('Buy Product A now. See .')
        expect(markdown).not.toContain('notes.md')
    })

    it('are still links in the HTML, told apart by their titles', async () => {
        const html = lastContent(await htmlOf([user('q'), assistant(`Vite builds the site.${cite}`, metadata)]))
        expect(html).toContain('<a href="https://vite.dev/">Vite | Next Generation Frontend Tooling</a>')
        expect(html).toContain('<a href="https://vite.dev/guide/">Second page</a>')
    })
})

describe('thinking', () => {
    function withThinking(seconds?: number) {
        const conv = conversation([user('q'), assistant('Answer')])
        const node = Object.values(conv.mapping).find(n => n.message?.author.role === 'assistant')!
        const raw = {
            ...conv,
            mapping: {
                ...conv.mapping,
                [node.id]: node,
                r: { id: 'r', parent: 'm0', children: [], message: { id: 'r', author: { role: 'assistant' }, recipient: 'all', channel: 'analysis', content: { content_type: 'thoughts', thoughts: [{ summary: 'Plan', content: 'Think hard' }] }, metadata: {} } },
                rr: { id: 'rr', parent: 'r', children: ['m1'], message: { id: 'rr', author: { role: 'assistant' }, recipient: 'all', content: { content_type: 'reasoning_recap', content: `Thought for ${seconds ?? 1}s` }, metadata: seconds == null ? {} : { finished_duration_sec: seconds } } },
            },
        } as unknown as ApiConversationWithId
        raw.mapping.m1.parent = 'rr'
        raw.mapping.m0.children = ['r']
        return raw
    }

    it('names the time in the language of the page', async () => {
        settings.values[constants.KEY_THINKING_ENABLED] = true
        const markdown = await exportFile(exportAllToMarkdown, withThinking(12))
        expect(markdown).toContain('<summary>Thought for 12 seconds</summary>')
        const html = await exportFile(exportAllToHtml, withThinking(12))
        expect(html).toContain('<summary>Thought for 12 seconds</summary>')
    })
})

describe('html export', () => {
    it('falls back to English when the page has no language', async () => {
        page.lang = ''
        expect(await htmlOf([user('q'), assistant('a')])).toContain('<html lang="en" data-theme="light">')
        page.lang = 'zh-CN'
        expect(await htmlOf([user('q'), assistant('a')])).toContain('<html lang="zh-CN" data-theme="light">')
    })

    it('keeps a line break in a table cell and a details block', async () => {
        const html = lastContent(await htmlOf([
            user('q'),
            assistant('| a | b |\n| - | - |\n| line1<br>line2 | x |\n\n<details>\n<summary>More</summary>\nHidden text\n</details>\n\nPress <kbd>Ctrl</kbd>+<kbd>C</kbd>'),
        ]))
        expect(html).toContain('<td>line1<br>line2</td>')
        expect(html).toContain('<details>\n<summary>More</summary>\nHidden text\n</details>')
        expect(html).toContain('<kbd>Ctrl</kbd>+<kbd>C</kbd>')
    })

    it('still drops a script, a style and event handlers from the answer', async () => {
        const html = lastContent(await htmlOf([
            user('q'),
            assistant('<script>alert(1)</script>\n\n<style>body { display: none }</style>\n\ntext <img src=x onerror=alert(1)> <b onclick="x()">bold</b>'),
        ]))
        expect(html).not.toContain('<script')
        expect(html).not.toContain('<style')
        expect(html).not.toContain('alert')
        expect(html).not.toContain('onclick')
        expect(html).not.toContain('<img')
        expect(html).toContain('bold')
    })

    it('puts every table in a box that scrolls', async () => {
        const html = lastContent(await htmlOf([user('q'), assistant('| a | b |\n| - | - |\n| 1 | 2 |\n\ntext\n\n| c |\n| - |\n| 3 |')]))
        expect(html.match(/<div class="table-wrap"><table>/g)).toHaveLength(2)
        expect(html.match(/<\/table><\/div>/g)).toHaveLength(2)
    })

    it('marks a mermaid block for the page to draw, and keeps the source readable', async () => {
        const html = lastContent(await htmlOf([user('q'), assistant('```mermaid\nflowchart TD\n  A[Start] --> B{OK?}\n```\n\n```js\nlet a\n```')]))
        expect(html).toContain('<pre class="mermaid-source"><code class="language-mermaid nohighlight">flowchart TD\n  A[Start] --&gt; B{OK?}\n</code></pre>')
        expect(html).toContain('<pre><code class="language-js">let a\n</code></pre>')
    })

    it('quotes every line of a quote', async () => {
        const html = lastContent(await htmlOf([user('q'), { role: 'assistant', content: { content_type: 'tether_quote', title: 'first\n\nsecond' } }]))
        expect(html).toContain('<blockquote>\n<p>first</p>\n<p>second</p>\n</blockquote>')
    })

    it('escapes the source of an image', async () => {
        const html = await htmlOf([
            user('q'),
            { role: 'assistant', content: { content_type: 'multimodal_text', parts: [{ content_type: 'image_asset_pointer', asset_pointer: 'data:image/png;base64,AA" onerror="x', width: 3, height: 4 }] } },
        ])
        expect(html).toContain('<img src="data:image/png;base64,AA&quot; onerror=&quot;x" height="4" width="3" />')
    })

    it('loads the libraries that draw diagrams and formulas', async () => {
        const html = await htmlOf([user('q'), assistant('a')])
        expect(html).toContain('mermaid.min.js')
        expect(html).toContain('katex.min.js')
        expect(html).toContain('highlight.min.js')
    })
})

describe('html export style', async () => {
    const { readFileSync } = await import('node:fs')
    const template = readFileSync(new URL('../src/template.html', import.meta.url), 'utf8')

    it('does not force a font size on every element', () => {
        expect(template).not.toMatch(/\*\s*\{[^}]*font-size/)
    })

    it('has a style for the first message, a scrolling table and a bold h4', () => {
        expect(template).toContain('.conversation-header + .conversation-item')
        expect(template).not.toContain('.conversation-item:first-of-type')
        expect(template).toMatch(/\.table-wrap\s*\{[^}]*overflow-x:\s*auto/)
        expect(template).toMatch(/h4\s*\{\s*font-weight:\s*600/)
    })

    it('does not put quotation marks around a quote', () => {
        expect(template).not.toContain('open-quote')
        expect(template).not.toContain('close-quote')
    })
})

describe('what the user typed, stored as markdown', () => {
    const markdownUser = (text: string): Message => ({
        role: 'user',
        content: { content_type: 'text', parts: [text] },
        metadata: { serialization_metadata: { render_format: 'markdown' } },
    })
    // ChatGPT stores a line break as a backslash and a new line, a leading space as &#x20;
    const typed = '@Search  First line.\\\nSecond line.\\\n&#x20; Indented.'

    it('writes the lines as typed, without the backslashes of ChatGPT', async () => {
        const markdown = await markdownOf([markdownUser(typed), assistant('ok')])
        // A hard break is two spaces, a character reference stays as it is written
        expect(markdown).toContain('## You:\n@Search  First line.  \nSecond line.  \n&#x20; Indented.\n')
        expect(markdown).not.toContain('\\')
    })

    it('turns a line of one backslash into an empty line, also before a list ends', async () => {
        const markdown = await markdownOf([markdownUser('Questions:\\\n1. Why?\\\n2. How?\\\n\\\nPlease answer.\\\n\\\nThanks'), assistant('ok')])
        expect(markdown).toContain('## You:\nQuestions:\n\n1. Why?\n2. How?\n\nPlease answer.\n\nThanks\n')
        expect(markdown).not.toContain('\\')
    })

    it('leaves the backslashes of code alone', async () => {
        const markdown = await markdownOf([markdownUser('Run `a\\b`:\\\n```\nC:\\dir\\\nx \\\n```'), assistant('ok')])
        expect(markdown).toContain('`a\\b`')
        expect(markdown).toContain('C:\\dir\\\nx \\\n')
    })

    it('shows the line breaks in HTML, without a backslash', async () => {
        const html = await htmlOf([markdownUser(typed), assistant('ok')])
        const start = html.indexOf('<div class="conversation-content">')
        const user = html.slice(start, html.indexOf('<div class="conversation-item">', start + 1))
        expect(user).toMatch(/<div class="no-katex"><p>@Search {2}First line\.<br \/>\nSecond line\.<br \/>\n {2}Indented\.<\/p>/)
        expect(user).not.toContain('\\')
    })

    it('keeps its headings below the role headings and does not let a fence run on', async () => {
        const markdown = await markdownOf([markdownUser('# Heading\n\n```js\nnever closed'), assistant('answer'), markdownUser('next'), assistant('more')])
        expect(markdown.split('\n').filter(line => /^#{1,6} /.test(line))).toEqual(['# Chat', '## You:', '### Heading', '## ChatGPT:', '## You:', '## ChatGPT:'])
        expect(markdown).toMatch(/```js\nnever closed\n```\n+## ChatGPT:/)
    })

    it('leaves out the raw html of it in HTML', async () => {
        const html = await htmlOf([markdownUser('hi <script>alert(1)</script><b onclick="x()">there</b>'), assistant('ok')])
        const start = html.indexOf('<div class="conversation-content">')
        const user = html.slice(start, html.indexOf('<div class="conversation-item">', start + 1))
        expect(user).not.toContain('<script')
        expect(user).not.toContain('<b')
        expect(user).not.toContain('onclick')
        expect(user).toContain('there')
    })

    it('still shows other text as typed', async () => {
        const markdown = await markdownOf([user('# not a heading\\\nline'), assistant('ok')])
        expect(markdown).toContain('\\# not a heading\\  \nline')
    })
})

describe('an interactive answer that ChatGPT could not convert completely', () => {
    const marker = (name: string, ...fields: string[]) => `${name}${fields.map(field => `${field}`).join('')}`
    const markup = [
        '# Answer',
        '',
        '| Project | Home |',
        '|---|---|',
        '| <Entity category="software" value="Tool A" disambig="a tool"/> | <Link url="https://a.example/" title="Tool A"/> |',
        '',
        '<row><AsyncImage query="tool a screenshot"/><box>',
        '  **Tool A**',
        '',
        '  <text>What it does.</text>',
        '</box></row>',
        '',
        'Run it:<Cite refs={["turn1view0"]}/>',
        '',
        '<CodeBlock language="markdown" editable>',
        '# Policy',
        '- one',
        '```',
        '',
        '## Second part',
        '',
        'The text that ChatGPT left out, with a formula \\(x+1\\).',
    ].join('\n')
    // What ChatGPT converted before it gave up: links and entities as markers
    const fallbackMarkdown = `# Answer\n\n| Project | Home |\n|---|---|\n| ${marker('entity', '["software","Tool A","a tool"]')} | ${marker('url', 'Tool A', 'https://a.example/')} |\n\nRun it:${marker('cite', 'turn1view0')}\n\n`
    const interactive: Message = {
        role: 'assistant',
        content: text(markup),
        metadata: { model_dil_v2: { fallbackMarkdown, fallbackMarkdownVersion: 1, recoveryDiagnostics: [{ code: 'unclosed_block', action: 'recovered_parse', line: 7, column: 1 }] } },
    }

    it('exports the whole answer to Markdown, with links as links', async () => {
        const markdown = await markdownOf([user('q'), interactive])
        expect(markdown).toContain('| Tool A  | [Tool A](https://a.example/) |')
        expect(markdown).toContain('**Tool A**\n\nWhat it does.')
        expect(markdown).toContain('```markdown\n# Policy\n- one\n```')
        expect(markdown).toContain('The text that ChatGPT left out, with a formula $x+1$.')
        expect(markdown).not.toMatch(/[-]/)
        expect(markdown).not.toMatch(/<\/?(?:box|row|text|Cite|Entity|Link|CodeBlock|AsyncImage)\b/)
    })

    it('exports the whole answer to HTML', async () => {
        const html = lastContent(await htmlOf([user('q'), interactive]))
        expect(html).toContain('<a href="https://a.example/">Tool A</a>')
        expect(html).toContain('The text that ChatGPT left out, with a formula \\(x+1\\).')
        expect(html).not.toMatch(/[-]/)
        expect(html).not.toContain('<box')
    })

    it('exports a Markdown version that is complete, markers turned into text', async () => {
        const complete: Message = { ...interactive, metadata: { model_dil_v2: { fallbackMarkdown, fallbackMarkdownVersion: 1 } } }
        const markdown = await markdownOf([user('q'), complete])
        expect(markdown).toContain('| Tool A  | [Tool A](https://a.example/) |')
        expect(markdown).toContain('Run it:\n')
        expect(markdown).not.toContain('left out')
        expect(markdown).not.toMatch(/[-]/)
    })
})

describe('the sources of a reply', () => {
    // The search ran in a message of its own, the interactive reply cites its results by id
    const search: Message = {
        role: 'assistant',
        content: text(''),
        metadata: {
            search_result_groups: [{
                entries: [
                    { url: 'https://vite.dev/guide/build?utm_source=chatgpt.com', title: 'Building for Production | Vite', ref_id: { turn_index: 3, ref_type: 'view', ref_index: 0 } },
                    { url: 'https://github.com/a/b', title: 'GitHub - a/b', ref_id: { turn_index: 3, ref_type: 'search', ref_index: 1 } },
                ],
            }],
        },
    }
    const markup = 'Build it.<Cite refs={["turn3view0"]}/>\n\nSee <Link url="https://github.com/a/b" title="a/b"/>.<Cite refs={["turn3search1","turn3view0"]}/>'
    const messages: Message[] = [user('q'), { ...search, metadata: { ...search.metadata as object } }, assistant(markup, { model_dil_v2: { fallbackMarkdown: 'Build it.', fallbackMarkdownVersion: 1 } })]
    // the search message is hidden from the export because it is addressed to a tool
    messages[1] = { ...messages[1], role: 'assistant' }

    function withTool(): ApiConversationWithId {
        const conv = conversation(messages)
        ;(conv.mapping.m1.message as any).recipient = 'web.run'
        return conv
    }

    it('lists the pages after the reply in Markdown', async () => {
        const markdown = await exportFile(exportAllToMarkdown, withTool())
        expect(markdown).toContain('**Sources:**\n\n- [Building for Production \\| Vite](https://vite.dev/guide/build)\n- [GitHub - a/b](https://github.com/a/b)')
        expect(markdown).not.toContain('utm_source')
        expect(markdown).not.toMatch(/<Cite|[-]/)
    })

    it('lists them in HTML', async () => {
        const html = lastContent(await exportFile(exportAllToHtml, withTool()))
        expect(html).toContain('<a href="https://vite.dev/guide/build">Building for Production | Vite</a>')
        expect(html).toContain('<a href="https://github.com/a/b">GitHub - a/b</a>')
    })

    it('leaves the list out when sources are turned off', async () => {
        settings.values[constants.KEY_SOURCES_ENABLED] = false
        const markdown = await exportFile(exportAllToMarkdown, withTool())
        expect(markdown).not.toContain('Sources')
        expect(markdown).not.toContain('vite.dev')
    })
})

describe('markers that leak into an export', () => {
    const marker = (name: string, ...fields: string[]) => `\uE200${name}${fields.map(field => `\uE202${field}`).join('')}\uE201`
    const repo = marker('url', 'kubernetes-sigs/agent-sandbox', 'https://github.com/kubernetes-sigs/agent-sandbox')
    const answer = `Newer choice, kept by Kubernetes SIG Apps:\n\n**${repo}**\n\nThis is the project to study.`

    it('become a link in Markdown, bold or not', async () => {
        const markdown = await markdownOf([user('q'), assistant(answer), user('q2'), assistant(`- ${repo}\n\n| Project |\n| --- |\n| ${repo} |`)])
        expect(markdown).toContain('**[kubernetes-sigs/agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox)**')
        expect(markdown).toContain('- [kubernetes-sigs/agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox)')
        expect(markdown).toContain('| [kubernetes-sigs/agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox) |')
        expect(markdown).not.toMatch(/[\uE200-\uE206]|agent-sandbox\u0020https/)
    })

    it('become a link in HTML', async () => {
        const html = lastContent(await htmlOf([user('q'), assistant(answer)]))
        expect(html).toContain('<strong><a href="https://github.com/kubernetes-sigs/agent-sandbox">kubernetes-sigs/agent-sandbox</a></strong>')
        expect(html).not.toMatch(/[\uE200-\uE206]/)
    })

    it('are cleaned out of the thoughts, in Markdown and HTML', async () => {
        settings.values[constants.KEY_THINKING_ENABLED] = true
        const conv = conversation([user('q'), assistant('ok')])
        conv.mapping.m0.children = ['think']
        conv.mapping.m1.parent = 'think'
        conv.mapping.think = {
            id: 'think',
            parent: 'm0',
            children: ['m1'],
            message: { id: 'think', author: { role: 'assistant' }, recipient: 'all', channel: 'analysis', content: { content_type: 'thoughts', thoughts: [{ summary: `Reading ${repo}${marker('cite', 'turn0view0')}`, content: '' }] }, metadata: {} },
        } as any
        const markdown = await exportFile(exportAllToMarkdown, conv)
        expect(markdown).toContain('Reading [kubernetes-sigs/agent-sandbox](<https://github.com/kubernetes-sigs/agent-sandbox>)')
        expect(markdown).not.toMatch(/[\uE200-\uE206]/)
        const html = await exportFile(exportAllToHtml, conv)
        expect(html).toContain('Reading kubernetes-sigs/agent-sandbox (https://github.com/kubernetes-sigs/agent-sandbox)')
        expect(html).not.toMatch(/[\uE200-\uE206]/)
    })

    it('keep a page title with brackets and a pipe out of formulas and table cells', async () => {
        const link = marker('url', '[Draft] a_b [c] | d', 'https://a.example/x_y')
        const markdown = await markdownOf([user('q'), assistant(`See ${link}.\n\n| Name |\n| --- |\n| ${link} |`)])
        expect(markdown).not.toContain('$')
        expect(markdown).toContain('[&#91;Draft&#93; a_b &#91;c&#93; \\| d](https://a.example/x_y)')
        const html = lastContent(await htmlOf([user('q'), assistant(`See ${link}.`)]))
        expect(html).toContain('<a href="https://a.example/x_y">[Draft] a_b [c] | d</a>')
        expect(html).not.toContain('\\[')
    })
})
