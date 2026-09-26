'use client'

/**
 * Schedule (mobile shell design §4): one page with two tabs, Program and My schedule.
 *
 * `?view=mine` selects the saved tab and is what `/e/[slug]/my-schedule` now redirects to, so a
 * link anyone already has keeps working and the mobile tab bar has one Schedule destination
 * instead of two. Both tabs render the same `ScheduleView`; only the export button's
 * `favoritesOnly` and the page title change with the tab.
 */

import * as React from 'react'
import { Suspense } from 'react'
import { Calendar, Heart, Loader2 } from 'lucide-react'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { PageHeader } from '@/components/PageHeader'
import { DashboardLayout } from '@/components/DashboardLayout'
import { ExportScheduleButton } from '@/components/AddToCalendar'
import { ScheduleView } from '@/components/schedule/ScheduleView'
import type { ScheduleViewMode } from '@/components/schedule/useSchedule'
import { useEvent } from '@/contexts/EventContext'
import { useSearchParams } from 'next/navigation'

function SchedulePageBody() {
  const event = useEvent()
  const searchParams = useSearchParams()
  const fromUrl: ScheduleViewMode = searchParams.get('view') === 'mine' ? 'mine' : 'program'
  const [view, setView] = React.useState<ScheduleViewMode>(fromUrl)

  // A link or a redirect into a tab arrives as a new `?view=`, so follow it. Switching tabs by
  // hand goes the other way and *replaces* the URL (`replaceState` in `changeView`), so tapping
  // between the two never piles up history entries for Back to walk out of.
  React.useEffect(() => {
    setView(fromUrl)
  }, [fromUrl])

  const changeView = (next: ScheduleViewMode) => {
    setView(next)
    const url = new URL(window.location.href)
    if (next === 'mine') url.searchParams.set('view', 'mine')
    else url.searchParams.delete('view')
    window.history.replaceState(null, '', url.toString())
  }

  return (
    <div className="space-y-6">
      <PageHeader
        className="mb-0"
        title={view === 'mine' ? 'My schedule' : 'Schedule'}
        subtitle={view === 'mine' ? 'Sessions you saved to attend.' : 'Browse sessions by day.'}
        actions={
          <ExportScheduleButton
            eventSlug={event.slug}
            eventName={event.name}
            favoritesOnly={view === 'mine'}
            variant="outline"
            size="sm"
          />
        }
      />

      <SegmentedControl<ScheduleViewMode>
        aria-label="Schedule view"
        fullWidth
        value={view}
        onValueChange={changeView}
        options={[
          { value: 'program', label: 'Program', icon: <Calendar className="h-3.5 w-3.5" aria-hidden /> },
          { value: 'mine', label: 'My schedule', icon: <Heart className="h-3.5 w-3.5" aria-hidden /> },
        ]}
      />

      <ScheduleView view={view} />
    </div>
  )
}

export default function SchedulePage() {
  return (
    <DashboardLayout>
      <Suspense
        fallback={
          <div className="flex items-center justify-center py-12" role="status" aria-label="Loading the schedule">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        }
      >
        <SchedulePageBody />
      </Suspense>
    </DashboardLayout>
  )
}
