import { describe, expect, it } from 'vitest'
import { dilToMarkdown, hasRuntimeTemplates } from '../src/utils/dil'

describe('dilToMarkdown', () => {
    it('turns links and entities into text, in a table too', () => {
        expect(dilToMarkdown([
            '| Project | Home |',
            '|---|---|',
            '| <Entity category="software" value="Tool A" disambig="a tool"/> | <Link url="https://a.example/x?q=1|2" title="Docs | A"/> |',
        ].join('\n'))).toBe([
            '| Project | Home |',
            '|---|---|',
            '| Tool A | [Docs \\| A](<https://a.example/x?q=1%7C2>) |',
        ].join('\n'))
    })

    it('drops citations, images and icons', () => {
        expect(dilToMarkdown('Claim.<Cite refs={["turn1view0","turn1view1"]}/>\n\n<MemoryCite refs={["m"]}/>Next.\n\n<row><AsyncImage query="a b" aspectRatio="4:3"/><icon name="x" size="lg"/></row>'))
            .toBe('Claim.\n\nNext.')
    })

    it('puts the text of layout boxes in paragraphs and takes the indentation off', () => {
        expect(dilToMarkdown([
            '<row align="start" gap={3}>',
            '  <AsyncImage query="q" maxWidth="144px"/>',
            '  <box flex="1" gap={1}>',
            '    **Title**',
            '',
            '    <text color="secondary" size="sm">Body text.</text>',
            '    <text size="xs"><Link url="https://a.example/" title="More"/></text>',
            '  </box>',
            '</row>',
        ].join('\n'))).toBe('**Title**\n\nBody text.\n\n[More](<https://a.example/>)')
    })

    it('keeps a flow of boxes as lines', () => {
        const markdown = dilToMarkdown([
            '<box padding={2}>',
            '  <text weight="medium">PIPELINE</text>',
            '  <box radius="md">',
            '    **Start**',
            '',
            '    <caption>Read the request</caption>',
            '  </box>',
            '  <row justify="center"><icon name="arrow-down"/></row>',
            '  <box radius="md">',
            '    **Build**',
            '',
            '    <caption>Make the project</caption>',
            '    <badge color="secondary">loop</badge>',
            '  </box>',
            '  <divider color="subtle"/>',
            '</box>',
        ].join('\n'))
        expect(markdown).toBe('PIPELINE\n\n**Start**\n\nRead the request\n\n**Build**\n\nMake the project\n\n(loop)\n\n---')
    })

    it('lists the choices of a form', () => {
        const markdown = dilToMarkdown([
            '{@body const [genre,setGenre] = DIL.useState("tower")}',
            '<box gap={1}>',
            '  <title size="lg">Settings</title>',
            '  <label>Type</label>',
            '  <radio-group value={genre} onChange={setGenre}>',
            '    <radio value="tower">Tower defense</radio>',
            '    <radio value="rpg">RPG</radio>',
            '  </radio-group>',
            '  <segmented-control block value={d} onChange={setD} options={[{"label":"2D","value":"2d"},{"label":"3D","value":"3d"}]}/>',
            '  <button variant="primary">Continue</button>',
            '</box>',
        ].join('\n'))
        expect(markdown).not.toContain('DIL')
        expect(markdown).toBe('**Settings**\n\nType\n\n- Tower defense\n\n- RPG\n\n- 2D\n- 3D\n\n[Continue]')
    })

    describe('code blocks', () => {
        it('turns a CodeBlock into a fenced block', () => {
            expect(dilToMarkdown('Run:\n\n<CodeBlock language="json" editable>\n{\n  "a": 1\n}\n</CodeBlock>\n\nDone.'))
                .toBe('Run:\n\n```json\n{\n  "a": 1\n}\n```\n\nDone.')
        })

        it('uses a fence that its content cannot close', () => {
            expect(dilToMarkdown('<CodeBlock language="markdown">\n# T\n\n```js\nlet a\n```\n</CodeBlock>'))
                .toBe('````markdown\n# T\n\n```js\nlet a\n```\n````')
        })

        it('ends a block the model closed with ``` instead of the tag', () => {
            expect(dilToMarkdown('<CodeBlock language="markdown" editable>\n# Policy\n\n- one\n```\n\nText after.\n\n## Next\n\nMore.'))
                .toBe('```markdown\n# Policy\n\n- one\n```\n\nText after.\n\n## Next\n\nMore.')
        })

        it('ends a block that is never closed at the end of the text', () => {
            expect(dilToMarkdown('Intro.\n\n<CodeBlock language="bash">\nnpm i\nnpm test')).toBe('Intro.\n\n```bash\nnpm i\nnpm test\n```')
        })

        it('does not change tags inside a fenced block or inline code', () => {
            const text = 'Use `<Cite refs={[]}/>` here.\n\n```html\n<box>\n  <Link url="x" title="y"/>\n</box>\n```\n\n<text>After</text>'
            expect(dilToMarkdown(text)).toBe('Use `<Cite refs={[]}/>` here.\n\n```html\n<box>\n  <Link url="x" title="y"/>\n</box>\n```\n\nAfter')
        })
    })

    describe('loops and conditions', () => {
        const stages = [
            '<box gap={2}>',
            '  {#each [',
            '    ["01","Clarify","Theme, genre"],',
            '    ["02","Design","Rules, art"],',
            '    ["03","Release","Pack, deploy"]',
            '  ] as item,i}',
            '    <row align="center">',
            '      <text>{item[0]}</text>',
            '      <box flex="1">',
            '        **{item[1]}**',
            '        <text size="sm">{item[2]}</text>',
            '      </box>',
            '      {#if i===0 || i===2}',
            '        <icon name="user"/>',
            '      {:else}',
            '        <icon name="bot"/>',
            '      {/if}',
            '    </row>',
            '  {/each}',
            '  <caption>Icons mark the steps.</caption>',
            '</box>',
        ].join('\n')

        it('repeats the body of a loop for each element', () => {
            expect(dilToMarkdown(stages)).toBe('01\n\n**Clarify**\n\nTheme, genre\n\n02\n\n**Design**\n\nRules, art\n\n03\n\n**Release**\n\nPack, deploy\n\nIcons mark the steps.')
        })

        it('keeps the text of the branch that applies', () => {
            const markdown = dilToMarkdown('{#each ["a","b","c"] as name,n}\n{#if n===1}\nmiddle {name}\n{:else}\nedge {name} {n}\n{/if}\n{/each}')
            expect(markdown).toBe('edge a 0\n\nmiddle b\n\nedge c 2')
        })

        it('reads the fields of objects', () => {
            expect(dilToMarkdown('{#each [{"k":"x","v":1},{"k":"y","v":2}] as row}\n<text>{row.k}={row.v}</text>\n{/each}')).toBe('x=1\n\ny=2')
        })

        it('drops a loop it cannot read instead of printing its source', () => {
            const markdown = dilToMarkdown('Before.\n\n{#each items as item}\n<text>{item}</text>\n{/each}\n\nAfter.')
            expect(markdown).toBe('Before.\n\nAfter.')
        })

        it('does not touch a loop that is shown as code', () => {
            const code = '```svelte\n{#each list as x}\n  <li>{x}</li>\n{/each}\n```'
            expect(dilToMarkdown(code)).toBe(code)
            expect(dilToMarkdown('<CodeBlock language="svelte">\n{#each list as x}\n  <li>{x}</li>\n{/each}\n</CodeBlock>')).toBe('```svelte\n{#each list as x}\n  <li>{x}</li>\n{/each}\n```')
        })
    })

    describe('template strings', () => {
        it('keeps the lines of text that preserves its whitespace', () => {
            expect(dilToMarkdown('<box>\n  **dist/**\n  <text size="xs" preserveWhitespace>{`├── index.html\n├── assets/\n│   └── a.js\n└── ...`}</text>\n</box>'))
                .toBe('**dist/**\n\n```\n├── index.html\n├── assets/\n│   └── a.js\n└── ...\n```')
        })

        it('keeps other template strings as text', () => {
            expect(dilToMarkdown('<text>{`one line`}</text>')).toBe('one line')
        })
    })

    it('knows which markup holds loops, conditions or template strings', () => {
        expect(hasRuntimeTemplates('{#each [1] as x}\n{/each}')).toBe(true)
        expect(hasRuntimeTemplates('{#if a===1}x{/if}')).toBe(true)
        expect(hasRuntimeTemplates('<text>{`x`}</text>')).toBe(true)
        expect(hasRuntimeTemplates('<box><text>plain</text></box>\n\nUse {name} here.')).toBe(false)
    })

    it('keeps text that only looks like a tag', () => {
        expect(dilToMarkdown('Open `playground/<game-slug>` or <details>x</details> with <br> 1 < 2')).toBe('Open `playground/<game-slug>` or <details>x</details> with <br> 1 < 2')
        expect(dilToMarkdown('Start the <game-slug> project')).toBe('Start the <game-slug> project')
    })

    it('leaves plain markdown as it is', () => {
        const markdown = '# Title\n\nText with **bold**.\n\n- a\n- b\n\n> quote'
        expect(dilToMarkdown(markdown)).toBe(markdown)
    })
})
