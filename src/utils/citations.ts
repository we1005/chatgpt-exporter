import type { ContentReference, ContentReferenceSource, ConversationNodeMessage } from '../api'

type CitationOutput = 'markdown' | 'text'

interface TransformContentReferenceOptions {
    output?: CitationOutput
    inlineReferenceMode?: 'expanded' | 'alt'
    includeSourceList?: boolean
    sourceListLabel?: string
    /** Set to false to leave out image search results, which are remote images */
    includeImages?: boolean
    /** Set to false to leave out the citations in the text, the source list can still follow the text */
    includeCitations?: boolean
}

// ChatGPT writes what it draws in place of text as `\uE200name\uE202field\uE202field\uE201`
const MarkerRegex = /\uE200([a-z_]+)((?:\uE202[^\uE200\uE201]*)*)\uE201/gu

const SpaceLike = /[\u00A0\u202F\u2007\u2060]/u
const DashLike = /[\u2010-\u2015\u2212]/u

/** `\uE203` and `\uE204` mark a highlighted span, they are not part of the text. */
function stripHighlightMarkers(input: string): string {
    return input.replaceAll(/[\uE203\uE204]/gu, '')
}

export function normalizeCitationText(input: string): string {
    return stripHighlightMarkers(input)
        .replaceAll(new RegExp(SpaceLike, 'gu'), ' ')
        .replaceAll(new RegExp(DashLike, 'gu'), '-')
}

/**
 * Matches `text` where a space or a dash may be written as a look-alike
 * character. The answer is searched as written, so the dashes, minus signs and
 * non-breaking spaces of the answer stay untouched.
 */
function toLooseRegExp(text: string): RegExp {
    const source = Array.from(normalizeCitationText(text), (char) => {
        if (char === ' ') return '[ \\u00A0\\u202F\\u2007\\u2060]'
        if (char === '-') return '[-\\u2010-\\u2015\\u2212]'
        return escapeRegExp(char)
    }).join('')
    return new RegExp(source, 'gu')
}

export function transformContentReferences(
    input: string,
    metadata: ConversationNodeMessage['metadata'],
    options: TransformContentReferenceOptions = {},
): string {
    const outputType = options.output ?? 'markdown'
    const inlineReferenceMode = options.inlineReferenceMode ?? 'expanded'
    const contentRefs = metadata?.content_references ?? []
    const includeImages = options.includeImages ?? true
    const includeCitations = options.includeCitations ?? true
    let output = stripHighlightMarkers(input)

    const sortedRefs = [...contentRefs]
        .filter(ref => ref.type !== 'sources_footnote')
        .sort((a, b) => (b.matched_text?.length || 0) - (a.matched_text?.length || 0))

    const fileReplacements = new Set<string>()
    for (const ref of sortedRefs) {
        if (!ref.matched_text) continue
        // ChatGPT draws these code blocks as widgets, but the text already has their Markdown.
        if (ref.type === 'client_defined_widget' && ref.data?.widget_type === 'code_block') continue

        if (!normalizeCitationText(ref.matched_text)) continue

        const replacement = formatInlineReference(ref, outputType, inlineReferenceMode, includeImages, includeCitations)
        output = output.replace(toLooseRegExp(ref.matched_text), () => replacement)
        if (ref.type === 'file' && replacement) fileReplacements.add(replacement)
    }

    // Citations of different lines in the same file would repeat its name
    for (const replacement of fileReplacements) {
        const escaped = escapeRegExp(replacement)
        output = output.replaceAll(new RegExp(`${escaped}(?:\\s*${escaped})+`, 'g'), () => replacement)
    }

    // What no reference describes: links and entities of an interactive reply
    // keep their text, citations and image carousels (a search query, no image) are dropped
    output = output.replace(MarkerRegex, (_marker, kind: string, fields: string) => formatMarker(kind, fields.split('\uE202').slice(1), outputType))

    if (options.includeSourceList !== false) {
        // A reply of the interactive kind cites search results by id and has no footnote
        const footnote = getSourcesFootnoteSources(contentRefs)
        const sources = footnote.length > 0 ? footnote : dedupeSources(metadata?.cited_sources ?? [])
        if (sources.length > 0) {
            output = appendSourcesSection(output, sources, outputType, options.sourceListLabel ?? 'Sources')
        }
    }

    return output
}

/** Markers in text that no reference describes, such as the thoughts of a reply */
export function replaceMarkers(input: string, output: CitationOutput): string {
    return stripHighlightMarkers(input).replace(MarkerRegex, (_marker, kind: string, fields: string) => formatMarker(kind, fields.split('\uE202').slice(1), output))
}

function formatMarker(kind: string, fields: string[], output: CitationOutput): string {
    if (kind === 'url') {
        const [title = '', url = ''] = fields
        if (!url) return output === 'markdown' ? escapeMarkdownText(title) : title
        if (output === 'text') return title && title !== url ? `${title} (${url})` : url
        return `[${escapeMarkdownText(title || url)}](<${escapeMarkdownUrl(url)}>)`
    }

    if (kind === 'entity') {
        // ["software", "Name", "what it is"]
        try {
            const name = (JSON.parse(fields[0]) as unknown[])[1]
            if (typeof name === 'string') return output === 'markdown' ? escapeMarkdownText(name) : name
        }
        catch {}
    }

    return ''
}

export function formatCitationSource(source: ContentReferenceSource, output: CitationOutput, label = getSourceLabel(source)): string {
    const url = source.url?.trim()

    if (!url) return output === 'markdown' ? escapeMarkdownText(label) : label

    if (output === 'text') {
        return `${label}: ${url}`
    }

    return `[${escapeMarkdownText(label)}](<${escapeMarkdownUrl(url)}>)`
}

const CITATION_TYPES = new Set(['grouped_webpages', 'webpage', 'nav_list'])

function formatInlineReference(ref: ContentReference, output: CitationOutput, mode: 'expanded' | 'alt', includeImages: boolean, includeCitations: boolean): string {
    if (ref.type === 'client_defined_widget' && ref.data?.widget_type === 'charts_widget_v2') {
        return formatChart(ref.data.content as ChartContent | undefined)
    }

    // Image search results are remote images, their alt text is an image too
    if (!includeImages && (ref.type === 'image_group' || ref.type === 'image_v2')) return ''

    // A citation is a link to the page a sentence rests on. Product names, charts and the like are content.
    if (!includeCitations && (CITATION_TYPES.has(ref.type) || getInlineSources(ref).length > 0)) return ''

    if (mode === 'alt') return formatAlt(ref.alt)

    if (output === 'markdown' && (ref.type === 'image_group' || ref.type === 'image_v2')) {
        const images = formatImageResults(ref)
        if (images) return images
        return formatAlt(ref.alt)
    }

    const sources = getInlineSources(ref)

    if (sources.length > 0) {
        const separator = output === 'markdown' ? ', ' : '; '
        return `(${formatCitationSources(sources, output).join(separator)})`
    }

    return formatAlt(ref.alt)
}

/**
 * Image search results, shown by ChatGPT as a carousel. Link each image to
 * the page it comes from, with the page title as alt text.
 */
function formatImageResults(ref: ContentReference): string {
    return (ref.images ?? [])
        .map((entry) => {
            const image = entry.image_result ?? entry
            const src = image.content_url?.trim()
            if (!src) return ''

            const markdown = `![${escapeMarkdownText(image.title?.trim() || 'Image')}](<${escapeMarkdownUrl(src)}>)`
            const page = image.url?.trim()
            return page ? `[${markdown}](<${escapeMarkdownUrl(page)}>)` : markdown
        })
        .filter(Boolean)
        .join('\n\n')
}

interface ChartContent {
    meta?: { description?: string }
    xKey?: string
    series?: Array<{ dataKey: string, label?: string, valueSuffix?: string }>
    data?: Array<Record<string, unknown>>
    /** `data` with units, such as `63.4%` */
    formattedData?: Array<Record<string, unknown>>
}

/** A chart becomes its description and a table of its data. */
function formatChart(chart: ChartContent | undefined): string {
    const { meta, xKey, series = [], data = [], formattedData } = chart ?? {}
    if (!xKey || series.length === 0 || data.length === 0) return ''

    const cell = (value: unknown) => String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ')
    const row = (cells: unknown[]) => `| ${cells.map(cell).join(' | ')} |`
    const rows = data.map((point, index) => row([
        point[xKey],
        ...series.map(({ dataKey, valueSuffix = '' }) => formattedData?.[index]?.[dataKey]
            ?? (point[dataKey] == null ? '' : `${point[dataKey]}${valueSuffix}`)),
    ]))
    const table = [
        row([xKey, ...series.map(({ dataKey, label }) => label || dataKey)]),
        row([xKey, ...series].map(() => '---')),
        ...rows,
    ].join('\n')

    const description = meta?.description?.trim()
    return description ? `${description}\n\n${table}` : table
}

/**
 * Product references carry links without a URL, such as `[Product name]()`.
 * Keep their label only.
 */
function formatAlt(alt: string | undefined): string {
    return alt?.replaceAll(/\[([^\]]*)\]\(\)/g, '$1') ?? ''
}

/**
 * Sources of one citation often share a site name, such as `GitHub +5`.
 * A name that more than one source has is replaced by the page title, so the
 * links can be told apart.
 */
function formatCitationSources(sources: ContentReferenceSource[], output: CitationOutput): string[] {
    const counts = new Map<string, number>()
    for (const source of sources) {
        const label = getSourceLabel(source)
        counts.set(label, (counts.get(label) ?? 0) + 1)
    }

    return sources.map((source) => {
        const label = getSourceLabel(source)
        const unique = counts.get(label) === 1
        return formatCitationSource(source, output, unique ? label : source.title?.trim() || label)
    })
}

function getInlineSources(ref: ContentReference): ContentReferenceSource[] {
    const sources: ContentReferenceSource[] = []

    for (const item of ref.items ?? []) {
        sources.push(item)
        sources.push(...(item.supporting_websites ?? []))
    }

    sources.push(...(ref.fallback_items ?? []))

    // Uploaded files have no URL, show their name as ChatGPT does
    if (sources.length === 0 && ref.type === 'file' && ref.name) {
        sources.push({ title: ref.name })
    }

    if (sources.length === 0 && (ref.url || ref.title || ref.attribution)) {
        sources.push(ref)
    }

    // Product references list an empty URL here
    const safeUrls = ref.safe_urls?.filter(Boolean) ?? []
    if (sources.length === 0 && safeUrls.length) {
        sources.push(...safeUrls.map(url => ({ title: url, url })))
    }

    return dedupeSources(sources)
}

function getSourcesFootnoteSources(contentRefs: ContentReference[]): ContentReferenceSource[] {
    const sources = contentRefs
        .filter(ref => ref.type === 'sources_footnote')
        .flatMap((ref) => {
            if (ref.sources?.length) return ref.sources
            if (ref.items?.length) return ref.items
            if (ref.fallback_items?.length) return ref.fallback_items
            if (ref.safe_urls?.length) return ref.safe_urls.map(url => ({ title: url, url }))
            return []
        })

    return dedupeSources(sources)
}

function appendSourcesSection(input: string, sources: ContentReferenceSource[], output: CitationOutput, label: string): string {
    const trimmed = input.trimEnd()
    const sourceList = output === 'markdown'
        ? [
                `**${escapeMarkdownText(label)}:**`,
                '',
                ...formatCitationSources(sources, output).map(entry => `- ${entry}`),
            ].join('\n')
        : [
                `${label}:`,
                ...formatCitationSources(sources, output).map((entry, index) => `${index + 1}. ${entry}`),
            ].join('\n')

    return trimmed ? `${trimmed}\n\n${sourceList}` : sourceList
}

function dedupeSources(sources: ContentReferenceSource[]): ContentReferenceSource[] {
    const seen = new Set<string>()
    const result: ContentReferenceSource[] = []

    for (const source of sources) {
        const key = source.url?.trim() || getSourceLabel(source)
        if (!key || seen.has(key)) continue
        seen.add(key)
        result.push(source)
    }

    return result
}

function getSourceLabel(source: ContentReferenceSource): string {
    return source.attribution?.trim()
        || source.title?.trim()
        || source.url?.trim()
        || 'Source'
}

/** A pipe splits a table cell, a page title such as `Docs | Site` is common */
export function escapeMarkdownText(input: string): string {
    return input
        .replaceAll('\\', '\\\\')
        // Character references, `\\[` would be taken for the start of a formula
        .replaceAll('[', '&#91;')
        .replaceAll(']', '&#93;')
        .replaceAll('|', '\\|')
        .replaceAll('\n', ' ')
}

function escapeMarkdownUrl(input: string): string {
    return input
        .replaceAll('<', '%3C')
        .replaceAll('>', '%3E')
        .replaceAll('|', '%7C')
        .replaceAll('\n', '')
}

function escapeRegExp(input: string): string {
    return input.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
