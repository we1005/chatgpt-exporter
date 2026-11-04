// Where the answer download button goes. The page keeps no stable test ids
// for its action rows, so this reads the structure of the redesigned thread:
// a turn holds a message block per author (`data-chatgpt-search-message-ids`),
// the user's block carries its own action row, and the answer's row follows
// the blocks as a child of the turn.

// Added 2026-10-30.
export const ANSWER_ACTIONS_SELECTOR = '[data-talvt-turn-state] .turn-action-controls'
const MESSAGE_BLOCK_SELECTOR = '[data-chatgpt-search-message-ids]'
const ASSISTANT_ROLE_SELECTOR = '[data-conversation-role="assistant"]'

/** The ids of the message blocks the answer of this action row is made of, none for any other row */
export function getAnswerMessageIds(actions: Element): string[] {
    // The user's message has an action row inside its own block
    if (actions.closest(MESSAGE_BLOCK_SELECTOR)) return []

    const turn = actions.closest('[data-talvt-turn-state]')
    if (!turn) return []

    const ids: string[] = []
    turn.querySelectorAll(MESSAGE_BLOCK_SELECTOR).forEach((block) => {
        if (!block.querySelector(`:scope > ${ASSISTANT_ROLE_SELECTOR}`)) return
        // Blocks nest, the outermost one lists the ids of the answer
        if (block.parentElement?.closest(MESSAGE_BLOCK_SELECTOR)) return
        ids.push(...(block.getAttribute('data-chatgpt-search-message-ids') ?? '').split(/\s+/).filter(Boolean))
    })
    return [...new Set(ids)]
}

/**
 * The button the new one goes after, the last of the row. It is a button of
 * the design system, so the new one copies its look.
 */
export function getLastActionButton(actions: Element): HTMLButtonElement | null {
    const buttons = actions.querySelectorAll<HTMLButtonElement>('button:not([data-ce-answer-export])')
    return buttons.item(buttons.length - 1)
}

export interface ButtonLook {
    className: string
    innerClassName: string
    attributes: Record<string, string>
}

/** The class names and design-system attributes of `button`, not its identity or menu state */
export function readButtonLook(button: HTMLButtonElement): ButtonLook {
    const attributes: Record<string, string> = {}
    for (const { name, value } of Array.from(button.attributes)) {
        if (name.startsWith('data-') && name !== 'data-state') attributes[name] = value
    }
    return {
        className: button.className,
        innerClassName: button.firstElementChild?.className ?? '',
        attributes,
    }
}
