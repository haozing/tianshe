import { toast as sonnerToast } from 'sonner';

/**
 * 统一的 Toast 通知工具
 *
 * 用于替代原生 alert()，提供更好的用户体验
 *
 * @example
 * import { toast } from '@/lib/toast';
 *
 * toast.success('操作成功');
 * toast.error('操作失败');
 * toast.warning('请注意');
 * toast.info('提示信息');
 */
export const toast = {
  /**
   * 成功通知
   */
  success: (message: string, description?: string): void => {
    sonnerToast.success(message, { description });
  },

  /**
   * 错误通知
   */
  error: (message: string, description?: string): void => {
    sonnerToast.error(message, { description, duration: 5000 });
  },

  /**
   * 警告通知
   */
  warning: (message: string, description?: string): void => {
    sonnerToast.warning(message, { description });
  },

  /**
   * 信息通知
   */
  info: (message: string, description?: string): void => {
    sonnerToast.info(message, { description });
  },

  /**
   * 关闭所有通知
   */
  dismiss: (toastId?: string | number): void => {
    sonnerToast.dismiss(toastId);
  },
};
