// Inline code keeps its backslashes and dollar signs. A span opens and closes
// with the same run of backticks, so ``a`b`` is one span.
const InlineCodeRegex = /((?<!`)(`+)(?!`)[^\n]*?(?<!`)\2(?!`))/

// A fenced code block opens with 3+ backticks or tildes and closes with a
// line of the same character that is at least as long, so a ```` block can
// hold a ``` block. A fence can sit in a quote or a list.
const FenceRegex = /^[ \t]*(?:>[ \t]*)*(`{3,}|~{3,})(.*)$/
const FenceCloseRegex = /^[ \t]*(?:>[ \t]*)*(`{3,}|~{3,})[ \t]*$/

/**
 * Applies `transform` to everything outside code: fenced blocks and inline
 * code are copied as they are.
 */
export function mapOutsideCode(input: string, transform: (text: string) => string): string {
    const lines = input.split('\n')
    let result = ''
    let buffer: string[] = []

    const flush = (hasMore: boolean) => {
        if (buffer.length === 0) return
        const text = buffer.join('\n') + (hasMore ? '\n' : '')
        result += text.split(InlineCodeRegex).map((part, index) => index % 3 === 0 ? transform(part) : index % 3 === 1 ? part : '').join('')
        buffer = []
    }

    let i = 0
    while (i < lines.length) {
        const open = FenceRegex.exec(lines[i])
        // The info string of a backtick fence cannot hold a backtick
        if (!open || (open[1][0] === '`' && open[2].includes('`'))) {
            buffer.push(lines[i])
            i++
            continue
        }

        flush(true)
        const marker = open[1]
        let end = i + 1
        while (end < lines.length) {
            const close = FenceCloseRegex.exec(lines[end])
            if (close && close[1][0] === marker[0] && close[1].length >= marker.length) break
            end++
        }
        // An unclosed fence runs to the end of the text
        end = Math.min(end, lines.length - 1)
        result += lines.slice(i, end + 1).join('\n') + (end < lines.length - 1 ? '\n' : '')
        i = end + 1
    }
    flush(false)

    return result
}
