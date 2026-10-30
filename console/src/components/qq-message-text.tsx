import { useMemo, useState } from 'react';
import { useQqFaces } from '@/hooks/use-qq-faces';
import { faceImageUrl, parseFaceTokens } from '@/lib/qq-face';
import { cn } from '@/lib/utils';

/**
 * 消息正文渲染：把「[表情:笑哭]」这类标记显示成真的 QQ 表情图。
 * 图拿不到（离线 / 没图号 / 未知表情）就退回一个带名字的小标签 —— 总之不会只剩下看不懂的数字。
 */

function FaceChip({ name, pack = false }: { name: string; pack?: boolean }) {
  return (
    <span
      title={`QQ ${pack ? '表情包' : '表情'}：${name}`}
      className={cn(
        'mx-0.5 inline-flex items-baseline gap-0.5 rounded border px-1 align-baseline text-[11px] leading-[16px]',
        pack
          ? 'border-border bg-surface-muted/80 text-muted'
          : 'border-border bg-surface-muted text-foreground/75',
      )}
    >
      {pack ? <span className="text-[10px] text-muted">表情包</span> : null}
      {name}
    </span>
  );
}

function FaceImage({ name, em }: { name: string; em: string }) {
  const [failed, setFailed] = useState(false);
  const url = faceImageUrl(em);
  if (!url || failed) return <FaceChip name={name} />;
  return (
    <img
      src={url}
      alt={`[表情:${name}]`}
      title={`QQ 表情：${name}`}
      draggable={false}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className="mx-px inline-block h-[17px] w-[17px] align-[-3px]"
    />
  );
}

interface QqMessageTextProps {
  text: string;
  className?: string;
  as?: 'p' | 'span' | 'div';
}

export function QqMessageText({ text, className, as: Tag = 'p' }: QqMessageTextProps) {
  const faces = useQqFaces();
  const source = String(text ?? '');
  const tokens = useMemo(() => parseFaceTokens(source, faces), [source, faces]);

  if (!source.includes('[表情')) return <Tag className={className}>{source}</Tag>;

  return (
    <Tag className={className}>
      {tokens.map((token, index) => {
        if (token.kind === 'text') return <span key={index}>{token.text}</span>;
        if (token.kind === 'pack') return <FaceChip key={index} name={token.name} pack />;
        return <FaceImage key={index} name={token.name} em={token.em} />;
      })}
    </Tag>
  );
}
