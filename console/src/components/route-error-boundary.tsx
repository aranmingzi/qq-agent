import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/empty-state';

type Props = { children: ReactNode; label?: string };
type State = { error: Error | null };

/**
 * 路由级错误边界：任何一个页面渲染崩溃时只倒下这一块，
 * 侧边栏 / 顶栏还能用，用户可以直接点走，而不是整屏白屏。
 */
export class RouteErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // 控制台留一份带组件栈的日志，方便定位是哪个页面炸的
    console.error('[console] 页面渲染崩溃', this.props.label ?? '', error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="mx-auto max-w-[720px] px-4 py-10 sm:px-6">
        <div className="rounded-xl border border-border bg-surface shadow-card">
          <EmptyState
            icon={AlertCircle}
            title={`${this.props.label ?? '此页面'}渲染出错`}
            description={error.message || '发生了未知错误。'}
            action={
              <div className="flex gap-2">
                <Button variant="secondary" size="sm" onClick={() => this.setState({ error: null })}>
                  重试
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    this.setState({ error: null });
                    window.location.hash = '#/sessions';
                  }}
                >
                  回到会话页
                </Button>
              </div>
            }
          />
        </div>
      </div>
    );
  }
}
