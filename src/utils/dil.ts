import { codeFence } from './markdown'
import { mapOutsideCode } from './code'

/**
 * ChatGPT writes interactive answers as markdown with JSX-like tags in it:
 * `<box>` and `<row>` for layout, `<Link url="…" title="…"/>`,
 * `<Entity value="…"/>`, `<Cite refs={[…]}/>`, `<CodeBlock language="…">`.
 * Next to it ChatGPT stores a markdown version of the answer. That version is
 * cut short when ChatGPT could not read the markup to the end, so this turns
 * the markup itself into markdown for such an answer.
 */

// `<`, an optional `/`, the name, the attributes (quoted strings and braces
// can hold a `>`), an optional `/`, `>`
const TagRegex = /<(\/?)([A-Za-z][\w-]*)((?:[^>"'{}]|"[^"]*"|'[^']*'|\{(?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*\})*?)(\/?)>/g
const AttributeRegex = /([A-Za-z][\w-]*)=(?:"([^"]*)"|\{((?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*)\})/g

/** Layout tags hold markdown that goes on after them, each level indents by 2 spaces */
const LAYOUT_TAGS = new Set(['box', 'row', 'grid', 'grid-item', 'text', 'caption', 'radio-group', 'label'])

function attributesOf(source: string): Record<string, string> {
    const attributes: Record<string, string> = {}
    for (const [, name, quoted, braced] of source.matchAll(AttributeRegex)) attributes[name] = quoted ?? braced
    return attributes
}

function optionLabels(options: string | undefined): string[] {
    if (!options) return []
    try {
        const list = JSON.parse(options) as Array<{ label?: unknown }>
        return list.map(option => String(option.label ?? '')).filter(Boolean)
    }
    catch {
        return []
    }
}

function convertTag(match: string, closing: string, name: string, attributeSource: string): string {
    const attributes = attributesOf(attributeSource)
    const lower = name.toLowerCase()

    if (LAYOUT_TAGS.has(lower)) return '\n\n'

    switch (name) {
        case 'Link': {
            const { url, title } = attributes
            if (!url) return title ?? ''
            return `[${(title || url).replaceAll('[', '&#91;').replaceAll(']', '&#93;').replaceAll('|', '\\|')}](<${url.replaceAll('|', '%7C')}>)`
        }
        case 'Entity':
            return (attributes.value ?? '').replaceAll('|', '\\|')
        case 'Cite':
        case 'MemoryCite':
        case 'AsyncImage':
            return ''
    }

    switch (lower) {
        case 'icon':
            return ''
        case 'divider':
            return '\n\n---\n\n'
        case 'title':
            return closing ? '**\n\n' : '\n\n**'
        case 'badge':
            return closing ? ')' : '('
        case 'button':
            return closing ? ']' : '['
        case 'radio':
            return closing ? '\n' : '\n- '
        case 'segmented-control':
        case 'select':
            return `\n\n${optionLabels(attributes.options).map(label => `- ${label}`).join('\n')}\n\n`
    }

    // Anything else is text that looks like a tag, such as `<game-slug>`
    return match
}

/**
 * `{#each [...] as item,i} ... {/each}` repeats its body for each element of a
 * JSON array, `{item[0]}`, `{item.name}` and `{i}` stand for what the element
 * holds. `{#if a === 1 || a === 2} ... {:else} ... {/if}` keeps one of its parts.
 */
const EACH_OPEN = /\{#each\s/g
const EACH_CLOSE = /\{\/each\}/g

/** Index after the array that starts at `start` (which holds `[`), or -1 */
function skipArray(text: string, start: number): number {
    let depth = 0
    let quote = ''
    for (let i = start; i < text.length; i++) {
        const char = text[i]
        if (quote) {
            if (char === '\\') i++
            else if (char === quote) quote = ''
        }
        else if (char === '"' || char === '\'') quote = char
        else if (char === '[') depth++
        else if (char === ']' && --depth === 0) return i + 1
    }
    return -1
}

function lookup(item: unknown, path: string): string {
    let value: unknown = item
    for (const [, key, index] of path.matchAll(/\.(\w+)|\[(\d+)\]/g)) {
        if (value == null || typeof value !== 'object') return ''
        value = (value as Record<string, unknown>)[key ?? index]
    }
    return value == null || typeof value === 'object' ? '' : String(value)
}

function evaluateCondition(condition: string): boolean {
    const operand = (text: string) => text.trim().replace(/^(['"])(.*)\1$/, '$2')
    return condition.split('||').some(part => part.split('&&').every((atom) => {
        const match = /^\s*(.+?)\s*(===|!==|==|!=|<=|>=|<|>)\s*(.+?)\s*$/.exec(atom)
        // A condition that cannot be read keeps its content
        if (!match) return atom.trim() !== 'false'
        const [left, right] = [operand(match[1]), operand(match[3])]
        const numbers = [Number(left), Number(right)]
        const numeric = left !== '' && right !== '' && numbers.every(Number.isFinite)
        const [a, b] = numeric ? numbers : [left, right]
        switch (match[2]) {
            case '===': case '==': return a === b
            case '!==': case '!=': return a !== b
            case '<': return a < b
            case '>': return a > b
            case '<=': return a <= b
            default: return a >= b
        }
    }))
}

function resolveConditions(body: string): string {
    return body.replaceAll(/\{#if\s+([^}\n]*)\}([\s\S]*?)(?:\{:else\}([\s\S]*?))?\{\/if\}/g, (_, condition: string, yes: string, no = '') => evaluateCondition(condition) ? yes : no)
}

/** Repeats the loops of `block`, the text from the first `{#each` to its `{/each}` */
function expandEach(block: string, indent: number): string {
    const open = /^\{#each\s+/.exec(block)
    const arrayStart = open ? open[0].length : -1
    const arrayEnd = arrayStart < 0 ? -1 : skipArray(block, arrayStart)
    const header = arrayEnd < 0 ? null : /^\s+as\s+(\w+)(?:\s*,\s*(\w+))?\s*\}/.exec(block.slice(arrayEnd))
    if (!header) return ''

    let items: unknown
    try {
        items = JSON.parse(block.slice(arrayStart, arrayEnd).replaceAll(/,\s*([\]}])/g, '$1'))
    }
    catch {
        return ''
    }
    if (!Array.isArray(items)) return ''

    const [, itemName, indexName] = header
    // The body sits one level inside the loop, which is not a level of its own
    const bodyLines = block.slice(arrayEnd + header[0].length, block.lastIndexOf('{/each}')).split('\n')
    const bodyIndent = Math.min(Infinity, ...bodyLines.filter(line => line.trim()).map(line => line.length - line.trimStart().length))
    const shift = Number.isFinite(bodyIndent) ? Math.max(0, bodyIndent - indent) : 0
    const body = bodyLines.map(line => line.slice(Math.min(shift, line.length - line.trimStart().length))).join('\n')

    return items.map((item, index) => {
        const filled = body
            .replaceAll(new RegExp(`\\{${itemName}((?:\\[\\d+\\]|\\.\\w+)*)\\}`, 'g'), (_, path: string) => path ? lookup(item, path) : typeof item === 'object' ? '' : String(item))
            .replaceAll(indexName ? new RegExp(`\\{${indexName}\\}`, 'g') : /(?!)/g, String(index))
        // The loop variable in a condition stands for its value
        const withValues = filled.replaceAll(/\{#if\s+([^}\n]*)\}/g, (_, condition: string) => `{#if ${indexName ? condition.replaceAll(new RegExp(`\\b${indexName}\\b`, 'g'), String(index)) : condition}}`)
        return resolveConditions(withValues)
    }).join('\n')
}

/** Lines of `lines` from `start` to the `{/each}` that closes the loop opened there */
function eachBlockEnd(lines: string[], start: number): number {
    let depth = 0
    for (let i = start; i < lines.length; i++) {
        depth += (lines[i].match(EACH_OPEN) ?? []).length - (lines[i].match(EACH_CLOSE) ?? []).length
        if (depth <= 0) return i
    }
    return lines.length - 1
}

const FenceRegex = /^( {0,3})(`{3,}|~{3,})(.*)$/
const FenceCloseRegex = /^ {0,3}(`{3,}|~{3,})[ \t]*$/

/**
 * Moves each `<CodeBlock>` into a fenced block, drops the `{@body …}` state
 * lines and takes the layout indentation off the lines. Fenced blocks of the
 * answer are copied as they are.
 */
function prepare(markup: string): string {
    const lines = markup.split('\n')
    const out: string[] = []
    let depth = 0
    let i = 0

    while (i < lines.length) {
        const line = lines[i]

        const fence = FenceRegex.exec(line)
        if (fence && !(fence[2][0] === '`' && fence[3].includes('`'))) {
            let end = i + 1
            while (end < lines.length) {
                const close = FenceCloseRegex.exec(lines[end])
                if (close && close[1][0] === fence[2][0] && close[1].length >= fence[2].length) break
                end++
            }
            end = Math.min(end, lines.length - 1)
            out.push(...lines.slice(i, end + 1))
            i = end + 1
            continue
        }

        const codeBlock = /^\s*<CodeBlock\b([^>]*)>(.*)$/.exec(line)
        if (codeBlock) {
            // The block ends at its closing tag. A model that wrote ``` where the
            // tag belongs ends it at that line, or the text ends it.
            const body: string[] = []
            let end = i
            let text = codeBlock[2]
            // A fence of the content, such as the example in a markdown block, is the content's own
            let inner: string | null = null
            for (;;) {
                const closeAt = text.indexOf('</CodeBlock>')
                if (closeAt !== -1) {
                    body.push(text.slice(0, closeAt))
                    break
                }
                if (end > i) {
                    const innerClose = FenceCloseRegex.exec(text)
                    if (inner) {
                        if (innerClose && innerClose[1][0] === inner[0] && innerClose[1].length >= inner.length) inner = null
                    }
                    else if (innerClose) {
                        break
                    }
                    else {
                        const innerOpen = FenceRegex.exec(text)
                        if (innerOpen && !(innerOpen[2][0] === '`' && innerOpen[3].includes('`'))) inner = innerOpen[2]
                    }
                }
                body.push(text)
                if (end + 1 >= lines.length) break
                end++
                text = lines[end]
            }
            // The tag may leave an empty first line and last line
            while (body.length > 0 && body[0].trim() === '') body.shift()
            while (body.length > 0 && body[body.length - 1].trim() === '') body.pop()
            const { language = '' } = attributesOf(codeBlock[1])
            out.push('', codeFence(body.join('\n'), language), '')
            i = end + 1
            continue
        }

        if (/^\s*\{#each\s/.test(line)) {
            // The loop becomes lines, which are read again like the rest of the text
            const end = eachBlockEnd(lines, i)
            lines.splice(i, end - i + 1, ...expandEach(lines.slice(i, end + 1).join('\n').trim(), line.length - line.trimStart().length).split('\n'))
            continue
        }

        if (/^\s*\{@\w+[^\n]*\}\s*$/.test(line)) {
            i++
            continue
        }

        const indent = line.length - line.trimStart().length
        out.push(line.slice(Math.min(indent, depth * 2)))
        for (const [, closing, name, , selfClosing] of line.matchAll(TagRegex)) {
            if (!LAYOUT_TAGS.has(name.toLowerCase()) || selfClosing) continue
            depth = Math.max(0, depth + (closing ? -1 : 1))
        }
        i++
    }

    return out.join('\n')
}

/**
 * Loops, conditions and template strings are worked out when ChatGPT draws
 * the answer. The Markdown version it stores leaves out what they produce.
 */
export function hasRuntimeTemplates(markup: string): boolean {
    return /\{#(?:each|if)\s|<text\b[^>]*>\s*\{`/.test(markup)
}

/** `<text preserveWhitespace>{`...`}</text>` holds text that keeps its lines, such as a file tree */
const TemplateTextRegex = /<text\b([^>]*)>\s*\{`([\s\S]*?)`\}\s*<\/text>/g

function expandTemplateText(text: string): string {
    return text.replace(TemplateTextRegex, (_, attributes: string, content: string) => {
        return /\bpreserveWhitespace\b/.test(attributes) ? `\n\n${codeFence(content)}\n\n` : content
    })
}

/** The markdown of an answer written as markup. */
export function dilToMarkdown(markup: string): string {
    const converted = mapOutsideCode(prepare(expandTemplateText(markup)), text => text.replace(TagRegex, convertTag))

    return converted
        .replaceAll(/[ \t]+$/gm, '')
        .replaceAll(/\n{3,}/g, '\n\n')
        .trim()
}
