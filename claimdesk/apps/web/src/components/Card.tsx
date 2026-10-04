import type { ReactNode } from 'react';

export interface CardProps {
  title?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  flush?: boolean; // no body padding (tables, lists)
  className?: string;
  id?: string;
}

export function Card({ title, actions, children, footer, flush = false, className = '', id }: CardProps) {
  return (
    <section className={`card ${className}`.trim()} id={id}>
      {(title || actions) && (
        <header className="card-header">
          {title && <h3 className="card-title">{title}</h3>}
          {actions && <div className="row">{actions}</div>}
        </header>
      )}
      {children !== undefined && <div className={flush ? 'card-body card-body-flush' : 'card-body'}>{children}</div>}
      {footer && <footer className="card-footer">{footer}</footer>}
    </section>
  );
}
