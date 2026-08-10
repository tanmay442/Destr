import * as React from "react"

import { cn } from "@/lib/utils"

function Eyebrow({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="eyebrow"
      className={cn(
        "text-[11px] font-medium tracking-[0.08em] text-muted-foreground uppercase",
        className
      )}
      {...props}
    />
  )
}

export { Eyebrow }
