import { describe, expect, it } from 'vitest'
import { protectMath, toBracketDelimiters } from '../src/utils/latex'
import { fromMarkdown, toHtml, toMarkdown } from '../src/utils/markdown'
import { escapeHtml } from '../src/exporter/htmlTemplate'

// Same steps as the markdown exporter
function format(input: string) {
    const { text, restore } = protectMath(input)
    return restore(toMarkdown(fromMarkdown(text), text))
}

describe('math in markdown export', () => {
    it('puts display math between `$$` lines (#281)', () => {
        expect(format('Softmax:\n\n\\[\np_i = \\frac{e^{z_i}}{\\sum_j e^{z_j}}\n\\]\n\nDone.'))
            .toBe('Softmax:\n\n$$\np_i = \\frac{e^{z_i}}{\\sum_j e^{z_j}}\n$$\n\nDone.\n')
        expect(format('\\[ a_1 * b_1 \\]'))
            .toBe('$$\na_1 * b_1\n$$\n')
    })

    it('keeps inline math intact', () => {
        expect(format('Here \\(h_1\\) and \\( z * 2 \\) are vectors, and $$x_1$$ too.'))
            .toBe('Here $h_1$ and $z * 2$ are vectors, and $$x_1$$ too.\n')
    })

    it('leaves code untouched', () => {
        const input = 'Match brackets:\n\n```js\nconst re = /\\[(\\d+)\\]/\n```\n\nor `\\(x\\)` inline, then \\(y_1\\).'
        expect(format(input))
            .toBe('Match brackets:\n\n```js\nconst re = /\\[(\\d+)\\]/\n```\n\nor `\\(x\\)` inline, then $y_1$.\n')
    })

    it('leaves prices alone', () => {
        expect(format('| NT$1,000 | **NT$2,500** |\n| --- | --- |\n| a | b |'))
            .toBe('| NT$1,000 | **NT$2,500** |\n| -------- | ------------ |\n| a        | b            |\n')
    })
})

// Same steps as the HTML exporter
function formatHtml(input: string) {
    const { text, restore } = protectMath(input)
    return restore(toHtml(text), formula => escapeHtml(toBracketDelimiters(formula)))
}

describe('math in HTML export', () => {
    it('keeps multi-line display math intact (#264)', () => {
        expect(formatHtml('Sum:\n\n\\[\n\\begin{aligned}\nS\n&= a\\,b \\\\\n=\nc\n\\end{aligned}\n\\]\n\nDone.'))
            .toBe('<p>Sum:</p>\n<p>\\[\n\\begin{aligned}\nS\n&amp;= a\\,b \\\\\n=\nc\n\\end{aligned}\n\\]</p>\n<p>Done.</p>')
    })

    it('keeps math outside code in a message that has code', () => {
        expect(formatHtml('Then \\(x_1\\):\n\n```\n\\[a\\]\n```'))
            .toBe('<p>Then \\(x_1\\):</p>\n<pre><code>\\[a\\]\n</code></pre>')
    })

    it('escapes HTML inside formulas', () => {
        expect(formatHtml('\\(a<b\\)')).toBe('<p>\\(a&lt;b\\)</p>')
    })

    it('marks only recognized math for KaTeX', () => {
        expect(formatHtml('Plans cost $5 and $10, and $x^2$ grows.'))
            .toBe('<p>Plans cost $5 and $10, and \\(x^2\\) grows.</p>')
        expect(formatHtml('Also $$E = mc^2$$ here.'))
            .toBe('<p>Also \\[E = mc^2\\] here.</p>')
    })
})

describe('code regions', () => {
    const regex = String.raw`const re = /\[(.+?)\]\((.+?)\)/g`

    it('keeps a fence that sits inside a longer fence', () => {
        const input = `\`\`\`\`markdown\n# Template\n\n\`\`\`js\n${regex}\n\`\`\`\n\`\`\`\`\n\nAfter \\(x\\).`
        expect(protectMath(input).text).toBe(`\`\`\`\`markdown\n# Template\n\n\`\`\`js\n${regex}\n\`\`\`\n\`\`\`\`\n\nAfter ╬0╬.`)
    })

    it('keeps tilde fences, fences in a quote and fences that never close', () => {
        expect(protectMath(`~~~\n${regex}\n~~~`).text).toBe(`~~~\n${regex}\n~~~`)
        expect(protectMath(`> \`\`\`\n> ${regex}\n> \`\`\``).text).toBe(`> \`\`\`\n> ${regex}\n> \`\`\``)
        expect(protectMath(`\`\`\`js\n${regex}\n\nstill code \\(x\\)`).text).toBe(`\`\`\`js\n${regex}\n\nstill code \\(x\\)`)
    })

    it('keeps inline code that is written with several backticks', () => {
        expect(protectMath('Use ``a \\(b\\) ` c`` and \\(d\\).').text).toBe('Use ``a \\(b\\) ` c`` and ╬0╬.')
    })

    it('reads math before and after a code block', () => {
        expect(protectMath('\\(a\\)\n\n```\n\\(b\\)\n```\n\n\\(c\\)').text).toBe('╬0╬\n\n```\n\\(b\\)\n```\n\n╬1╬')
    })
})

describe('dollar signs', () => {
    it('does not take prices for math', () => {
        for (const input of ['Costs $5 to $10 today.', 'Between $5 and $10, or $ 20.', 'Costs $5, then $ 7 more.']) {
            expect(protectMath(input).text).toBe(input)
        }
    })

    it('still reads $x$ as math', () => {
        expect(protectMath('So $x$ and $a + b$ hold.').text).toBe('So ╬0╬ and ╬1╬ hold.')
    })
})
