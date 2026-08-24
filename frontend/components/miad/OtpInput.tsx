'use client'

import { useRef, useState, ClipboardEvent, KeyboardEvent } from 'react'

interface OtpInputProps {
  length?: number
  value: string
  onChange: (v: string) => void
  disabled?: boolean
}

export function OtpInput({ length = 6, value, onChange, disabled }: OtpInputProps) {
  const inputsRef = useRef<(HTMLInputElement | null)[]>([])
  const digits    = value.split('').concat(Array(length).fill('')).slice(0, length)

  const update = (idx: number, char: string) => {
    const next = [...digits]
    next[idx] = char.replace(/\D/g, '').slice(-1)
    onChange(next.join(''))
    if (char && idx < length - 1) inputsRef.current[idx + 1]?.focus()
  }

  const handleKey = (idx: number, e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace') {
      if (digits[idx]) {
        update(idx, '')
      } else if (idx > 0) {
        inputsRef.current[idx - 1]?.focus()
        update(idx - 1, '')
      }
    } else if (e.key === 'ArrowLeft' && idx > 0) {
      inputsRef.current[idx - 1]?.focus()
    } else if (e.key === 'ArrowRight' && idx < length - 1) {
      inputsRef.current[idx + 1]?.focus()
    }
  }

  const handlePaste = (e: ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault()
    const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, length)
    if (pasted) {
      onChange(pasted.padEnd(length, '').slice(0, length))
      const focusIdx = Math.min(pasted.length, length - 1)
      inputsRef.current[focusIdx]?.focus()
    }
  }

  return (
    <div className="flex gap-2 justify-center" role="group" aria-label="Code OTP">
      {digits.map((d, i) => (
        <input
          key={i}
          ref={el => { inputsRef.current[i] = el }}
          type="text"
          inputMode="numeric"
          maxLength={1}
          value={d}
          disabled={disabled}
          onChange={e => update(i, e.target.value)}
          onKeyDown={e => handleKey(i, e)}
          onPaste={handlePaste}
          onFocus={e => e.target.select()}
          className={`w-12 h-14 text-center text-xl font-black border-2 rounded-xl bg-background transition-all
            focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/20
            ${d ? 'border-accent bg-accent/5 text-accent' : 'border-border text-foreground'}
            ${disabled ? 'opacity-50 cursor-not-allowed' : ''}
          `}
          aria-label={`Chiffre ${i + 1}`}
        />
      ))}
    </div>
  )
}
