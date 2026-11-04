import { micromark } from 'micromark'
import { fromMarkdown as fm } from 'mdast-util-from-markdown'
import { gfmFromMarkdown, gfmToMarkdown } from 'mdast-util-gfm'
import { toMarkdown as tm } from 'mdast-util-to-markdown'
import { gfm, gfmHtml } from 'micromark-extension-gfm'
import type { Content, Parent, Root } from 'mdast'
import type { HtmlExtension } from 'micromark-extension-gfm'
import type { Node } from 'unist'

// ref: https://github.com/rxliuli/mdbook/blob/master/libs/markdown-util

export function fromMarkdown(content: string): Root {
    return fm(content, {
        extensions: [gfm()],
        mdastExtensions: [gfmFromMarkdown()],
    })
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const WIDE = /[\p{Extended_Pictographic}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303F\uFF01-\uFF60\uFFE0-\uFFE6]/u

/** Width in a monospace font, so tables line up with CJK text and emoji. */
function displayWidth(value: string): number {
    let width = 0
    for (const { segment } of graphemes.segment(value)) width += WIDE.test(segment) ? 2 : 1
    return width
}

/**
 * Re-serializes a tree parsed from `source` in one consistent style: ATX
 * headings, `*` emphasis, backtick fences, `---` rules and aligned tables.
 *
 * Text and line breaks are copied from `source` as written. The default
 * handlers would escape characters like `_` and `[`, decode entities, and
 * turn trailing-space line breaks into backslashes.
 */
export interface ToMarkdownOptions {
    /** Levels to push every heading down, so they sit below the role headings of an export */
    headingOffset?: number
    /** Drop images that are loaded from a URL, keep `data:` and relative ones */
    dropRemoteImages?: boolean
}

/** `data:` URIs and relative paths belong to the export, anything else is loaded from a server */
export function isLocalImageSrc(src: string): boolean {
    return !/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(src.trim()) || /^data:/i.test(src.trim())
}

const ImgTagRegex = /<img\b[^>]*>/gi

function srcOfImgTag(tag: string): string {
    return /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag)?.slice(1).find(x => x != null) ?? ''
}

/**
 * Applies `options` to the tree. A link or paragraph that held nothing but
 * dropped images goes with them.
 */
function rewriteTree(node: any, options: ToMarkdownOptions): any[] {
    if (node.type === 'heading' && options.headingOffset) {
        node.depth = Math.min(6, node.depth + options.headingOffset) as typeof node.depth
    }

    if (options.dropRemoteImages) {
        if (node.type === 'image' && !isLocalImageSrc(node.url)) return []
        // The image of a reference is defined elsewhere, it cannot be told from here
        if (node.type === 'imageReference') return []
        if (node.type === 'html') {
            const value = node.value.replace(ImgTagRegex, (tag: string) => isLocalImageSrc(srcOfImgTag(tag)) ? tag : '')
            if (value !== node.value) {
                if (!value.trim()) return []
                node.value = value
            }
        }
    }

    if (Array.isArray(node.children)) {
        const before = node.children.length
        node.children = node.children.flatMap((child: any) => rewriteTree(child, options))
        if (node.children.length < before && node.children.length === 0 && ['link', 'paragraph', 'emphasis', 'strong', 'delete'].includes(node.type)) return []
    }
    return [node]
}

export function toMarkdown(ast: Content | Root, source: string, options: ToMarkdownOptions = {}): string {
    if (options.headingOffset || options.dropRemoteImages) rewriteTree(ast, options)

    const slice = (node: Node) => {
        const start = node.position!.start.offset!
        let end = node.position!.end.offset!
        // from-markdown 1.x ends a text node before the `;` of a trailing character reference
        if (source[end] === ';' && /&(?:#x?[\da-f]+|\w+)$/i.test(source.slice(start, end))) end++
        return source.slice(start, end)
    }
    return tm(ast, {
        bullet: '-',
        bulletOther: '*',
        bulletOrdered: '.',
        emphasis: '*',
        fence: '`',
        fences: true,
        listItemIndent: 'one',
        resourceLink: false,
        rule: '-',
        ruleRepetition: 3,
        ruleSpaces: false,
        strong: '*',
        extensions: [gfmToMarkdown({ stringLength: displayWidth })],
        handlers: {
            // Continuation lines hold the container prefix (`> `, list indent),
            // which the container handlers add back. A paragraph line never
            // starts with whitespace or `>`, so strip those.
            text: node => node.position
                ? slice(node).split('\n').map((line, i) => i ? line.replace(/^[ \t>]*/, '') : line).join('\n')
                : node.value,
            break: node => node.position ? slice(node) : '  \n',
        },
    })
}

// Raw HTML in the markdown is the model's, or the user's if a tool message holds
// an uploaded page. Only these tags are kept, without attributes. Every other
// tag is dropped and so is the content of the ones that hold code or embedded
// documents, so an exported page cannot run a script or restyle itself.
// ChatGPT writes <br> in tables and <details> or <kbd> in answers.
const KEPT_TAGS = new Set(['br', 'details', 'summary', 'kbd', 'sub', 'sup', 'mark', 'u'])
const DROPPED_CONTENT_TAGS = new Set(['script', 'style', 'iframe', 'object', 'embed', 'template', 'noscript', 'textarea', 'title', 'svg', 'math', 'head'])
const HtmlPieceRegex = /<!--[\s\S]*?-->|<(\/?)([a-z][a-z\d-]*)(?:\s[^>]*)?(\/?)>|[^<]+|</gi

function sanitizeRawHtml(raw: string, state: { dropping: string | null }): string {
    let out = ''
    for (const [piece, closing, name, selfClosing] of raw.matchAll(HtmlPieceRegex)) {
        if (piece.startsWith('<!--')) continue

        if (name) {
            const tag = name.toLowerCase()
            if (state.dropping) {
                if (closing && tag === state.dropping) state.dropping = null
                continue
            }
            if (DROPPED_CONTENT_TAGS.has(tag)) {
                if (!closing && !selfClosing) state.dropping = tag
                continue
            }
            if (KEPT_TAGS.has(tag)) out += closing ? `</${tag}>` : `<${tag}>`
            continue
        }

        if (state.dropping) continue
        out += piece === '<' ? '&lt;' : piece.replace(/&(?!#?\w+;)/g, '&amp;').replace(/>/g, '&gt;')
    }
    return out
}

const safeRawHtml: HtmlExtension = {
    enter: {
        htmlFlow() {
            this.setData('rawHtmlState', { dropping: null })
        },
        htmlText() {
            if (!this.getData('rawHtmlState')) this.setData('rawHtmlState', { dropping: null })
        },
    },
    exit: {
        htmlFlowData(token) {
            this.raw(sanitizeRawHtml(this.sliceSerialize(token), this.getData('rawHtmlState') as { dropping: string | null }))
        },
        htmlTextData(token) {
            this.raw(sanitizeRawHtml(this.sliceSerialize(token), this.getData('rawHtmlState') as { dropping: string | null }))
        },
    },
}

/**
 * Compiles markdown straight to HTML, without building a syntax tree.
 * URLs with protocols other than http(s), mailto, irc and xmpp are dropped,
 * raw HTML is reduced to a few harmless tags. Tables get a scrolling wrapper
 * and mermaid code blocks are marked for the page to draw.
 */
export function toHtml(markdown: string): string {
    return micromark(markdown, {
        extensions: [gfm()],
        htmlExtensions: [gfmHtml(), safeRawHtml],
    })
        // Code is escaped, so these tags are never part of a code block
        .replaceAll('<table>', '<div class="table-wrap"><table>')
        .replaceAll('</table>', '</table></div>')
        .replaceAll('<pre><code class="language-mermaid">', '<pre class="mermaid-source"><code class="language-mermaid nohighlight">')
}

/** A fenced code block, long enough that the text cannot close it. */
export function codeFence(text: string, language = ''): string {
    const longest = Math.max(0, ...Array.from(text.matchAll(/`+/g), match => match[0].length))
    const fence = '`'.repeat(Math.max(3, longest + 1))
    return `${fence}${language}\n${text}\n${fence}`
}

/**
 * Writes plain text so that it shows as typed. ChatGPT shows what you typed
 * without reading it as markdown, so a `#` line must not become a heading and
 * a lone ``` must not swallow the rest of the document. Fenced blocks that
 * close are left alone, and lines end with a break so they stay lines.
 */
export function plainTextToMarkdown(text: string): string {
    const lines = text.split('\n')
    const fenceOpen = /^( {0,3})(`{3,}|~{3,})(.*)$/
    const fenceClose = /^ {0,3}(`{3,}|~{3,})[ \t]*$/

    const escapeLine = (line: string) => line
        .replace(/^( {0,3})(#{1,6})(?=\s|$)/, '$1\\$2')
        .replace(/^( {0,3})>/, '$1\\>')
        .replace(/^( {0,3})(`{3,}|~{3,})/, '$1\\$2')
        .replace(/^( {0,3})(?=(?:-\s*){2,}$|(?:=\s*)+$|(?:\*\s*){3,}$|(?:_\s*){3,}$)/, '$1\\')
        .replace(/<(?=[a-z/!?])/gi, '\\<')

    const result: string[] = []
    let i = 0
    while (i < lines.length) {
        const open = fenceOpen.exec(lines[i])
        const isFence = open && !(open[2][0] === '`' && open[3].includes('`'))
        let end = -1
        if (isFence) {
            for (let j = i + 1; j < lines.length; j++) {
                const close = fenceClose.exec(lines[j])
                if (close && close[1][0] === open[2][0] && close[1].length >= open[2].length) {
                    end = j
                    break
                }
            }
        }

        if (isFence && end !== -1) {
            result.push(...lines.slice(i, end + 1))
            i = end + 1
            continue
        }

        const line = escapeLine(lines[i])
        const continues = i + 1 < lines.length && lines[i].trim() !== '' && lines[i + 1].trim() !== ''
        result.push(continues && !line.endsWith('  ') ? `${line}  ` : line)
        i++
    }
    return result.join('\n')
}

export function flatMap<T extends Node>(
    tree: T,
    fn: (node: Node, i: number, parent?: Parent) => Node[],
): T {
    function transform(node: Node, i: number, parent?: Parent): Node[] {
        if ('children' in node) {
            const p = node as unknown as Parent
            p.children = p.children.flatMap((item, i) => transform(item, i, p)) as any
        }
        return fn(node, i, parent)
    }
    return transform(tree, 0, undefined)[0] as T
}
