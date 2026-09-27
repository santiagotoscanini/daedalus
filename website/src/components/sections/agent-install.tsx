import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import {
  AppleLogo,
  CheckIcon,
  CopyIcon,
  GitHubLogo,
  LinuxLogo,
  WindowsLogo,
} from "~/components/icons";

const REPO = "https://github.com/santiagotoscanini/daedalus";
/** GitHub's release search matches titles, not tags: the releases are titled
 * "daedalus-agent <version>", so that is the word that lists them. */
const AGENT_RELEASES = `${REPO}/releases?q=daedalus-agent`;
const AGENT_README = `${REPO}/blob/main/agent/README.md`;

/** The installers are served from this site (copied from agent/install.ps1
 * and agent/install.sh at build time), so no line names a version: the
 * script finds the newest agent release itself. The Windows line is the
 * README's two lines joined, so it pastes as one. */
const INSTALL_WINDOWS =
  "Set-ExecutionPolicy -Scope Process Bypass -Force; irm https://daedalus.toscanini.me/install.ps1 | iex";
/** One script for macOS and Linux: it branches on `uname`. */
const INSTALL_UNIX = "curl -fsSL https://daedalus.toscanini.me/install.sh | sudo sh";

type OsId = "windows" | "macos" | "linux";

/** The Linux note carries the one fact the "early" tag does not: no release
 * has a Linux build yet, and install.sh stops with "no Linux release yet"
 * until one does. Drop its last sentence when the first one ships. */
const OSES: { id: OsId; label: string; Icon: typeof WindowsLogo; command: string; note: string }[] =
  [
    {
      id: "windows",
      label: "Windows",
      Icon: WindowsLogo,
      command: INSTALL_WINDOWS,
      note: "In PowerShell as administrator.",
    },
    {
      id: "macos",
      label: "macOS",
      Icon: AppleLogo,
      command: INSTALL_UNIX,
      note: "In Terminal. Apple silicon and Intel.",
    },
    {
      id: "linux",
      label: "Linux",
      Icon: LinuxLogo,
      command: INSTALL_UNIX,
      note: "Any systemd distribution (systemd 240+), x86_64 or aarch64. Tray icon on x86_64 desktops. No Linux build is released yet.",
    },
  ];

/** Which tab the visitor's own machine is. Phones and tablets get the
 * default: none of them runs the agent, and a guess would only be wrong. */
function detectOs(): OsId | null {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = (nav.userAgentData?.platform ?? "").toLowerCase();
  const ua = navigator.userAgent.toLowerCase();
  if (/android|iphone|ipad|ipod|cros/.test(ua) || /android|chrome os|ios/.test(platform)) {
    return null;
  }
  const s = platform || ua;
  if (s.includes("win")) return "windows";
  if (s.includes("mac")) return "macos";
  if (s.includes("linux")) return "linux";
  return null;
}

/** The agent's install block: a picker for the three systems, one button
 * that copies the selected system's line, and the line itself underneath,
 * small but always shown, because it runs as root and should be read
 * before it is pasted.
 *
 * Prerender has no navigator, so the static page shows Windows (the first
 * tab); after hydration the visitor's own system is selected. All three
 * panels are stacked in one grid cell and the inactive two are only made
 * invisible, so the block is as tall as its tallest panel from the first
 * paint and the switch moves nothing. */
export function AgentInstall() {
  const [selected, setSelected] = useState<OsId>("windows");
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const tabs = useRef<Record<OsId, HTMLButtonElement | null>>({
    windows: null,
    macos: null,
    linux: null,
  });
  const commands = useRef<Record<OsId, HTMLElement | null>>({
    windows: null,
    macos: null,
    linux: null,
  });
  const baseId = useId();

  useEffect(() => {
    const os = detectOs();
    if (os !== null) setSelected(os);
    return () => clearTimeout(timer.current);
  }, []);

  const current = OSES.find((o) => o.id === selected) ?? OSES[0]!;

  const select = (id: OsId, focus = false) => {
    setSelected(id);
    setCopied(false);
    setFailed(false);
    clearTimeout(timer.current);
    if (focus) tabs.current[id]?.focus();
  };

  /** Arrows move from the tab that has focus, which is the selected one
   * unless something focused another by script. */
  const onTabKey = (i: number) => (e: KeyboardEvent<HTMLButtonElement>) => {
    const next =
      e.key === "ArrowRight"
        ? (i + 1) % OSES.length
        : e.key === "ArrowLeft"
          ? (i - 1 + OSES.length) % OSES.length
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? OSES.length - 1
              : null;
    if (next === null) return;
    e.preventDefault();
    select(OSES[next]!.id, true);
  };

  const copy = async () => {
    clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(current.command);
      setFailed(false);
      setCopied(true);
      setAnnouncement(`Copied the ${current.label} install command.`);
      timer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // No clipboard (permissions, an old browser): select the line so a
      // keyboard copy takes it, and say so.
      const el = commands.current[current.id];
      const selection = window.getSelection();
      if (el && selection) {
        const range = document.createRange();
        range.selectNodeContents(el);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      setCopied(false);
      setFailed(true);
      setAnnouncement("Copying was blocked. The command is selected; copy it from the keyboard.");
    }
  };

  const copyKey = current.id === "macos" ? "⌘C" : "Ctrl+C";

  return (
    <div className="mt-6">
      <div
        role="tablist"
        aria-label="Operating system"
        className="grid grid-cols-3 gap-1 rounded-[0.75rem] border border-hairline bg-black/30 p-1"
      >
        {OSES.map((o, i) => {
          const active = o.id === selected;
          return (
            <button
              key={o.id}
              ref={(el) => {
                tabs.current[o.id] = el;
              }}
              type="button"
              role="tab"
              id={`${baseId}-tab-${o.id}`}
              aria-selected={active}
              aria-controls={`${baseId}-panel-${o.id}`}
              tabIndex={active ? 0 : -1}
              onClick={() => select(o.id)}
              onKeyDown={onTabKey(i)}
              className={`inline-flex h-10 min-w-0 items-center justify-center gap-2 rounded-[0.5rem] text-[13.5px] font-medium transition-colors ${
                active
                  ? "bg-white/[0.08] text-fg shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]"
                  : "text-muted hover:bg-white/[0.03] hover:text-fg"
              }`}
            >
              <o.Icon size={15} className="shrink-0" />
              {o.label}
            </button>
          );
        })}
      </div>

      <div className="mt-4 flex flex-wrap gap-3">
        <button
          type="button"
          onClick={copy}
          aria-label={`Copy install command for ${current.label}`}
          className="btn btn-primary h-11 grow px-5 sm:grow-0"
        >
          {/* Both labels share one grid cell, so the button keeps the width
              of the longer one and "Copied" does not shrink it. */}
          <span className="grid">
            <span
              className={`col-start-1 row-start-1 inline-flex items-center justify-center gap-2 ${copied ? "invisible" : ""}`}
            >
              <CopyIcon size={15} />
              Copy install command
            </span>
            <span
              className={`col-start-1 row-start-1 inline-flex items-center justify-center gap-2 ${copied ? "" : "invisible"}`}
            >
              <CheckIcon size={15} className="text-status-ok" />
              Copied
            </span>
          </span>
        </button>
        <a href={AGENT_RELEASES} className="btn btn-ghost h-11 grow px-5 sm:grow-0">
          <GitHubLogo size={15} />
          All releases
        </a>
      </div>

      <div className="mt-4 grid">
        {OSES.map((o) => {
          const active = o.id === selected;
          return (
            <div
              key={o.id}
              role="tabpanel"
              id={`${baseId}-panel-${o.id}`}
              aria-labelledby={`${baseId}-tab-${o.id}`}
              className={`col-start-1 row-start-1 min-w-0 ${active ? "" : "invisible"}`}
            >
              <CommandLine
                text={o.command}
                label={`${o.label} install command`}
                codeRef={(el) => {
                  commands.current[o.id] = el;
                }}
              />
              {active && failed && (
                <p className="mt-2.5 text-pretty text-[12px] leading-relaxed text-status-warn">
                  Copying was blocked. The command is selected; press {copyKey} to copy it.
                </p>
              )}
              <p className="mt-2.5 text-pretty text-[12px] leading-relaxed text-dim">{o.note}</p>
            </div>
          );
        })}
      </div>

      <p role="status" className="sr-only">
        {announcement}
      </p>

      <p className="mt-2.5 text-pretty text-[12px] leading-relaxed text-dim">
        What it installs, and how it updates, is in the{" "}
        <a
          href={AGENT_README}
          className="underline decoration-hairline underline-offset-4 transition-colors hover:text-fg"
        >
          agent's README
        </a>
        .
      </p>
    </div>
  );
}

/** The command as one line that scrolls inside itself. A clipped line with
 * no sign of the rest reads as a shorter command, so the right edge fades
 * while there is more to scroll to, and the scrollbar is kept visible. The
 * scroller takes focus, so a keyboard can scroll it too. */
function CommandLine({
  text,
  label,
  codeRef,
}: {
  text: string;
  label: string;
  codeRef: (el: HTMLElement | null) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState(false);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const update = () => setMore(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, []);

  return (
    <div className="relative rounded-lg border border-hairline bg-black/30">
      <div
        ref={scroller}
        tabIndex={0}
        role="region"
        aria-label={label}
        className="cmd-scroll overflow-x-auto rounded-lg px-3.5 py-2.5"
      >
        <code
          ref={codeRef}
          className="select-all whitespace-nowrap font-mono text-[12px] leading-relaxed text-muted"
        >
          {text}
        </code>
      </div>
      <div
        aria-hidden
        className={`pointer-events-none absolute inset-y-px right-px w-10 rounded-r-lg bg-linear-to-l from-[#0a0a0c] to-transparent transition-opacity ${more ? "opacity-100" : "opacity-0"}`}
      />
    </div>
  );
}
