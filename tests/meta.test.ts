import { describe, expect, it } from 'vitest'
import { formatFrontMatter, getMetaVariables, resolveMetaList } from '../src/exporter/meta'
import type { ConversationResult } from '../src/api'

const conversation = {
    id: 'chat-id',
    title: 'Metadata test',
    model: 'GPT-5',
    modelSlug: 'gpt-5-2',
    createTime: 1,
    updateTime: 0,
    conversationNodes: [],
} as unknown as ConversationResult

const variables = getMetaVariables(conversation, 'https://chatgpt.com/c/chat-id', '2026-09-23')

describe('getMetaVariables', () => {
    it('exposes every variable listed in the settings dialog', () => {
        expect(variables).toMatchObject({
            title: 'Metadata test',
            date: '2026-09-23',
            source: 'https://chatgpt.com/c/chat-id',
            model: 'GPT-5',
            model_name: 'gpt-5-2',
            create_time: '1970-01-01T00:00:01.000Z',
            update_time: '',
        })
        expect(variables.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/)
    })
})

describe('resolveMetaList', () => {
    it('replaces model_name with the model slug', () => {
        expect(resolveMetaList([{ name: 'model', value: '{model} ({model_name})' }], variables))
            .toEqual([['model', 'GPT-5 (gpt-5-2)']])
    })

    it('replaces repeated variables', () => {
        expect(resolveMetaList([{ name: 'x', value: '{title} / {title}' }], variables))
            .toEqual([['x', 'Metadata test / Metadata test']])
    })

    it('inserts values verbatim', () => {
        const vars = { ...variables, title: 'Cost $& {date}' }
        expect(resolveMetaList([{ name: 'x', value: '{title}' }], vars))
            .toEqual([['x', 'Cost $& {date}']])
    })

    it('keeps unknown variables and drops entries without a name', () => {
        expect(resolveMetaList([
            { name: 'x', value: '{unknown} {constructor}' },
            { name: '', value: '{title}' },
        ], variables)).toEqual([['x', '{unknown} {constructor}']])
    })

    it('returns an empty list when metaList is undefined', () => {
        expect(resolveMetaList(undefined, variables)).toEqual([])
    })
})

describe('formatFrontMatter', () => {
    it('writes nothing without metadata', () => {
        expect(formatFrontMatter([])).toBe('')
    })

    it('keeps plain values, dates and links as they are', () => {
        expect(formatFrontMatter([
            ['title', 'Metadata test'],
            ['source', 'https://chatgpt.com/c/chat-id'],
            ['create_time', '2026-01-02T03:04:05.000Z'],
            ['date', '2026-01-02'],
            ['tail', 'Q&A, 50% off'],
            ['empty', ''],
        ])).toBe('---\ntitle: Metadata test\nsource: https://chatgpt.com/c/chat-id\ncreate_time: 2026-01-02T03:04:05.000Z\ndate: 2026-01-02\ntail: Q&A, 50% off\nempty: \n---\n\n')
    })

    it('quotes a value that YAML would not read back as the same text', () => {
        const values = ['Foo: bar', '[Draft] plan', '#1 idea', 'a # b', '- item', 'it\'s: ok', '*bold*', '@home', '!tag', '%x', 'two\nlines', 'ends:', ' padded', 'true', 'Null', '123', '1.5e3']
        const lines = formatFrontMatter(values.map(value => ['title', value] as const)).split('\n').slice(1, -3)
        expect(lines).toEqual(values.map(value => `title: ${JSON.stringify(value)}`))
    })

    it('quotes a name that is not a plain key', () => {
        expect(formatFrontMatter([['my key', 'a'], ['a: b', 'c'], ['#tag', 'd']])).toBe('---\nmy key: a\n"a: b": c\n"#tag": d\n---\n\n')
    })
})
