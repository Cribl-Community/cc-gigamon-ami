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
    // A tab's chunk did not download (src/app/lazyTab.ts). "Try again" would
    // re-throw the same cached rejection, so the one action offered is a
    // reload — on a click, never automatically, which is what keeps a chunk
    // that is genuinely gone from becoming a reload loop.
    if (this.state.error instanceof ChunkLoadError) {
      return (
        <div className="qb-center qb-error" role="alert">
          <span className="qb-error-title">This tab could not be loaded</span>
          <span className="qb-msg">
            Its code did not download — usually a dropped connection, or a new version of the app installed while
            this page was open. Reloading the page fetches it again.
          </span>
          <button type="button" className="btn" onClick={() => window.location.reload()}>Reload</button>
        </div>
      )
    }
    if (this.state.error) {
      return (
        <div className="qb-center qb-error">
          <span className="qb-error-title">This view hit an error</span>
          <span className="qb-msg">{this.state.error.message}</span>
          <button type="button" className="btn" onClick={() => this.setState({ error: null })}>Try again</button>
        </div>
      )
    }
    return this.props.children
  }
}
