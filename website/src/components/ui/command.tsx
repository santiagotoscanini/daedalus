import { useEffect, useRef, useState } from "react";
import { CheckIcon, CopyIcon } from "~/components/icons";

/** One command, whole: it wraps inside its box rather than scrolling, because
 * a line clipped at the edge reads as a shorter command. The copy button is
 * an icon that turns into a tick for two seconds; if the clipboard is closed
 * to the page the line is selected instead, so the keyboard copy takes it. */
export function Command({
  text,
  label,
  active = true,
}: {
  text: string;
  label: string;
  /** a panel that is stacked but hidden keeps its button out of the tab order */
  active?: boolean;
}) {
  const code = useRef<HTMLElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [state, setState] = useState<"idle" | "copied" | "blocked">("idle");

  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async () => {
    clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
      timer.current = setTimeout(() => setState("idle"), 2000);
    } catch {
      const el = code.current;
      const sel = window.getSelection();
      if (el && sel) {
        const range = document.createRange();
        range.selectNodeContents(el);
        sel.removeAllRanges();
        sel.addRange(range);
      }
      setState("blocked");
    }
  };

  return (
    <div>
      <div className="flex min-w-0 items-start gap-2 rounded-xl border border-hairline bg-black/35 py-2.5 pl-4 pr-2">
        <code
          ref={code}
          aria-label={label}
          className="min-w-0 flex-1 select-all break-words py-0.5 font-mono text-[12.5px] leading-[1.7] text-[#c9c9d2]"
        >
          {text}
        </code>
        <button
          type="button"
          onClick={copy}
          tabIndex={active ? 0 : -1}
          aria-label={`Copy: ${label}`}
          className="grid size-8 shrink-0 place-items-center rounded-lg text-muted transition-colors hover:bg-white/[0.06] hover:text-fg"
        >
          {state === "copied" ? (
            <CheckIcon size={15} className="text-status-ok" />
          ) : (
            <CopyIcon size={15} />
          )}
        </button>
      </div>
      <p role="status" className="sr-only">
        {state === "copied" ? "Copied." : state === "blocked" ? "Copying was blocked. The command is selected." : ""}
      </p>
      {state === "blocked" && active ? (
        <p className="mt-2 text-[12px] text-status-warn">Copying was blocked. The command is selected.</p>
      ) : null}
    </div>
  );
}
