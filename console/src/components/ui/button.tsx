import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'focus-ring inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-lg text-[13px] font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary:
          'bg-primary-strong text-primary-foreground shadow-sm hover:bg-primary-strong/90 active:bg-primary-strong/95',
        secondary:
          'border border-border bg-surface text-foreground shadow-sm hover:border-border-strong hover:bg-surface-muted',
        outline:
          'border border-border bg-transparent text-foreground hover:border-border-strong hover:bg-surface-muted',
        ghost: 'text-muted hover:bg-surface-muted hover:text-foreground',
        subtle: 'bg-primary-soft text-primary hover:bg-primary-soft/80',
        danger: 'bg-danger text-white shadow-sm hover:bg-danger/90',
        'danger-ghost':
          'border border-danger/25 bg-transparent text-danger hover:border-danger/40 hover:bg-danger-soft',
        link: 'h-auto rounded-none p-0 text-primary underline-offset-4 hover:underline',
      },
      size: {
        sm: 'h-8 px-3 text-[12.5px] [&_svg]:h-3.5 [&_svg]:w-3.5',
        md: 'h-9 px-3.5 [&_svg]:h-4 [&_svg]:w-4',
        lg: 'h-10 px-4 text-sm [&_svg]:h-4 [&_svg]:w-4',
        icon: 'h-8 w-8 [&_svg]:h-4 [&_svg]:w-4',
        'icon-sm': 'h-7 w-7 [&_svg]:h-3.5 [&_svg]:w-3.5',
        'icon-lg': 'h-9 w-9 [&_svg]:h-[17px] [&_svg]:w-[17px]',
      },
    },
    defaultVariants: {
      variant: 'secondary',
      size: 'md',
    },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, type = 'button', ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  ),
);

Button.displayName = 'Button';
export { buttonVariants };
