import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { Command } from "~/components/ui/command";
import { Mark, type MarkId } from "~/components/walk/marks";

const REPO = "https://github.com/santiagotoscanini/daedalus";
/** The newest release's disk image, by the fixed name every release gives
 * it, so the link never names a version (agent/macos/package.sh). */
const MAC_DMG = `${REPO}/releases/latest/download/daedalus-agent-macos.dmg`;
/** GitHub's release search matches titles, not tags: the releases are titled
 * "daedalus-agent <version>", so that is the word that lists them. */
const AGENT_RELEASES = `${REPO}/releases?q=daedalus-agent`;

/** The installers are served from this site (copied from agent/install.ps1
 * and agent/install.sh at build time), so no line names a version: the
 * script finds the newest agent release itself. */
const INSTALL_WINDOWS =
  "Set-ExecutionPolicy -Scope Process Bypass -Force; irm https://daedalus.toscanini.me/install.ps1 | iex";
/** One script for macOS and Linux: it branches on `uname`. */
const INSTALL_UNIX = "curl -fsSL https://daedalus.toscanini.me/install.sh | sudo sh";

type OsId = "windows" | "macos" | "linux";

const OSES: { id: OsId; label: string; mark: MarkId; command: string }[] = [
  { id: "windows", label: "Windows", mark: "windows", command: INSTALL_WINDOWS },
  { id: "macos", label: "macOS", mark: "apple", command: INSTALL_UNIX },
  { id: "linux", label: "Linux", mark: "linux", command: INSTALL_UNIX },
];

/** Which entry the visitor's own machine is. Phones and tablets keep the
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

/** The agent: a switch of three systems, one button, one command. A Mac has
 * an app to download; Windows and Linux install from the line, so their
 * button opens the releases. The three commands are stacked in one grid cell
 * and the two not shown are only made invisible, so the card is as tall as
 * its tallest line from the first paint and the switch moves nothing.
 * Prerender has no navigator, so the static page shows Windows; after
 * hydration the visitor's own system is selected. */
export function AgentInstall() {
  const [selected, setSelected] = useState<OsId>("windows");
  const tabs = useRef<Record<OsId, HTMLButtonElement | null>>({ windows: null, macos: null, linux: null });
  const baseId = useId();

  useEffect(() => {
    const os = detectOs();
    if (os !== null) setSelected(os);
  }, []);

  const select = (id: OsId, focus = false) => {
    setSelected(id);
    if (focus) tabs.current[id]?.focus();
  };

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

  return (
    <>
      <div
        role="tablist"
        aria-label="Operating system"
        className="flex h-9 w-fit max-w-full items-center gap-0.5 rounded-full border border-hairline bg-black/30 p-0.5"
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
              aria-label={o.label}
              tabIndex={active ? 0 : -1}
              onClick={() => select(o.id)}
              onKeyDown={onTabKey(i)}
              className={`inline-flex h-8 items-center justify-center gap-2 rounded-full px-3 text-[12.5px] font-medium transition-colors ${
                active ? "bg-white/[0.09] text-fg" : "text-muted hover:text-fg"
              }`}
            >
              <Mark id={o.mark} size={14} />
              <span className={active ? "" : "max-sm:sr-only"}>{o.label}</span>
            </button>
          );
        })}
      </div>

      <h3 className="mt-6 text-[1.45rem] font-semibold leading-snug tracking-[-0.015em]">The agent</h3>
      <p className="mt-1.5 text-[14.5px] leading-relaxed text-muted">For Windows, macOS and Linux.</p>

      {selected === "macos" ? (
        <a href={MAC_DMG} className="btn btn-primary mt-7 h-11 self-start px-5">
          <Mark id="apple" size={17} />
          Download for Mac
        </a>
      ) : (
        <a href={AGENT_RELEASES} className="btn btn-primary mt-7 h-11 self-start px-5">
          <Mark id="github" size={17} />
          Releases on GitHub
        </a>
      )}

      <div className="mt-auto grid pt-6">
        {OSES.map((o) => {
          const active = o.id === selected;
          return (
            <div
              key={o.id}
              role="tabpanel"
              id={`${baseId}-panel-${o.id}`}
              aria-labelledby={`${baseId}-tab-${o.id}`}
              className={`col-start-1 row-start-1 min-w-0 self-end ${active ? "" : "invisible"}`}
            >
              <Command text={o.command} label={`${o.label} install command`} active={active} />
            </div>
          );
        })}
      </div>
    </>
  );
}
