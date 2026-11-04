// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { ANSWER_ACTIONS_SELECTOR, getAnswerMessageIds, getLastActionButton, readButtonLook } from '../src/answerActions'

// The shape of a turn in the redesigned thread, taken from the page: one turn
// holds a block per author, the user's block carries its own action row, the
// answer's row follows the blocks.
function turn(answerIds: string, extraBlocks = '') {
    return `
<div data-talvt-turn-state="complete" class="group flex flex-col">
  <div class="flex flex-col gap-3">
    <div data-chatgpt-search-unit-key="turn-0:0:user" data-chatgpt-search-message-ids="user-1">
      <h4 data-conversation-role="user"></h4>
      <div class="user-body">
        <div class="turn-action-controls" id="user-row"><button aria-label="复制消息"></button><button aria-label="编辑消息"></button></div>
      </div>
    </div>
    <div data-chatgpt-search-unit-key="turn-0:2:assistant" data-chatgpt-search-message-ids="${answerIds}">
      <h4 data-conversation-role="assistant"></h4>
      <div class="answer-body"><button aria-label="展开图表"></button></div>
      <div data-chatgpt-search-message-ids="nested-1"><h4 data-conversation-role="assistant"></h4></div>
    </div>
    ${extraBlocks}
  </div>
  <div class="actionRow turn-action-controls" id="answer-row">
    <div class="flex">
      <button aria-label="复制"></button>
      <button aria-label="更多操作" class="Button-x outline-hidden" data-color="secondary" data-variant="ghost" data-uniform="" data-size="sm" id="radix-1" aria-haspopup="menu" aria-expanded="false" data-state="closed"><span class="ButtonInner-y"><svg></svg></span></button>
    </div>
  </div>
</div>`
}

const row = (id: string) => document.getElementById(id) as HTMLElement

describe('answer action rows', () => {
    beforeEach(() => {
        document.body.innerHTML = turn('answer-1 answer-1b')
    })

    it('finds the rows the page draws under messages', () => {
        expect(document.querySelectorAll(ANSWER_ACTIONS_SELECTOR)).toHaveLength(2)
    })

    it('gives the ids of the answer for the row under it', () => {
        expect(getAnswerMessageIds(row('answer-row'))).toEqual(['answer-1', 'answer-1b'])
    })

    it('gives none for the row under the question', () => {
        expect(getAnswerMessageIds(row('user-row'))).toEqual([])
    })

    it('gathers each block of an answer that the page splits', () => {
        document.body.innerHTML = turn('answer-1', `
    <div data-chatgpt-search-message-ids="answer-2 answer-1"><h4 data-conversation-role="assistant"></h4></div>`)
        expect(getAnswerMessageIds(row('answer-row'))).toEqual(['answer-1', 'answer-2'])
    })

    it('gives none for a row outside a turn', () => {
        document.body.innerHTML = '<div class="turn-action-controls" id="lone"></div>'
        expect(getAnswerMessageIds(row('lone'))).toEqual([])
    })
})

describe('action row buttons', () => {
    beforeEach(() => {
        document.body.innerHTML = turn('answer-1')
    })

    it('puts the new button after the last one', () => {
        expect(getLastActionButton(row('answer-row'))?.getAttribute('aria-label')).toBe('更多操作')
    })

    it('does not count its own button as the last', () => {
        const own = document.createElement('button')
        own.setAttribute('data-ce-answer-export', '')
        getLastActionButton(row('answer-row'))?.after(own)
        expect(getLastActionButton(row('answer-row'))?.getAttribute('aria-label')).toBe('更多操作')
    })

    it('copies the look of a button and nothing that makes it that button', () => {
        const look = readButtonLook(getLastActionButton(row('answer-row'))!)
        expect(look.className).toBe('Button-x outline-hidden')
        expect(look.innerClassName).toBe('ButtonInner-y')
        expect(look.attributes).toEqual({
            'data-color': 'secondary',
            'data-variant': 'ghost',
            'data-uniform': '',
            'data-size': 'sm',
        })
    })
})
