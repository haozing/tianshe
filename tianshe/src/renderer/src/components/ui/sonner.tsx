import { Toaster as Sonner } from 'sonner';

type ToasterProps = React.ComponentProps<typeof Sonner>;

/**
 * 全局 Toast 通知组件
 *
 * 基于 sonner 封装，提供统一的通知样式
 */
const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      position="top-center"
      toastOptions={{
        classNames: {
          toast:
            'group toast group-[.toaster]:bg-background group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg',
          description: 'group-[.toast]:text-muted-foreground',
          actionButton: 'group-[.toast]:bg-primary group-[.toast]:text-primary-foreground',
          cancelButton: 'group-[.toast]:bg-muted group-[.toast]:text-muted-foreground',
          success:
            'group-[.toaster]:border-green-500/30 group-[.toaster]:bg-green-50 group-[.toaster]:text-green-900 dark:group-[.toaster]:bg-green-900/20 dark:group-[.toaster]:text-green-100',
          error:
            'group-[.toaster]:border-red-500/30 group-[.toaster]:bg-red-50 group-[.toaster]:text-red-900 dark:group-[.toaster]:bg-red-900/20 dark:group-[.toaster]:text-red-100',
          warning:
            'group-[.toaster]:border-yellow-500/30 group-[.toaster]:bg-yellow-50 group-[.toaster]:text-yellow-900 dark:group-[.toaster]:bg-yellow-900/20 dark:group-[.toaster]:text-yellow-100',
          info: 'group-[.toaster]:border-blue-500/30 group-[.toaster]:bg-blue-50 group-[.toaster]:text-blue-900 dark:group-[.toaster]:bg-blue-900/20 dark:group-[.toaster]:text-blue-100',
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
