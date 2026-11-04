import { describe, expect, it } from 'vitest'
import { codeFence, fromMarkdown, isLocalImageSrc, plainTextToMarkdown, toHtml, toMarkdown } from '../src/utils/markdown'

function format(input: string) {
    return toMarkdown(fromMarkdown(input), input)
}

describe('markdown re-serialization', () => {
    it('normalizes block syntax', () => {
        expect(format('Title\n=====\n\n_a_ and __b__\n\n***\n\n~~~\ncode\n~~~'))
            .toBe('# Title\n\n*a* and **b**\n\n---\n\n```\ncode\n```\n')
    })

    it('keeps text as written instead of escaping it', () => {
        expect(format('snake_case and [brackets] and 1 * 2 and #tag'))
            .toBe('snake_case and [brackets] and 1 * 2 and #tag\n')
    })

    it('keeps character references', () => {
        expect(format('&lt;div&gt; &amp; &copy;')).toBe('&lt;div&gt; &amp; &copy;\n')
    })

    it('keeps trailing-space line breaks (#300)', () => {
        expect(format('one  \ntwo')).toBe('one  \ntwo\n')
    })

    it('does not repeat container prefixes on continuation lines', () => {
        expect(format('> first line\n> second line')).toBe('> first line\n> second line\n')
        expect(format('- item\n  continued')).toBe('- item\n  continued\n')
    })

    it('aligns tables by display width', () => {
        expect(format('| 名稱 | n |\n| --- | --- |\n| 蘋果 | 1 |\n| apple | 2 |'))
            .toBe('| 名稱  | n |\n| ----- | - |\n| 蘋果  | 1 |\n| apple | 2 |\n')
    })
})

describe('markdown options', () => {
    const run = (input: string, options: Parameters<typeof toMarkdown>[2]) => toMarkdown(fromMarkdown(input), input, options)

    it('pushes headings down and stops at level 6', () => {
        expect(run('# a\n\n## b\n\n#### c\n\n###### d', { headingOffset: 2 })).toBe('### a\n\n#### b\n\n###### c\n\n###### d\n')
    })

    it('drops remote images and keeps data uris and relative paths', () => {
        const input = 'a ![x](https://e.example/a.png) b ![y](data:image/png;base64,AAA) c ![z](assets/z.png) d ![w](//e.example/w.png)'
        expect(run(input, { dropRemoteImages: true })).toBe('a  b ![y](data:image/png;base64,AAA) c ![z](assets/z.png) d \n')
    })

    it('drops a link or paragraph that held only a remote image', () => {
        expect(run('before\n\n[![alt](https://e.example/a.png)](https://page.example/)\n\n![alt][ref]\n\nafter\n\n[ref]: https://e.example/r.png', { dropRemoteImages: true }))
            .toBe('before\n\nafter\n\n[ref]: https://e.example/r.png\n')
        expect(run('[![alt](https://e.example/a.png) caption](https://page.example/)', { dropRemoteImages: true }))
            .toBe('[ caption](https://page.example/)\n')
    })

    it('drops img tags that load from a URL', () => {
        expect(run('<img src="https://e.example/a.png" alt="x">\n\ntext <img src=\'//e.example/b.png\'> here', { dropRemoteImages: true }))
            .toBe('text  here\n')
    })

    it('tells local images from remote ones', () => {
        expect(['data:image/png;base64,AA', 'assets/a.png', './a.png', 'a.png'].map(isLocalImageSrc)).toEqual([true, true, true, true])
        expect(['https://a/b.png', 'http://a/b.png', '//a/b.png', 'sediment://x', 'file-service://x'].map(isLocalImageSrc)).toEqual([false, false, false, false, false])
    })
})

describe('code fences', () => {
    it('uses a fence longer than any backtick run in the text', () => {
        expect(codeFence('plain')).toBe('```\nplain\n```')
        expect(codeFence('a\n```\nb\n```')).toBe('````\na\n```\nb\n```\n````')
        expect(codeFence('x ````` y', 'js')).toBe('``````js\nx ````` y\n``````')
    })
})

describe('plain text as markdown', () => {
    it('does not turn what was typed into structure', () => {
        expect(plainTextToMarkdown('# not a heading\n> not a quote\n```\nnever closed')).toBe('\\# not a heading  \n\\> not a quote  \n\\```  \nnever closed')
        expect(plainTextToMarkdown('Title\n=====\n\n---\n***')).toBe('Title  \n\\=====\n\n\\---  \n\\***')
        expect(plainTextToMarkdown('<div>x</div> and <!-- c --> but 1 < 2')).toBe('\\<div>x\\</div> and \\<!-- c --> but 1 < 2')
    })

    it('keeps a fenced block that closes, and the line breaks', () => {
        expect(plainTextToMarkdown('first\nsecond\n\n```js\nlet a = 1\n# not a heading\n```\nafter'))
            .toBe('first  \nsecond\n\n```js\nlet a = 1\n# not a heading\n```\nafter')
    })

    it('renders back as the text that was typed', () => {
        const typed = '# heading\nline one\nline two\n```\nopen'
        const html = toHtml(plainTextToMarkdown(typed))
        expect(html).toBe('<p># heading<br />\nline one<br />\nline two<br />\n```<br />\nopen</p>')
    })
})

describe('markdown to HTML', () => {
    it('keeps br, details and kbd without attributes', () => {
        expect(toHtml('a<br>b<br/>c <kbd class="x" onclick="y()">Ctrl</kbd>')).toBe('<p>a<br>b<br>c <kbd>Ctrl</kbd></p>')
        expect(toHtml('| a | b |\n| - | - |\n| x<br>y | z |')).toContain('<td>x<br>y</td>')
        expect(toHtml('<details>\n<summary>More</summary>\nHidden text\n</details>')).toBe('<details>\n<summary>More</summary>\nHidden text\n</details>')
    })

    it('drops scripts, styles, frames and every other tag', () => {
        const html = toHtml('<script>alert(1)</script>\n\n<style>\nbody { display: none }\n</style>\n\ntext <iframe src="https://e.example"></iframe> <a href="javascript:x()">link</a> <img src=x onerror=y()> <svg onload=z()><circle/></svg>done')
        expect(html.trim()).toBe('<p>text  link  done</p>')
    })

    it('drops the content of a multi-line script', () => {
        expect(toHtml('<script>\nalert(1)\n</script>\nafter\n').trim()).toBe('<p>after</p>')
        expect(toHtml('<div>\n<script>\nalert(1)\n</script>\nvisible\n</div>').trim()).toBe('visible')
    })

    it('escapes stray angle brackets from raw html', () => {
        expect(toHtml('<div>1 > 0 &amp; 2 & 3</div>')).toBe('1 &gt; 0 &amp; 2 &amp; 3')
    })

    it('wraps tables so a wide one scrolls', () => {
        expect(toHtml('| a | b |\n| - | - |\n| 1 | 2 |')).toMatch(/^<div class="table-wrap"><table>[\s\S]*<\/table><\/div>$/)
        // Code is escaped, a table in it is shown as text
        expect(toHtml('```html\n<table></table>\n```')).not.toContain('table-wrap')
    })

    it('marks mermaid blocks for the page to draw', () => {
        expect(toHtml('```mermaid\nflowchart TD\n  A --> B\n```'))
            .toBe('<pre class="mermaid-source"><code class="language-mermaid nohighlight">flowchart TD\n  A --&gt; B\n</code></pre>')
        expect(toHtml('```js\nlet a\n```')).toBe('<pre><code class="language-js">let a\n</code></pre>')
    })
})
