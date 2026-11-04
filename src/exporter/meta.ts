import { dateStr, timestamp, unixTimestampToISOString } from '../utils/utils'
import type { ConversationResult } from '../api'
import type { ExportMeta } from '../ui/SettingContext'

export function getMetaVariables(
    { title, model, modelSlug, createTime, updateTime }: ConversationResult,
    source: string,
    date = dateStr(),
): Record<string, string> {
    return {
        title,
        date,
        timestamp: timestamp(),
        source,
        model,
        model_name: modelSlug,
        create_time: unixTimestampToISOString(createTime),
        update_time: unixTimestampToISOString(updateTime),
    }
}

/**
 * Replace every `{name}` in each meta value in a single pass, so values
 * containing `$&` or another `{name}` are inserted verbatim.
 * Unknown variables are left untouched.
 */
export function resolveMetaList(metaList: ExportMeta[] | undefined, variables: Record<string, string>) {
    return metaList
        ?.filter(x => !!x.name)
        .map(({ name, value }) => {
            const val = value.replace(/\{(\w+)\}/g, (match, key: string) => {
                return Object.hasOwn(variables, key) ? variables[key] : match
            })
            return [name, val] as const
        })
        ?? []
}

const YamlReserved = /^(?:true|false|null|yes|no|on|off|y|n|~)$/i
const YamlNumber = /^[+-]?\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?$|^0x[\da-f]+$/i

/**
 * A value is written as it is when YAML reads it back as the same string.
 * A title such as `Foo: bar`, `[Draft]` or `#1 idea` is quoted. Dates and URLs
 * stay plain.
 */
function yamlScalar(value: string): string {
    if (value === '') return value

    const plain = !/^[\s\-?:,[\]{}#&*!|>'"%@`]/.test(value)
        && !/[\n\r\t]/.test(value)
        && !value.includes(': ')
        && !value.includes(' #')
        && !/[:\s]$/.test(value)
        && !YamlReserved.test(value)
        && !YamlNumber.test(value)

    return plain ? value : JSON.stringify(value)
}

function yamlKey(name: string): string {
    return /^[\p{L}\p{N}_][\p{L}\p{N}_ .-]*$/u.test(name) && !/\s$/.test(name) && !YamlReserved.test(name)
        ? name
        : JSON.stringify(name)
}

/** The front matter block of a Markdown export, empty when there is no metadata. */
export function formatFrontMatter(metaList: ReadonlyArray<readonly [name: string, value: string]>): string {
    if (metaList.length === 0) return ''

    const lines = metaList.map(([name, value]) => `${yamlKey(name)}: ${yamlScalar(value)}`)
    return `---\n${lines.join('\n')}\n---\n\n`
}
