import type { Metadata } from 'next'
import './globals.css'
import { AuthProvider } from '@/hooks/useAuth'


export const metadata: Metadata = {
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_APP_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000')
  ),
  title: 'unconference',
  description: 'Create and manage unconferences, hackathons, and community events. Propose sessions, vote with quadratic voting, and shape the schedule together.',
  icons: {
    icon: '/icon.svg',
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
      </body>
    </html>
  )
}
