import { Component, type ReactNode } from 'react'

/** Mostra o erro em vez de uma tela branca se algo quebrar na renderização. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) { return { error } }
  render() {
    if (!this.state.error) return this.props.children
    return (
      <main><div className="card">
        <h3>Algo deu errado</h3>
        <p className="err">{this.state.error.message}</p>
        <button onClick={() => location.reload()}>Recarregar</button>
      </div></main>
    )
  }
}
