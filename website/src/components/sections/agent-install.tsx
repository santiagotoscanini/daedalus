import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { DownloadIcon } from "~/components/icons";
import { Mark, type MarkId } from "~/components/marks";
import { Command } from "~/components/ui/command";

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

/** The tab a key moves to in a tablist of `count`, from tab `i`: the arrows step and wrap, Home and
 * End jump to the ends (the WAI-ARIA tabs pattern). null for every other key, which the caller lets
 * through. Shared with Anywhere's switch, so the page's two tablists answer the same keys. */
export function tabKeyTarget(key: string, i: number, count: number): number | null {
  switch (key) {
    case "ArrowRight":
      return (i + 1) % count;
    case "ArrowLeft":
      return (i - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

/** One of the close's two cards, so both share every measure: the title with its control on one
 * 36px row, the description held to two lines, the command 24px under it, then the button at the
 * foot. The button row takes the slack (mt-auto), so in two cards of one height the commands start
 * level and the buttons land on the same y; a shorter command leaves its space above the button, not
 * under the description. The header row wraps, so a control that asks for a row of its own gets one
 * under the title. From 1024px the sides are 24px, not 32: the 16px it gives back is what sets the
 * engine's command on one line at 1280 and up. */
export function InstallCard({
  title,
  control,
  description,
  command,
  action,
}: {
  title: string;
  control: ReactNode;
  description: ReactNode;
  command: ReactNode;
  action: ReactNode;
}) {
  return (
    <div className="card card-on-band @container flex min-w-0 flex-col p-5 sm:p-8 lg:col-span-6 lg:px-6">
      <div className="flex min-h-9 flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <h3 className="t-title">{title}</h3>
        {control}
      </div>
      <p className="t-body mt-2 min-h-[48px] text-balance">{description}</p>
      <div className="mt-6">{command}</div>
      <div className="mt-auto pt-4">{action}</div>
    </div>
  );
}

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

/** The agent's card: a switch of three systems, one command, one button. A Mac has an app to
 * download; Windows and Linux install from the line, so their button opens the releases. The three
 * commands are stacked in one grid area, each at its top, and the two not shown are only made
 * invisible, so the card is as tall as its tallest line from the first paint and the switch moves
 * nothing. From 1024px the description sets a sentence per line: balanced alone it strands "One" at
 * the end of the first. Below 640px the switch takes its own row under the title, so every system
 * keeps its name; only a card narrower than the whole switch (under 296px inside, a phone narrower
 * than 390) names just the selected system, and the others keep their mark. Prerender has no
 * navigator, so the static page shows Windows; after hydration the visitor's own system is
 * selected. */
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
    const next = tabKeyTarget(e.key, i, OSES.length);
    if (next === null) return;
    e.preventDefault();
    select(OSES[next]!.id, true);
  };

  const control = (
    // the full-width wrapper is what sends the switch to its own row below 640px; the switch inside
    // keeps its own width
    <div className="max-sm:basis-full">
      <div role="tablist" aria-label="Operating system" className="seg max-w-full">
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
              className="seg-item hover:text-ink-1"
            >
              <Mark id={o.mark} size={14} />
              <span className={active ? "" : "@max-[18.5rem]:sr-only"}>{o.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );

  const command = (
    <div className="grid">
      {OSES.map((o) => {
        const active = o.id === selected;
        return (
          <div
            key={o.id}
            role="tabpanel"
            id={`${baseId}-panel-${o.id}`}
            aria-labelledby={`${baseId}-tab-${o.id}`}
            className={`col-start-1 row-start-1 min-w-0 self-start ${active ? "" : "invisible"}`}
          >
            <Command text={o.command} label={`${o.label} install command`} active={active} />
          </div>
        );
      })}
    </div>
  );

  const action =
    selected === "macos" ? (
      <a href={MAC_DMG} className="btn btn-secondary">
        <DownloadIcon />
        Download for macOS
      </a>
    ) : (
      <a href={AGENT_RELEASES} className="btn btn-secondary">
        <Mark id="github" size={16} />
        Releases on GitHub
      </a>
    );

  return (
    <InstallCard
      title="The agent"
      control={control}
      description={
        <>
          For Windows, macOS and Linux. <br className="max-lg:hidden" />
          One connection to the box, approved by you.
        </>
      }
      command={command}
      action={action}
    />
  );
}
