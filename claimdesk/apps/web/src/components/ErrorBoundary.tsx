import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback?: (error: Error, reset: () => void) => ReactNode;
}
interface State {
  error: Error | null;
}

/** Catches render errors so one broken tab never blanks the whole shell. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ClaimDesk] render error', error, info.componentStack);
  }

  reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(error, this.reset);
    return (
      <div className="error-box" role="alert">
        <h2>Something went wrong</h2>
        <p className="muted small">The screen hit an error while rendering. Your data is unaffected; try again or go back to the dashboard.</p>
        <pre>{error.message}</pre>
        <div className="row">
          <button type="button" className="btn btn-primary" onClick={this.reset}>
            Try again
          </button>
          <a className="btn btn-secondary" href="/">
            Dashboard
          </a>
        </div>
      </div>
    );
  }
}
