import { mapOutsideCode } from './code'

export function standardizeLineBreaks(text: string): string {
    return text
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
}

/**
 * ChatGPT stores what a user typed as markdown: a line break is a backslash
 * and a new line, so an empty line is a line of one backslash. Gives the lines
 * as typed. A backslash ends a line of text with a hard break, which is two
 * spaces. Fenced and inline code is left alone.
 */
export function decodeTypedLineBreaks(text: string): string {
    return mapOutsideCode(text, part => part
        .replace(/^[ \t]*\\$/gm, '')
        .replace(/(?<!\\)\\$/gm, '  '))
}
