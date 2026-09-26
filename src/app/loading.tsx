import { Skeleton } from '@/components/ui/skeleton'

export default function Loading() {
  return <div role="status" aria-label="Loading page" className="max-w-6xl mx-auto p-6 sm:p-10 space-y-6"><span className="sr-only">Loading your gathering…</span><Skeleton className="h-9 w-2/3 max-w-md"/><Skeleton className="h-5 w-1/2"/><div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">{[0,1,2].map(i=><Skeleton key={i} className="h-52 rounded-2xl"/>)}</div></div>
}
