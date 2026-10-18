import { type ReactNode, useEffect, useRef, useState } from "react";
import { CheckIcon, CopyIcon } from "~/components/icons";

const BREAKS = /:\/\/|\//g;

/** One space-separated word. From 640px it is unbreakable, so a line ends only at a space: Chrome
 * would otherwise split `-Force` after its hyphen. Below 640px a URL is too long for one line, so
 * its <wbr> after `://` and after every other `/` come back. Not after `#`: a flake reference split
 * as `daedalus#` over `config` reads as broken, so `daedalus#config` moves down whole. The <wbr>
 * are removed (display:none) rather than left inside the nowrap word, where Chrome still breaks. */
function word(w: string, key: number): ReactNode {
  const parts: ReactNode[] = [];
  let from = 0;
  for (const m of w.matchAll(BREAKS)) {
    const at = m.index + m[0].length;
    if (at === w.length) break;
    parts.push(w.slice(from, at), <wbr key={at} className="sm:hidden" />);
    from = at;
  }
  parts.push(w.slice(from));
  return (
    <span key={key} className="sm:whitespace-nowrap">
      {parts}
    </span>
  );
}

function words(text: string): ReactNode[] {
  return text.split(/( )/).map((p, i) => (p === " " || p === "" ? p : word(p, i)));
}

/** The command with breaks only at token boundaries: between words, and inside a URL below 640px.
 * A pipe and what follows it (`| sudo sh`) never split, so a line never ends on `|` or `sudo`. A
 * tail of five characters or fewer (`| iex`, `| sh`) would still set alone on a line, so it is tied
 * to the end of the word before, from that word's last `/`: `install.ps1 | iex` moves down whole.
 * In the half-width cards from 1024px the URL can then give up its last segment where it used to
 * leave the tail alone, and the command never takes an extra line for it. From 640 to 1023px the
 * cards stack at full width, where the URL and its tail always fit on one line, so that break is
 * hidden there and the URL stays whole. The tie is a nowrap span around an ordinary space, not
 * U+00A0, so a selection copies a command the shell can run. */
export function breakable(text: string): ReactNode[] {
  const pipe = text.indexOf(" | ");
  if (pipe < 0) return words(text);
  const head = text.slice(0, pipe);
  const tail = text.slice(pipe + 1);
  if (tail.length > 5) {
    return [
      ...words(head),
      " ",
      <span key="tail" className="whitespace-nowrap">
        {tail}
      </span>,
    ];
  }
  const last = head.slice(head.lastIndexOf(" ") + 1);
  let cut = 0;
  for (const m of last.matchAll(BREAKS)) {
    if (m.index + m[0].length < last.length) cut = m.index + m[0].length;
  }
  const rest = head.slice(0, head.length - (last.length - cut));
  return [
    ...words(rest),
    // outside every nowrap span, so it is a break wherever it is shown
    rest && !rest.endsWith(" ") ? <wbr key="tie" className="sm:max-lg:hidden" /> : null,
    <span key="tail" className="whitespace-nowrap">
      {`${last.slice(cut)} ${tail}`}
    </span>,
  ];
}

/** One command, whole: it wraps inside its box rather than scrolling, because a line clipped at the
 * edge reads as a shorter command. The copy button is an icon that turns into a tick for two
 * seconds; if the clipboard is closed to the page the line is selected instead, so the keyboard
 * copy takes it. */
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
      <div className="well flex min-w-0 items-start gap-2 py-3 pl-4 pr-2">
        {/* 5px above and below: a one-line command centres on the 32px button */}
        <code
          ref={code}
          aria-label={label}
          className="t-mono min-w-0 flex-1 select-all whitespace-pre-wrap py-[5px] [overflow-wrap:normal] [word-break:normal]"
        >
          {breakable(text)}
        </code>
        <button
          type="button"
          onClick={copy}
          tabIndex={active ? 0 : -1}
          aria-label={`Copy: ${label}`}
          className="grid size-8 shrink-0 place-items-center rounded-control text-ink-4 transition-colors duration-(--d-1) ease-ui hover:bg-white/6 hover:text-ink-1"
        >
          {state === "copied" ? <CheckIcon size={14} className="text-ok" /> : <CopyIcon size={14} />}
        </button>
      </div>
      <p role="status" className="sr-only">
        {state === "copied" ? "Copied." : state === "blocked" ? "Copying was blocked. The command is selected." : ""}
      </p>
      {state === "blocked" && active ? (
        <p className="t-small mt-2">Copying was blocked. The command is selected.</p>
      ) : null}
    </div>
  );
}
