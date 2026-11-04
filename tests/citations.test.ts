import { describe, expect, it } from 'vitest'
import { replaceMarkers, transformContentReferences } from '../src/utils/citations'
import type { ConversationNodeMessage } from '../src/api'

// Shape of shopping answers: products carry `safe_urls: ['']` and links without a URL.
const productList = 'products{"selections":[["turn0product1","Product A"],["turn0product2","Product B"]]}'
const productA = 'product_entity["turn0product1","Product A"]'

const metadata = {
    content_references: [
        {
            type: 'products',
            matched_text: productList,
            start_idx: 0,
            end_idx: 0,
            safe_urls: [''],
            refs: [],
            alt: '### [Product A]()\n*$10.00*\n\n### [Product B]()\n*$20.00*',
        },
        {
            type: 'product_entity',
            matched_text: productA,
            start_idx: 0,
            end_idx: 0,
            safe_urls: [''],
            refs: [],
            alt: '[Product A]()',
        },
    ],
} as ConversationNodeMessage['metadata']

const input = `${productList}\n\n- **${productA}** - Reliable choice.`
const expected = '### Product A\n*$10.00*\n\n### Product B\n*$20.00*\n\n- **Product A** - Reliable choice.'

describe('transformContentReferences', () => {
    it('keeps product names in markdown', () => {
        expect(transformContentReferences(input, metadata)).toBe(expected)
    })

    it('keeps product names in text', () => {
        expect(transformContentReferences(input, metadata, { output: 'text', inlineReferenceMode: 'alt', includeSourceList: false }))
            .toBe(expected)
    })
})

describe('file citations', () => {
    const file = (line: string, name: string) => ({
        type: 'file',
        matched_text: `fileciteturn1file0${line}`,
        start_idx: 0,
        end_idx: 0,
        name,
    })
    const hidden = {
        type: 'hidden',
        matched_text: 'fileciteturn2file0L2-L2',
        start_idx: 0,
        end_idx: 0,
        invalid: true,
    }
    const metadata = {
        content_references: [file('L1-L4', 'notes.md'), file('L9-L12', 'notes.md'), file('L20-L21', 'cost$&.md'), hidden],
    } as unknown as ConversationNodeMessage['metadata']
    const [first, second, dollar] = metadata!.content_references!.map(ref => ref.matched_text)

    it('shows the file name once for adjacent citations of the same file', () => {
        expect(transformContentReferences(`A claim. ${first} ${second}\n\nNext.`, metadata))
            .toBe('A claim. (notes.md)\n\nNext.')
    })

    it('inserts file names verbatim and drops hidden citations', () => {
        expect(transformContentReferences(`A. ${dollar} B. ${hidden.matched_text}`, metadata))
            .toBe('A. (cost$&.md) B. ')
    })
})

describe('image search results', () => {
    const group = {
        type: 'image_group',
        matched_text: 'image_group{"query":["a"]}',
        start_idx: 0,
        end_idx: 0,
        safe_urls: ['https://cdn.example/a.jpg', 'https://cdn.example/b.jpg'],
        alt: '![Image](https://cdn.example/a.jpg)\n\n![Image](https://cdn.example/b.jpg)',
        images: [
            { image_result: { title: 'Page [A]', url: 'https://a.example/', content_url: 'https://cdn.example/a.jpg' } },
            { image_result: { title: 'Page B', content_url: 'https://cdn.example/b.jpg' } },
        ],
    }
    const single = {
        type: 'image_v2',
        matched_text: 'iturn0image0',
        start_idx: 0,
        end_idx: 0,
        safe_urls: ['https://cdn.example/c.jpg'],
        alt: '[![Page C](https://cdn.example/thumb.jpg)](https://c.example/)',
        images: [{ title: 'Page C', url: 'https://c.example/', content_url: 'https://cdn.example/c.jpg' }],
    }
    const withoutImages = { ...group, matched_text: 'image_group{"query":["b"]}', images: [] }
    const metadata = { content_references: [group, single, withoutImages] } as unknown as ConversationNodeMessage['metadata']

    it('links each image to its page, titled by the page', () => {
        expect(transformContentReferences(group.matched_text, metadata)).toBe(
            '[![Page &#91;A&#93;](<https://cdn.example/a.jpg>)](<https://a.example/>)\n\n![Page B](<https://cdn.example/b.jpg>)',
        )
        expect(transformContentReferences(single.matched_text, metadata))
            .toBe('[![Page C](<https://cdn.example/c.jpg>)](<https://c.example/>)')
    })

    it('falls back to the alt text', () => {
        expect(transformContentReferences(withoutImages.matched_text, metadata)).toBe(group.alt)
        expect(transformContentReferences(group.matched_text, metadata, { output: 'text', inlineReferenceMode: 'alt' })).toBe(group.alt)
    })
})

describe('interactive widgets', () => {
    const code = '```js\nconst total = a + b\n```'
    const chart = 'genui{"charts_widget_v2":{}}'
    const metadata = {
        content_references: [
            {
                type: 'client_defined_widget',
                matched_text: code,
                start_idx: 0,
                end_idx: 0,
                alt: null,
                data: { widget_type: 'code_block', language: 'js', content: 'const total = a + b' },
            },
            {
                type: 'client_defined_widget',
                matched_text: chart,
                start_idx: 0,
                end_idx: 0,
                alt: null,
                data: {
                    widget_type: 'charts_widget_v2',
                    content: {
                        meta: { description: 'Weekly visits.' },
                        xKey: 'day',
                        series: [{ dataKey: 'visits', label: 'Visits', valueSuffix: 'k' }, { dataKey: 'note' }],
                        data: [{ day: 'Mon', visits: 1.5, note: 'a|b' }, { day: 'Tue', visits: 2 }],
                        formattedData: [{ day: 'Mon', visits: '1.5k' }],
                    },
                },
            },
        ],
    } as unknown as ConversationNodeMessage['metadata']
    const table = 'Weekly visits.\n\n| day | Visits | note |\n| --- | --- | --- |\n| Mon | 1.5k | a\\|b |\n| Tue | 2k |  |'

    it('keeps code blocks', () => {
        expect(transformContentReferences(`Run:\n\n${code}`, metadata)).toBe(`Run:\n\n${code}`)
    })

    it('turns charts into a table', () => {
        expect(transformContentReferences(`Data:\n\n${chart}\n\nEnd.`, metadata)).toBe(`Data:\n\n${table}\n\nEnd.`)
        expect(transformContentReferences(chart, metadata, { output: 'text', inlineReferenceMode: 'alt' })).toBe(table)
    })
})

describe('text around citations', () => {
    const matched = 'citeturn0search0'
    const metadata = {
        content_references: [{
            type: 'grouped_webpages',
            matched_text: matched,
            start_idx: 0,
            end_idx: 0,
            items: [{ title: 'Page', url: 'https://a.example/', attribution: 'Site' }],
        }],
    } as unknown as ConversationNodeMessage['metadata']

    it('keeps dashes, minus signs and no-break spaces of the answer', () => {
        const text = 'Range 10–20, a—b, −5, a b, wj⁠z.'
        expect(transformContentReferences(`${text} ${matched}`, metadata, { includeSourceList: false }))
            .toBe(`${text} ([Site](<https://a.example/>))`)
    })

    it('finds the matched text where it is written with look-alike characters', () => {
        const ref = {
            type: 'grouped_webpages',
            matched_text: 'cite turn-0',
            start_idx: 0,
            end_idx: 0,
            items: [{ title: 'Page', url: 'https://a.example/', attribution: 'Site' }],
        }
        const dashed = { content_references: [ref] } as unknown as ConversationNodeMessage['metadata']
        expect(transformContentReferences('A cite turn‑0 B', dashed, { includeSourceList: false }))
            .toBe('A ([Site](<https://a.example/>)) B')
    })

    it('drops the highlight markers', () => {
        expect(transformContentReferences('a b c', metadata)).toBe('a b c')
    })
})

describe('citation links', () => {
    const matched = 'citeturn0search0turn0search1turn0search2'
    const metadata = {
        content_references: [{
            type: 'grouped_webpages',
            matched_text: matched,
            start_idx: 0,
            end_idx: 0,
            items: [
                { title: 'First page', url: 'https://github.com/a', attribution: 'GitHub' },
                { title: 'Second page', url: 'https://github.com/b', attribution: 'GitHub' },
                { title: 'Docs | Vite', url: 'https://vite.dev/', attribution: 'Vite' },
            ],
        }],
    } as unknown as ConversationNodeMessage['metadata']

    it('tells links of one site apart by their title', () => {
        expect(transformContentReferences(matched, metadata, { includeSourceList: false }))
            .toBe('([First page](<https://github.com/a>), [Second page](<https://github.com/b>), [Vite](<https://vite.dev/>))')
        expect(transformContentReferences(matched, metadata, { output: 'text', includeSourceList: false }))
            .toBe('(First page: https://github.com/a; Second page: https://github.com/b; Vite: https://vite.dev/)')
    })

    it('escapes a pipe in a title so it cannot split a table cell', () => {
        const piped = {
            content_references: [{
                type: 'grouped_webpages',
                matched_text: matched,
                start_idx: 0,
                end_idx: 0,
                items: [{ title: 'Docs | Vite', url: 'https://vite.dev/?a=1|2' }],
            }],
        } as unknown as ConversationNodeMessage['metadata']
        expect(transformContentReferences(`| a |\n| - |\n| ${matched} |`, piped, { includeSourceList: false }))
            .toBe('| a |\n| - |\n| ([Docs \\| Vite](<https://vite.dev/?a=1%7C2>)) |')
    })
})

describe('image references without images', () => {
    const group = 'iturn0image0'
    const metadata = {
        content_references: [{
            type: 'image_group',
            matched_text: group,
            start_idx: 0,
            end_idx: 0,
            alt: '![Image](https://cdn.example/a.jpg)',
            images: [{ image_result: { title: 'A', url: 'https://a.example/', content_url: 'https://cdn.example/a.jpg' } }],
        }],
    } as unknown as ConversationNodeMessage['metadata']

    it('leaves out image search results, and their alt text', () => {
        expect(transformContentReferences(`Look:\n\n${group}\n\nDone.`, metadata, { includeImages: false })).toBe('Look:\n\n\n\nDone.')
        expect(transformContentReferences(group, metadata)).toContain('![A]')
    })
})

describe('markers that no reference describes', () => {
    const marker = (name: string, ...fields: string[]) => `${name}${fields.map(field => `${field}`).join('')}`
    const noRefs = { content_references: [] } as unknown as ConversationNodeMessage['metadata']

    it('turns a link into a markdown link', () => {
        const input = `| Project |\n| --- |\n| ${marker('url', 'Tool | A', 'https://a.example/x')} |`
        expect(transformContentReferences(input, noRefs)).toBe('| Project |\n| --- |\n| [Tool \\| A](<https://a.example/x>) |')
        expect(transformContentReferences(marker('url', 'Tool A', 'https://a.example/'), noRefs, { output: 'text', inlineReferenceMode: 'alt' }))
            .toBe('Tool A (https://a.example/)')
        expect(transformContentReferences(marker('url', 'Tool A', ''), noRefs)).toBe('Tool A')
    })

    it('keeps the name of an entity', () => {
        expect(transformContentReferences(`See ${marker('entity', '["software","OhMyGame","a game studio"]')}.`, noRefs)).toBe('See OhMyGame.')
        expect(transformContentReferences(`See ${marker('entity', 'not json')}.`, noRefs)).toBe('See .')
    })

    it('drops image carousels, citations and anything else', () => {
        const input = `a${marker('image_group', '{"query":["x"],"layout":"carousel"}')} b${marker('cite', 'turn0search0', 'turn0search1')} c${marker('something_new', 'x', 'y')}`
        expect(transformContentReferences(input, noRefs)).toBe('a b c')
    })

    it('leaves text that only looks like a marker', () => {
        expect(transformContentReferences('url and entity and  alone', noRefs)).toBe('url and entity and  alone')
    })
})

describe('citations left out of the text', () => {
    const matched = '\uE200cite\uE202turn0search0\uE201'
    const metadata = {
        content_references: [
            { type: 'grouped_webpages', matched_text: matched, start_idx: 0, end_idx: 0, items: [{ title: 'Page', url: 'https://a.example/', attribution: 'Site' }] },
            // No items, ChatGPT only wrote the link it showed
            { type: 'grouped_webpages', matched_text: 'citeturn9', start_idx: 0, end_idx: 0, alt: '([Page](https://b.example/))' },
            { type: 'webpage', matched_text: 'legacy1', start_idx: 0, end_idx: 0, url: 'https://c.example/', title: 'C' },
            { type: 'product_entity', matched_text: 'prod1', start_idx: 0, end_idx: 0, safe_urls: [''], alt: '[Product A]()' },
        ],
    } as unknown as ConversationNodeMessage['metadata']

    it('drops every kind of citation and keeps the rest', () => {
        const input = `One.${matched} Two. citeturn9 Three. legacy1 Four prod1.`
        expect(transformContentReferences(input, metadata, { includeCitations: false, includeSourceList: false }))
            .toBe('One. Two.  Three.  Four Product A.')
        expect(transformContentReferences(input, metadata, { includeSourceList: false })).toContain('([Site](<https://a.example/>))')
    })
})

describe('markers in text of their own', () => {
    const marker = (name: string, ...fields: string[]) => `\uE200${name}${fields.map(field => `\uE202${field}`).join('')}\uE201`

    it('turns them into text, as in the answer', () => {
        const input = `Open ${marker('url', 'Repo', 'https://r.example/')} for ${marker('entity', '["software","Tool","a tool"]')}.${marker('cite', 'turn0view0')}`
        expect(replaceMarkers(input, 'markdown')).toBe('Open [Repo](<https://r.example/>) for Tool.')
        expect(replaceMarkers(input, 'text')).toBe('Open Repo (https://r.example/) for Tool.')
    })

    it('leaves nothing of the private use characters', () => {
        expect(replaceMarkers(`\uE203a\uE204 ${marker('something_new', 'x')}`, 'markdown')).toBe('a ')
    })
})

describe('titles with brackets', () => {
    it('are written so that they cannot be read as a formula', () => {
        const matched = '\uE200cite\uE202turn0search0\uE201'
        const metadata = {
            content_references: [
                { type: 'sources_footnote', matched_text: ' ', start_idx: 0, end_idx: 0, sources: [{ title: '[Draft] a_b [c] | d', url: 'https://a.example/' }] },
            ],
        } as unknown as ConversationNodeMessage['metadata']
        const output = transformContentReferences(matched, metadata)
        expect(output).toContain('- [&#91;Draft&#93; a_b &#91;c&#93; \\| d](<https://a.example/>)')
        expect(output).not.toMatch(/\\\[|\\\]/)
    })
})
