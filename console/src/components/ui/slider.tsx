import * as SliderPrimitive from '@radix-ui/react-slider';
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from 'react';
import { cn } from '@/lib/utils';

export const Slider = forwardRef<
  ElementRef<typeof SliderPrimitive.Root>,
  ComponentPropsWithoutRef<typeof SliderPrimitive.Root>
>(({ className, ...props }, ref) => (
  <SliderPrimitive.Root
    ref={ref}
    className={cn(
      'relative flex w-full touch-none select-none items-center py-1.5 disabled:opacity-45',
      className,
    )}
    {...props}
  >
    <SliderPrimitive.Track className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-border">
      <SliderPrimitive.Range className="absolute h-full rounded-full bg-primary-strong" />
    </SliderPrimitive.Track>
    <SliderPrimitive.Thumb className="focus-ring block h-4 w-4 rounded-full border-2 border-primary-strong bg-surface shadow-sm transition-transform hover:scale-105 disabled:pointer-events-none" />
  </SliderPrimitive.Root>
));
Slider.displayName = 'Slider';
