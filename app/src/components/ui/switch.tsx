import { Switch as SwitchPrimitive } from 'radix-ui'
import type { ComponentProps } from 'react'
import { cn } from '../../lib/cn'

function Switch({ className, ...props }: ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        'peer relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-transparent shadow-xs outline-none transition-all',
        // A fingertip-sized hit area around the 36x20 visual, on touch only.
        '[@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:-inset-3 [@media(pointer:coarse)]:after:content-[""]',
        'data-[state=checked]:bg-foreground data-[state=unchecked]:bg-input',
        'focus-visible:border-primary/55 focus-visible:ring-[3px] focus-visible:ring-primary/15',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          'pointer-events-none block size-4 rounded-full bg-background ring-0 transition-transform',
          'data-[state=checked]:translate-x-[calc(100%-2px)] data-[state=unchecked]:translate-x-0',
          'dark:data-[state=checked]:bg-background dark:data-[state=unchecked]:bg-foreground',
        )}
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
