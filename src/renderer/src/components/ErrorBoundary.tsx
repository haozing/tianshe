/**
 * React Error Boundary
 * 捕获组件树中的 JavaScript 错误并显示降级 UI
 */

import React, { Component, ReactNode } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Button } from './ui/button';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: React.ErrorInfo | null;
}

class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
    };
  }

  static getDerivedStateFromError(error: Error): State {
    return {
      hasError: true,
      error,
      errorInfo: null,
    };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('[ErrorBoundary] Caught an error:', error, errorInfo);
    this.setState({
      error,
      errorInfo,
    });
  }

  handleReset = () => {
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null,
    });
  };

  handleReload = () => {
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      // 如果提供了自定义 fallback，使用它
      if (this.props.fallback) {
        return this.props.fallback;
      }

      // 否则使用默认错误 UI
      return (
        <div className="min-h-screen bg-background flex items-center justify-center p-4">
          <Card className="max-w-2xl w-full">
            <CardHeader>
              <CardTitle className="text-destructive">应用出现错误</CardTitle>
              <CardDescription>
                很抱歉，应用程序遇到了一个意外错误。您可以尝试刷新页面或联系开发者。
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Error Message */}
              <div>
                <h4 className="text-sm font-semibold mb-2">错误信息：</h4>
                <pre className="bg-destructive/10 border border-destructive text-destructive p-3 rounded-md overflow-x-auto text-xs">
                  {this.state.error?.toString()}
                </pre>
              </div>

              {/* Stack Trace */}
              {this.state.errorInfo && (
                <details>
                  <summary className="text-sm font-semibold cursor-pointer mb-2">
                    查看详细堆栈信息
                  </summary>
                  <pre className="bg-muted p-3 rounded-md overflow-x-auto text-xs">
                    {this.state.errorInfo.componentStack}
                  </pre>
                </details>
              )}

              {/* Actions */}
              <div className="flex gap-2 pt-2">
                <Button variant="default" onClick={this.handleReset}>
                  尝试恢复
                </Button>
                <Button variant="outline" onClick={this.handleReload}>
                  刷新页面
                </Button>
              </div>

              {/* Help Text */}
              <div className="text-xs text-muted-foreground pt-2 border-t">
                <p>如果问题持续存在，请：</p>
                <ul className="list-disc list-inside mt-1 space-y-1">
                  <li>检查浏览器控制台是否有更多错误信息</li>
                  <li>尝试清除应用缓存后重启</li>
                  <li>将错误信息报告给开发团队</li>
                </ul>
              </div>
            </CardContent>
          </Card>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
