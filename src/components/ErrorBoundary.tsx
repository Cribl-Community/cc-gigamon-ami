import { Component, type ErrorInfo, type ReactNode } from 'react'

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
    if (this.state.error) {
      return (
        <div className="qb-center qb-error">
          <span className="qb-error-title">This view hit an error</span>
          <span className="qb-msg">{this.state.error.message}</span>
          <button type="button" className="btn-refresh" onClick={() => this.setState({ error: null })}>Try again</button>
        </div>
      )
    }
    return this.props.children
  }
}
