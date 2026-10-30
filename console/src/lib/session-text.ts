import type { SessionDetail } from '@/types';
import { formatFull } from '@/lib/format';

function stringifyArgs(args: Record<string, unknown> | string) {
  return typeof args === 'string' ? args : JSON.stringify(args, null, 2);
}

export function sessionToText(session: SessionDetail) {
  const lines: string[] = [
    `# 会话 ${session.id}｜${session.chatKey}｜${session.status}`,
    `开始：${formatFull(session.startedAt)}`,
  ];
  if (session.endedAt) lines.push(`结束：${formatFull(session.endedAt)}`);
  if (session.model) lines.push(`模型：${session.model}`);
  if (session.triggerSummary) lines.push(`触发：${session.triggerSummary}`);
  if (session.systemPrompt) {
    lines.push('', '===== 系统提示 =====', session.systemPrompt);
  }
  if (session.userPrompt) {
    lines.push('', '===== 本次输入 =====', session.userPrompt);
  }

  for (const item of session.messages) {
    if (item.kind === 'tool') {
      lines.push(
        '',
        `[工具 ${item.toolCall.name}${item.toolCall.isError ? ' 失败' : ''}]`,
        `参数：${stringifyArgs(item.toolCall.args)}`,
        `结果：${item.toolCall.result}`,
      );
    } else if (item.kind === 'assistant') {
      lines.push('', '[思考（不发送）]', item.content);
    } else {
      lines.push('', `[图片输入] ${item.tool} → ${item.count} 张`);
    }
  }

  for (const sent of session.sent) {
    lines.push('', `[已发送到 QQ${sent.at ? ` ${sent.at}` : ''}]`, sent.text);
  }

  if (session.error) lines.push('', '[错误]', session.error);
  if (session.finishReason) lines.push('', `[finish] ${session.finishReason}`);
  return lines.join('\n');
}

export function toolCallToText(name: string, args: unknown, result: string) {
  const argsText = typeof args === 'string' ? args : JSON.stringify(args, null, 2);
  return `[${name}]\n${argsText}\n\n${result}`;
}
