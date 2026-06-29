import * as React from 'react';
import { useState, useRef, useEffect, useContext, createContext } from 'react';
import { createPortal } from 'react-dom';

// Dropdown Context
interface DropdownContextValue {
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
  anchorRef: React.RefObject<HTMLDivElement>;
  contentRef: React.RefObject<HTMLDivElement>;
}

const DropdownContext = createContext<DropdownContextValue>({
  isOpen: false,
  setIsOpen: () => {},
  anchorRef: { current: null },
  contentRef: { current: null },
});

function composeRefs<T>(...refs: Array<React.Ref<T> | undefined>) {
  return (node: T | null) => {
    for (const ref of refs) {
      if (!ref) continue;
      if (typeof ref === 'function') {
        ref(node);
      } else {
        (ref as React.MutableRefObject<T | null>).current = node;
      }
    }
  };
}

interface DropdownMenuProps {
  children: React.ReactNode;
}

const DropdownMenu = ({ children }: DropdownMenuProps) => {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  // 点击外部关闭
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      const insideTrigger = dropdownRef.current?.contains(target) ?? false;
      const insideContent = contentRef.current?.contains(target) ?? false;
      if (!insideTrigger && !insideContent) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  return (
    <DropdownContext.Provider value={{ isOpen, setIsOpen, anchorRef: dropdownRef, contentRef }}>
      <div ref={dropdownRef} className="relative inline-block text-left">
        {children}
      </div>
    </DropdownContext.Provider>
  );
};

interface DropdownMenuTriggerProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  asChild?: boolean;
}

const DropdownMenuTrigger = React.forwardRef<HTMLButtonElement, DropdownMenuTriggerProps>(
  ({ children, asChild = false, onClick, ...props }, forwardedRef) => {
    const { isOpen, setIsOpen } = useContext(DropdownContext);

    const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
      e.preventDefault();
      e.stopPropagation();
      setIsOpen(!isOpen);
      onClick?.(e);
    };

    if (asChild && React.isValidElement(children)) {
      const childOnClick = (children.props as { onClick?: (e: React.MouseEvent) => void }).onClick;
      const mergedOnClick = (e: React.MouseEvent<HTMLButtonElement>) => {
        handleClick(e);
        childOnClick?.(e);
      };

      return React.cloneElement(children, {
        ...props,
        'aria-expanded': isOpen,
        'aria-haspopup': 'menu',
        onClick: mergedOnClick,
      } as any);
    }

    return (
      <button
        ref={forwardedRef}
        onClick={handleClick}
        aria-expanded={isOpen}
        aria-haspopup="menu"
        {...props}
      >
        {children}
      </button>
    );
  }
);
DropdownMenuTrigger.displayName = 'DropdownMenuTrigger';

interface DropdownMenuContentProps extends React.HTMLAttributes<HTMLDivElement> {
  align?: 'start' | 'center' | 'end';
  sideOffset?: number;
}

const DropdownMenuContent = React.forwardRef<HTMLDivElement, DropdownMenuContentProps>(
  ({ className = '', align = 'center', children, ...props }, ref) => {
    const { isOpen, setIsOpen, anchorRef, contentRef } = useContext(DropdownContext);
    const [position, setPosition] = useState({
      top: -9999,
      left: -9999,
      transformOrigin: 'center top',
    });

    const updatePosition = React.useCallback(() => {
      if (!anchorRef.current || !contentRef.current) {
        return;
      }

      const triggerRect = anchorRef.current.getBoundingClientRect();
      const contentRect = contentRef.current.getBoundingClientRect();
      const viewportPadding = 8;
      const sideOffset = 4;

      let left = triggerRect.left + (triggerRect.width - contentRect.width) / 2;
      let originX = 'center';
      if (align === 'start') {
        left = triggerRect.left;
        originX = 'left';
      } else if (align === 'end') {
        left = triggerRect.right - contentRect.width;
        originX = 'right';
      }

      let top = triggerRect.bottom + sideOffset;
      let originY = 'top';
      if (
        top + contentRect.height > globalThis.innerHeight - viewportPadding &&
        triggerRect.top - sideOffset - contentRect.height >= viewportPadding
      ) {
        top = triggerRect.top - sideOffset - contentRect.height;
        originY = 'bottom';
      }

      left = Math.min(
        Math.max(left, viewportPadding),
        Math.max(viewportPadding, globalThis.innerWidth - contentRect.width - viewportPadding)
      );
      top = Math.min(
        Math.max(top, viewportPadding),
        Math.max(viewportPadding, globalThis.innerHeight - contentRect.height - viewportPadding)
      );

      setPosition({
        top,
        left,
        transformOrigin: `${originX} ${originY}`,
      });
    }, [align, anchorRef, contentRef]);

    React.useLayoutEffect(() => {
      if (!isOpen) return;

      updatePosition();

      const handlePositionChange = () => {
        updatePosition();
      };

      globalThis.addEventListener('resize', handlePositionChange);
      globalThis.addEventListener('scroll', handlePositionChange, true);

      return () => {
        globalThis.removeEventListener('resize', handlePositionChange);
        globalThis.removeEventListener('scroll', handlePositionChange, true);
      };
    }, [isOpen, updatePosition]);

    if (!isOpen) return null;

    const content = (
      <div
        ref={composeRefs(ref, contentRef)}
        role="menu"
        className={`fixed z-[1200] min-w-[8rem] overflow-hidden rounded-md border bg-popover p-1 shadow-md animate-in fade-in-0 zoom-in-95 ${className}`}
        style={{
          top: position.top,
          left: position.left,
          transformOrigin: position.transformOrigin,
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            setIsOpen(false);
            anchorRef.current?.querySelector<HTMLElement>('[aria-haspopup="menu"],button')?.focus();
          }
        }}
        {...props}
      >
        {children}
      </div>
    );

    return createPortal(content, document.body);
  }
);
DropdownMenuContent.displayName = 'DropdownMenuContent';

interface DropdownMenuItemProps extends React.HTMLAttributes<HTMLDivElement> {
  disabled?: boolean;
}

const DropdownMenuItem = React.forwardRef<HTMLDivElement, DropdownMenuItemProps>(
  ({ className = '', disabled, onClick, ...props }, ref) => {
    const { setIsOpen } = useContext(DropdownContext);

    const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
      if (disabled) {
        e.preventDefault();
        return;
      }
      onClick?.(e);
      setIsOpen(false); // 点击后关闭菜单
    };

    return (
      <div
        ref={ref}
        role="menuitem"
        tabIndex={-1}
        className={`relative flex cursor-pointer select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground ${
          disabled ? 'opacity-50 pointer-events-none' : ''
        } ${className}`}
        onClick={handleClick}
        {...props}
      />
    );
  }
);
DropdownMenuItem.displayName = 'DropdownMenuItem';

const DropdownMenuSeparator = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className = '', ...props }, ref) => (
  <div ref={ref} className={`-mx-1 my-1 h-px bg-muted ${className}`} {...props} />
));
DropdownMenuSeparator.displayName = 'DropdownMenuSeparator';

export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownContext,
};

// Legacy: SimpleDropdownMenu (kept for compatibility)
export const SimpleDropdownMenu = ({
  children: _children,
  trigger,
  content,
}: {
  children?: React.ReactNode;
  trigger: React.ReactNode;
  content: React.ReactNode;
}) => {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {React.isValidElement(trigger) ? (
          trigger
        ) : (
          <button type="button">{trigger}</button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="p-0">
        <div className="py-1">{content}</div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
