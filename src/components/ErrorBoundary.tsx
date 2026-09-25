import { Component, type ErrorInfo, type ReactNode } from 'react'
import { ChunkLoadError } from '../app/lazyTab'

interface Props {
  children: ReactNode
  /** Reset the boundary when this key changes (e.g. the route path). */
  resetKey?: string
}
interface State {
  error: Error | null
}

/** The underlying reason an import rejected, as one line of text. */
function causeMessage(cause: unknown): string {
  if (cause instanceof Error) return `${cause.name}: ${cause.message}`
  if (cause === undefined) return 'No further detail was given.'
  return String(cause)
}

/** Catches render errors in a tab so the rest of the app keeps working. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidUpdate(prev: Props) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null })
    }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error('[gigamon-ami] tab render error:', error, info.componentStack)
  }

  render() {
    // A tab's module did not load (src/app/lazyTab.ts). "Try again" would
    // re-throw the same cached rejection, so the one action offered is a
    // reload — on a click, never automatically, which is what keeps a chunk
    // that is genuinely gone from becoming a reload loop.
    //
    // The message does NOT say the code failed to download: the same rejection
    // carries a module that threw while it evaluated, which no reload fixes.
    // The cause is shown beneath, so whoever reads it can tell which one it was.
    const error = this.state.error
    if (error instanceof ChunkLoadError) {
      return (
        <div className="qb-center qb-error" role="alert">
          <span className="qb-error-title">This tab could not be loaded</span>
          <span className="qb-msg">
            If the connection dropped, or a new version of the app was installed while this page was open, reloading
            the page fetches it again.
          </span>
          <button type="button" className="btn" onClick={() => window.location.reload()}>Reload</button>
          <details className="qb-msg">
            <summary>What went wrong</summary>
            <code>{causeMessage(error.cause)}</code>
          </details>
        </div>
      )
    }
    if (error) {
      return (
        <div className="qb-center qb-error">
          <span className="qb-error-title">This view hit an error</span>
          <span className="qb-msg">{error.message}</span>
          <button type="button" className="btn" onClick={() => this.setState({ error: null })}>Try again</button>
        </div>
      )
    }
    return this.props.children
  }
}
