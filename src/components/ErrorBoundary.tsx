import { Component, type ReactNode } from 'react'

/** Shows the error instead of a blank page if anything crashes while rendering. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) { return { error } }
  render() {
    if (!this.state.error) return this.props.children
    return (
      <main><div className="card">
        <h3>Something went wrong</h3>
        <p className="err">{this.state.error.message}</p>
        <button onClick={() => location.reload()}>Reload</button>
      </div></main>
    )
  }
}
