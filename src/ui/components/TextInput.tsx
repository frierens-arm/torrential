import { useEffect, useState } from 'react'
import { Box, Text } from 'ink'
import { useInput } from 'ink'
import { getTheme } from '../../themes.js'
import { useTick } from '../hooks.js'

export interface TextInputProps {
  value: string
  onChange: (next: string) => void
  onSubmit: (value: string) => void
  placeholder?: string
  prompt?: string
  accent?: string
  /** v1.3.1: when false (e.g. the /theme picker has focus) all keys are ignored. */
  inputEnabled?: boolean
}

/**
 * Delete the word before `cursor` (Emacs M-backspace / ctrl+w semantics):
 * trailing whitespace goes with the word AND the separator whitespace in
 * front of it is chewed too, so repeated presses walk "one two three|"
 * → "one two" → "one" → "".
 */
function wordStartBefore(text: string, cursor: number): number {
  let i = cursor
  while (i > 0 && /\s/.test(text[i - 1] ?? '')) i--
  while (i > 0 && !/\s/.test(text[i - 1] ?? '')) i--
  while (i > 0 && /\s/.test(text[i - 1] ?? '')) i--
  return i
}

/**
 * Hand-rolled single-line editor: blinking block cursor, paste tolerance,
 * ctrl+u line wipe. Keeps the torlink "just type" feel.
 *
 * ⚠ Backspace: virtually every modern terminal (xterm, gnome-terminal,
 * iTerm2, Terminal.app, Windows Terminal, VS Code) sends `\x7F` for the
 * Backspace key, which Ink reports as `key.delete` — NOT `key.backspace`
 * (reserved for the literal `\b`, i.e. ctrl+h). Ink strips the escape
 * sequence before we see it, so the two are indistinguishable here; like
 * ink-text-input upstream, both are treated as "delete before cursor".
 * The forward-Delete key therefore also deletes backwards — an accepted
 * trade-off that makes Backspace work everywhere.
 */
export function TextInput({
  value,
  onChange,
  onSubmit,
  placeholder = '',
  prompt = '❯ ',
  accent,
  inputEnabled = true
}: TextInputProps): React.ReactElement {
  const [cursor, setCursor] = useState(value.length)
  const blink = useTick(530)
  const blinkOn = blink % 2 === 0
  const themeAccent = accent ?? getTheme().violet

  useEffect(() => {
    if (cursor > value.length) setCursor(value.length)
  }, [value])

  useInput((input, key) => {
    if (!inputEnabled) return // a modal (skin picker) owns the keyboard
    if (key.return) {
      onSubmit(value)
      return
    }
    if (key.escape || key.upArrow || key.downArrow || key.tab) return

    if (key.leftArrow) {
      setCursor(Math.max(0, cursor - 1))
      return
    }
    if (key.rightArrow) {
      setCursor(Math.min(value.length, cursor + 1))
      return
    }

    // ctrl+a / ctrl+e — readline-style jump to start / end.
    if (key.ctrl && input === 'a') {
      setCursor(0)
      return
    }
    if (key.ctrl && input === 'e') {
      setCursor(value.length)
      return
    }

    // ctrl+u — wipe the whole line (as the old doc comment promised).
    if (key.ctrl && input === 'u') {
      setCursor(0)
      onChange('')
      return
    }

    // ctrl+w / alt+backspace — delete the word before the cursor.
    if ((key.ctrl && input === 'w') || (key.delete && key.meta)) {
      const start = wordStartBefore(value, cursor)
      if (start !== cursor) {
        onChange(value.slice(0, start) + value.slice(cursor))
        setCursor(start)
      }
      return
    }

    if (key.backspace || key.delete) {
      // Delete BEFORE the cursor in both cases — see the ⚠ note above.
      if (cursor > 0) {
        onChange(value.slice(0, cursor - 1) + value.slice(cursor))
        setCursor(cursor - 1)
      }
      return
    }

    if (key.ctrl || key.meta) return

    if (input.length > 0) {
      onChange(value.slice(0, cursor) + input + value.slice(cursor))
      setCursor(Math.min(value.length + input.length, cursor + input.length))
    }
  })

  const empty = value.length === 0
  const cursorBlock = (text: string): React.ReactElement =>
    !inputEnabled ? (
      <Text dimColor bold>
        {text}
      </Text>
    ) : blinkOn ? (
      <Text backgroundColor={themeAccent} color="#1a1030" bold>
        {text}
      </Text>
    ) : (
      <Text bold>{text}</Text>
    )

  return (
    <Box>
      <Text color={themeAccent} bold>
        {prompt}
      </Text>
      {empty ? (
        <Box>
          {cursorBlock(' ')}
          {placeholder.length > 0 && (
            <Text dimColor color={getTheme().subtle}>
              {placeholder}
            </Text>
          )}
        </Box>
      ) : (
        <Box>
          <Text>{value.slice(0, cursor)}</Text>
          {cursorBlock(cursor < value.length ? value[cursor] : ' ')}
          {cursor < value.length && <Text>{value.slice(cursor + 1)}</Text>}
        </Box>
      )}
    </Box>
  )
}
