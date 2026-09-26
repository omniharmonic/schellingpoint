'use client'

import { useEffect, useState } from 'react'
import { BellRing } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { apiFetch } from '@/lib/api/client'

export function PushNotifications() {
  const [config, setConfig] = useState<{ publicKey: string | null; subscribed: boolean } | null>(null)
  const [supported, setSupported] = useState(false)
  const [blocked, setBlocked] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    setSupported('serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window)
    setBlocked('Notification' in window && Notification.permission === 'denied')
    apiFetch<{ publicKey: string | null; subscribed: boolean }>('/api/me/push').then(setConfig).catch(() => setError('Device notification settings could not be loaded. Reload to retry.'))
  }, [])
  const toggle = async () => {
    if (!config) return
    setBusy(true); setError(null)
    try {
      if (config.subscribed) {
        // Remove delivery credentials first, even if the browser is offline from its push service.
        await apiFetch('/api/me/push', { method: 'DELETE' })
        setConfig({ ...config, subscribed: false })
        const registration = await navigator.serviceWorker.getRegistration('/')
        await (await registration?.pushManager.getSubscription())?.unsubscribe()
      } else {
        const permission = await Notification.requestPermission()
        if (permission !== 'granted') { setBlocked(permission === 'denied'); throw new Error('Notifications were not enabled. You can try again from your browser’s site settings.') }
        await navigator.serviceWorker.register('/sw.js')
        const registration = await navigator.serviceWorker.ready
        const key = Uint8Array.from(atob(config.publicKey!.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))
        const existing = await registration.pushManager.getSubscription()
        const subscription = existing || await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })
        try { await apiFetch('/api/me/push', { method: 'POST', json: subscription.toJSON() }) }
        catch (e) { if (!existing) await subscription.unsubscribe(); throw e }
        setConfig({ ...config, subscribed: true })
      }
    } catch (e) { setError(e instanceof Error ? e.message : 'Device notifications could not be updated.') }
    finally { setBusy(false) }
  }
  return <section className="mb-6 rounded-2xl border bg-card p-5 sm:p-6" aria-labelledby="push-device-title">
    <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="max-w-xl"><h2 id="push-device-title" className="flex items-center gap-2 font-semibold"><BellRing className="h-5 w-5 text-primary" aria-hidden />Notifications on this device</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{!supported ? 'On iPhone or iPad, add unconference to your Home Screen in Safari, then open it from there. Other supported browsers can enable notifications here.' : blocked ? 'Notifications are blocked in your browser. Allow them in this site’s browser settings, then reload.' : config?.subscribed ? 'This device is connected. Choose the Push categories below to receive updates. Signing out disconnects this device.' : 'Get gathering updates even when the app is closed. Enable this device, then choose the Push categories below. Private details stay off your lock screen.'}</p>
        {config && !config.publicKey && <p className="mt-2 text-sm text-muted-foreground">Device notifications are awaiting platform setup.</p>}
      </div>
      <Button className="shrink-0" variant={config?.subscribed ? 'outline' : 'default'} loading={busy} disabled={!supported || !config?.publicKey || (!config.subscribed && blocked)} onClick={toggle}>{config?.subscribed ? 'Disable on this device' : 'Enable on this device'}</Button>
    </div>
    {error && <p className="mt-3 text-sm text-destructive" role="alert">{error}</p>}
  </section>
}
