import type { Metadata, Viewport } from 'next'
import './globals.css'
import { AuthProvider } from '@/hooks/useAuth'
import { ServiceWorker } from '@/components/ServiceWorker'


export const metadata: Metadata = {
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_APP_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000')
  ),
  title: 'unconference',
  description: 'Create and manage unconferences, hackathons, and community events. Propose sessions, vote with quadratic voting, and shape the schedule together.',
  // PWA (MT §12.7, §12.10): installable, with an app icon on the home screen and a shell the
  // service worker can serve when the room has no signal.
  manifest: '/manifest.webmanifest',
  applicationName: 'unconference',
  appleWebApp: {
    capable: true,
    title: 'unconference',
    statusBarStyle: 'default',
  },
  formatDetection: { telephone: false },
  icons: {
    icon: '/icon.svg',
    apple: '/icons/apple-touch-icon.png',
  },
  openGraph: {
    title: 'unconference',
    description: 'Create and manage unconferences, hackathons, and community events. Propose sessions, vote with quadratic voting, and shape the schedule together.',
    type: 'website',
  },
  twitter: {
    card: 'summary',
    title: 'unconference',
    description: 'Create and manage unconferences, hackathons, and community events.',
  },
}

/**
 * `--primary` in light mode, so the browser chrome matches the app rather than fighting it.
 */
export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#245043' },
    { media: '(prefers-color-scheme: dark)', color: '#111312' },
  ],
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" className="light">
      <body className="min-h-screen bg-background antialiased">
        <AuthProvider>
          {children}
        </AuthProvider>
        <ServiceWorker />
      </body>
    </html>
  )
}
