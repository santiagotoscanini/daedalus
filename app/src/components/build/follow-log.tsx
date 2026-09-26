import { useEffect, useRef } from 'react'

// A build log that follows its own end while it grows, unless the reader has
// scrolled up — then it stays where they left it until they scroll back down.

const LOG_BOX =
  'm-0 max-h-[36rem] overflow-auto overscroll-contain rounded-[9px] border border-(--border-soft) bg-background p-3 font-mono text-[0.74rem] leading-[1.5] whitespace-pre text-(--text-muted)'

export function FollowLog({ text }: { text: string }) {
  // Follow the log's end while it grows, unless the reader has scrolled up.
  const logRef = useRef<HTMLPreElement>(null)
  const follow = useRef(true)
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the text changes, by design.
  useEffect(() => {
    const el = logRef.current
    if (el !== null && follow.current) el.scrollTop = el.scrollHeight
  }, [text])

  return (
    <pre
      ref={logRef}
      className={LOG_BOX}
      onScroll={(e) => {
        const el = e.currentTarget
        follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
      }}
    >
      {text}
    </pre>
  )
}
