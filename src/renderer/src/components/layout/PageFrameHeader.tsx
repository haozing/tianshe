import type { CSSProperties, ReactNode } from 'react';
import { cn } from '../../lib/utils';

interface PageFrameHeaderProps {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  toolbar?: ReactNode;
  className?: string;
  style?: CSSProperties;
}

export function PageFrameHeader({
  title,
  subtitle,
  actions,
  toolbar,
  className,
  style,
}: PageFrameHeaderProps) {
  return (
    <header className={cn('page-frame-header', className)} style={style}>
      <div className="page-frame-header__row">
        <div className="page-frame-header__copy">
          <h1 className="page-frame-header__title">{title}</h1>
          {subtitle ? <p className="page-frame-header__subtitle">{subtitle}</p> : null}
        </div>
        {actions ? <div className="page-frame-header__actions">{actions}</div> : null}
      </div>
      {toolbar ? <div className="page-frame-header__toolbar">{toolbar}</div> : null}
    </header>
  );
}
