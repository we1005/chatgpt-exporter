import { createPortal } from 'preact/compat'
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import { exportToHtml } from '../exporter/html'
import { exportToMarkdown } from '../exporter/markdown'
import { useTranslation } from '../i18n'
import type { ButtonLook } from '../answerActions'
import { FileCode, IconMarkdown } from './Icons'
import { MenuItem } from './MenuItem'
import { readExportSettings } from './SettingContext'

import './theme.css'
import '../style.css'

const MENU_WIDTH = 168
const MENU_GAP = 4
const VIEWPORT_PADDING = 8

interface AnswerExportProps {
    look: ButtonLook
    /** The ids of the message blocks of the answer, read when the user picks a format */
    getMessageIds: () => string[]
}

export function AnswerExport({ look, getMessageIds }: AnswerExportProps) {
    const { t } = useTranslation()

    const [open, setOpen] = useState(false)
    const buttonRef = useRef<HTMLButtonElement>(null)
    const menuRef = useRef<HTMLDivElement>(null)

    useEffect(() => {
        if (!open) return
        const onPointerDown = (e: PointerEvent) => {
            const target = e.target as Node
            if (buttonRef.current?.contains(target) || menuRef.current?.contains(target)) return
            setOpen(false)
        }
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key !== 'Escape') return
            setOpen(false)
            buttonRef.current?.focus()
        }
        // The thread scrolls under a menu that does not follow it
        const close = () => setOpen(false)
        document.addEventListener('pointerdown', onPointerDown, true)
        document.addEventListener('keydown', onKeyDown)
        window.addEventListener('resize', close)
        document.addEventListener('scroll', close, true)
        return () => {
            document.removeEventListener('pointerdown', onPointerDown, true)
            document.removeEventListener('keydown', onKeyDown)
            window.removeEventListener('resize', close)
            document.removeEventListener('scroll', close, true)
        }
    }, [open])

    // Below the button, or above it where the composer would cover the menu
    useLayoutEffect(() => {
        const button = buttonRef.current
        const menu = menuRef.current
        if (!open || !button || !menu) return
        const rect = button.getBoundingClientRect()
        const { height } = menu.getBoundingClientRect()
        const below = rect.bottom + MENU_GAP
        const top = below + height + VIEWPORT_PADDING > window.innerHeight
            ? Math.max(VIEWPORT_PADDING, rect.top - MENU_GAP - height)
            : below
        const left = Math.min(Math.max(VIEWPORT_PADDING, rect.left), window.innerWidth - MENU_WIDTH - VIEWPORT_PADDING)
        menu.style.top = `${top}px`
        menu.style.left = `${left}px`
    }, [open])

    // The settings are read when the user picks, one that changed since the button mounted counts
    const run = (exportAnswer: typeof exportToMarkdown) => async () => {
        const ids = getMessageIds()
        if (ids.length === 0) return false
        const { format, metaList } = readExportSettings()
        const done = await exportAnswer(format, metaList, ids)
        if (done) setOpen(false)
        return done
    }

    const label = t('Download answer')

    return (
        <>
            <button
                ref={buttonRef}
                type="button"
                {...look.attributes}
                className={look.className}
                data-ce-answer-export=""
                data-state={open ? 'open' : 'closed'}
                aria-label={label}
                title={label}
                aria-haspopup="menu"
                aria-expanded={open}
                onClick={() => setOpen(value => !value)}
            >
                <span className={look.innerClassName}>
                    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M8 2v7.5M5 6.75 8 9.75l3-3M2.5 11v1.5a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V11" />
                    </svg>
                </span>
            </button>
            {open && createPortal(
                <div ref={menuRef} className="ce-root ce-answer-menu" role="menu" style={{ width: `${MENU_WIDTH}px` }}>
                    <MenuItem text={t('Markdown')} icon={IconMarkdown} onClick={run(exportToMarkdown)} />
                    <MenuItem text={t('HTML')} icon={FileCode} onClick={run(exportToHtml)} />
                </div>,
                document.body,
            )}
        </>
    )
}
