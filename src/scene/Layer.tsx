import { Suspense, type ReactNode } from 'react'
import { ErrorBoundary } from 'react-error-boundary'

/**
 * A part of the scene that loads its own assets. While they load it renders nothing; if one fails
 * it renders `fallback` instead, so a missing asset costs that layer and not the whole canvas.
 */
export function Layer({ name, fallback = null, children }: { name: string; fallback?: ReactNode; children: ReactNode }) {
  return (
    <ErrorBoundary fallback={fallback} onError={(error) => console.error(`[scene] ${name} failed to load:`, error)}>
      <Suspense fallback={null}>{children}</Suspense>
    </ErrorBoundary>
  )
}
