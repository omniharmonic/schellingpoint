'use client'

import * as React from 'react'

/**
 * Registers the service worker (MT §12.7).
 *
 * Registration is the whole job: the worker decides what it caches, and it caches only public
 * things. It registers in production only — in development a stale shell in the browser cache
 * is a debugging trap, and `next dev` rebuilds assets on every change.
 */
export function ServiceWorker() {
  React.useEffect(() => {
    if (process.env.NODE_ENV !== 'production') return
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
    const register = () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {
        // A browser that refuses the worker (private mode, unsupported) loses offline reading
        // and nothing else. Never surface it.
      })
    }
    if (document.readyState === 'complete') register()
    else window.addEventListener('load', register, { once: true })
  }, [])
  return null
}
