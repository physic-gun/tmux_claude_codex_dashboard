import * as React from 'react';

import { cn } from '../../lib/utils';

// shadcn/ui Label (Tailwind v4 / React 18). Kept dependency-light (plain <label>) since the
// migrated modals only need styling, not the Radix label peer-disabled behaviour.
const Label = React.forwardRef<HTMLLabelElement, React.LabelHTMLAttributes<HTMLLabelElement>>(
  ({ className, ...props }, ref) => (
    <label
      ref={ref}
      className={cn(
        'text-xs font-medium leading-none text-muted-foreground peer-disabled:cursor-not-allowed peer-disabled:opacity-70',
        className
      )}
      {...props}
    />
  )
);
Label.displayName = 'Label';

export { Label };
