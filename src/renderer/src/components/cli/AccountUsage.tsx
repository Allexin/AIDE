import React, { useCallback, useEffect, useRef, useState } from 'react'

/**
 * The current account and usage limits of a CLI tool, as the status bar shows
 * them. Shared by the status bar (the active tab's tool) and the pipeline tab
 * (every CLI of the machine), so both show the same text from the same caches.
 */

export interface UsageDisplay {
  summary: string
  tooltip: string
  level: 'normal' | 'warn' | 'critical'
  fetchedAt: number
  hasLimit?: boolean
}

export interface AccountUsage {
  accountLabel: string | null
  accountSaved: boolean
  usage: UsageDisplay | null
  /** "3m ago" — how old the usage data is; empty when fresh. */
  usageAge: string
}

export function useAccountUsage(toolId: string | null): AccountUsage {
  const [accountLabel, setAccountLabel] = useState<string | null>(null)
  const [accountSaved, setAccountSaved] = useState(true)
  const [usage, setUsage] = useState<UsageDisplay | null>(null)
  const [usageAge, setUsageAge] = useState('')
  const toolIdRef = useRef<string | null>(null)
  const requestGeneration = useRef(0)
  const lastUsageFetch = useRef(0)

  const fetchAccountAndUsage = useCallback((id: string | null) => {
    const generation = ++requestGeneration.current
    toolIdRef.current = id
    if (!id) {
      // No integration — clear display
      setAccountLabel(null)
      setAccountSaved(true)
      setUsage(null)
      return
    }

    window.editorApi.getAccountCurrentInfo(id).then((info) => {
      if (generation !== requestGeneration.current || toolIdRef.current !== id) return
      if (info) {
        setAccountLabel(info.label)
        setAccountSaved(info.saved)
      } else {
        setAccountLabel(null)
      }
    })

    lastUsageFetch.current = Date.now()
    window.editorApi.getUsageInfo(id).then((info) => {
      if (generation !== requestGeneration.current || toolIdRef.current !== id) return
      setUsage(info)
    })
  }, [])

  useEffect(() => {
    fetchAccountAndUsage(toolId)
  }, [toolId, fetchAccountAndUsage])

  // Refresh on account changes and tab events (pushed by the main process)
  useEffect(() => {
    const refresh = (): void => { if (toolIdRef.current) fetchAccountAndUsage(toolIdRef.current) }
    const unsubs = [
      window.editorApi.onAccountsChanged(refresh),
      window.editorApi.onTerminalSwitchTab(refresh),
      window.editorApi.onTerminalNewTab(refresh)
    ]
    return () => unsubs.forEach((u) => u())
  }, [fetchAccountAndUsage])

  // Update age label every second based on fetchedAt from the data itself
  useEffect(() => {
    const id = setInterval(() => {
      if (!usage?.fetchedAt) return
      const sec = Math.floor((Date.now() - usage.fetchedAt) / 1000)
      if (sec < 5) { setUsageAge(''); return }
      if (sec < 60) { setUsageAge(`${sec}s ago`); return }
      const min = Math.floor(sec / 60)
      if (min < 60) { setUsageAge(`${min}m ago`); return }
      const hr = Math.floor(min / 60)
      setUsageAge(`${hr}h${min % 60}m ago`)
    }, 1000)
    return () => clearInterval(id)
  }, [usage?.fetchedAt])

  useEffect(() => {
    // Adaptive polling: 5 min focused, 20 min unfocused
    let timerId: ReturnType<typeof setInterval>
    const fetchUsage = (): void => {
      const id = toolIdRef.current
      if (!id) return
      lastUsageFetch.current = Date.now()
      window.editorApi.getUsageInfo(id).then((info) => {
        if (toolIdRef.current !== id) return
        setUsage(info)
      })
    }

    const startInterval = (): void => {
      clearInterval(timerId)
      timerId = setInterval(fetchUsage, document.hasFocus() ? 300_000 : 1_200_000)
    }
    startInterval()

    const onFocus = (): void => {
      if (Date.now() - lastUsageFetch.current > 300_000) fetchUsage()
      startInterval()
    }
    const onBlur = (): void => startInterval()

    window.addEventListener('focus', onFocus)
    window.addEventListener('blur', onBlur)
    return () => {
      clearInterval(timerId)
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('blur', onBlur)
    }
  }, [])

  return { accountLabel, accountSaved, usage, usageAge }
}

export function AccountLabel({ info, style }: { info: AccountUsage; style: React.CSSProperties }): React.ReactElement | null {
  if (!info.accountLabel) return null
  return <span
    style={{ ...style, color: info.accountSaved ? 'rgba(255,255,255,0.9)' : '#cca700' }}
    title={info.accountSaved ? 'CLI account' : 'CLI account not saved in AIDE'}
  >
    {info.accountLabel}
  </span>
}

export function UsageLabel({ info, style }: { info: AccountUsage; style: React.CSSProperties }): React.ReactElement | null {
  const usage = info.usage
  if (!usage) return null
  return <span
    style={{
      ...style,
      color: usage.hasLimit === false
        ? 'rgba(255,255,255,0.9)'
        : usage.level === 'critical' ? '#f44747'
          : usage.level === 'warn' ? '#cca700'
            : 'rgba(255,255,255,0.9)'
    }}
    title={usage.tooltip}
  >
    {usage.summary}{info.usageAge && <span style={{ opacity: 0.6, marginLeft: 4 }}>({info.usageAge})</span>}
  </span>
}
