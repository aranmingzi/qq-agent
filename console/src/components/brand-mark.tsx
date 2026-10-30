import { cn } from '@/lib/utils';

interface BrandMarkProps {
  size?: number;
  online?: boolean;
  className?: string;
}

export function BrandMark({ size = 32, online, className }: BrandMarkProps) {
  return (
    <span
      className={cn('relative inline-flex shrink-0', className)}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <svg viewBox="0 0 32 32" width={size} height={size} fill="none">
        <rect width="32" height="32" rx="9" className="fill-primary-strong" />
        <circle cx="16" cy="16" r="7.25" stroke="white" strokeOpacity="0.92" strokeWidth="1.6" />
        <circle cx="16" cy="16" r="2.6" fill="white" />
        <circle cx="25" cy="8.5" r="2.1" fill="white" fillOpacity="0.92" />
        <path
          d="M23.3 10.2C21.8 12.1 19.3 13.6 16 14.1"
          stroke="white"
          strokeOpacity="0.55"
          strokeWidth="1.3"
          strokeLinecap="round"
        />
      </svg>
      {online != null ? (
        <span
          className={cn(
            'absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-sidebar',
            online ? 'bg-success' : 'bg-muted',
          )}
        />
      ) : null}
    </span>
  );
}
