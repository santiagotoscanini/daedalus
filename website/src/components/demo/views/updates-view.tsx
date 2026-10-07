import { APP, Btn, Chip, PageHead, SectionHead, Shell, Table, Tabs, Tr } from "../chrome";

/** System › Updates, as the app now draws it: the machines strip across
 * the top (this box, and the machines whose agents link to it), the
 * engine's pin, and the containers behind their registry, one of them
 * opened to its release notes and its one-at-a-time update button.
 * Mirrors app/src/modules/system. Machine names are generic on purpose. */

const COLS = "18px minmax(0,1.2fr) minmax(0,1fr) minmax(0,1fr) 90px";

function Machines() {
  const items = [
    { label: "This box", on: true },
    { label: "Windows PC", n: 2 },
    { label: "MacBook Pro" },
  ];
  return (
    <div
      className="mt-[16px] flex w-fit gap-[2px] rounded-[10px] border p-[3px] text-[12.5px]"
      style={{ borderColor: APP.hairline, background: APP.surface }}
    >
      {items.map((m) => (
        <span
          key={m.label}
          className="flex items-center gap-[7px] rounded-[7px] px-[10px] py-[4px]"
          style={
            m.on
              ? { background: APP.panel2, color: APP.text, fontWeight: 600 }
              : { color: APP.subdued }
          }
        >
          <span
            className="size-[6px] rounded-full"
            style={{ background: m.on ? APP.accent : APP.ok }}
          />
          {m.label}
          {m.n ? <span style={{ color: APP.muted }}>{m.n}</span> : null}
        </span>
      ))}
    </div>
  );
}

function Fact({ label, value, mono = true }: { label: string; value: string; mono?: boolean }) {
  return (
    <span className="flex flex-col gap-[4px]">
      <span className="text-[11.5px]" style={{ color: APP.subdued }}>
        {label}
      </span>
      <span
        className={`${mono ? "font-mono" : ""} text-[12.5px] font-semibold`}
        style={{ color: APP.text }}
      >
        {value}
      </span>
    </span>
  );
}

function Row({
  name,
  from,
  to,
  open = false,
}: {
  name: string;
  from: string;
  to: string;
  open?: boolean;
}) {
  return (
    <>
      <Tr cols={COLS}>
        <span className="text-[9px]" style={{ color: APP.muted }}>
          {open ? "▾" : "▸"}
        </span>
        <span className="text-[13px] font-semibold" style={{ color: APP.text }}>
          {name}
        </span>
        <code className="font-mono text-[12px]" style={{ color: APP.subdued }}>
          {from}
        </code>
        <code className="font-mono text-[12px]" style={{ color: APP.text }}>
          <span style={{ color: APP.muted }}>→ </span>
          {to}
        </code>
        <span className="text-right">
          <Chip tone="warn">newer</Chip>
        </span>
      </Tr>
      {open ? (
        <div className="px-[50px] pb-[14px] pt-[2px]">
          <p className="text-[12px] leading-relaxed" style={{ color: APP.subdued }}>
            <span style={{ color: APP.text }}>13.2.3 · 13.3.0</span>&ensp;Two releases since
            the running one, their notes read from the project's own releases.
          </p>
          <div className="mt-[10px] flex items-center gap-[8px]">
            <Btn>Update to 13.3.0</Btn>
            <Btn ghost>Add to queue</Btn>
            <span className="ml-[6px] text-[11.5px]" style={{ color: APP.muted }}>
              pull · rewrite the pin · commit · rebuild · verify · revert if it does not come back
            </span>
          </div>
        </div>
      ) : null}
    </>
  );
}

export function UpdatesView() {
  return (
    <Shell active="system">
      <PageHead title="System" />
      <Machines />
      <p className="mt-[10px] text-[12.5px]" style={{ color: APP.subdued }}>
        <span className="font-semibold" style={{ color: APP.text }}>
          box
        </span>
        &ensp;NixOS 26.05 (Yarara) · 6.18.55 · x86_64
      </p>
      <Tabs
        items={["Host", "Memory", "Disks", "Pools", "Build", "Updates", "Backups", "Claude"]}
        active="Updates"
      />

      <div className="mt-[18px]">
        <SectionHead title="Engine" />
        <div
          className="grid grid-cols-3 gap-[20px] rounded-[12px] border px-[18px] py-[14px]"
          style={{ borderColor: APP.hairline, background: APP.surface }}
        >
          <Fact label="Pinned" value="d8ea570 2026-10-07" />
          <Fact label="Clone" value="d8ea570 main" />
          <Fact label="Last fetch" value="2026-10-07" />
        </div>
      </div>

      <div className="mt-[20px]">
        <div className="flex items-baseline justify-between">
          <SectionHead title="4 containers behind" />
          <span className="text-[11.5px]" style={{ color: APP.subdued }}>
            registry checked 2026-10-07
          </span>
        </div>
        <Table cols={COLS} head={["", "Container", "Running", "Available", "State"]}>
          <div
            className="flex items-baseline gap-[10px] px-[18px] py-[7px] text-[12px]"
            style={{ background: APP.rail }}
          >
            <span className="font-semibold" style={{ color: APP.text }}>
              Newer release · 3
            </span>
            <span style={{ color: APP.subdued }}>a newer version is published</span>
          </div>
          <Row name="grafana" from="13.2.2" to="13.3.0" open />
          <Row name="traefik" from="v3.6.1" to="v3.6.2" />
          <Row name="pocket-id" from="v1.14.0" to="v1.15.0" />
          <div
            className="flex items-baseline gap-[10px] border-t px-[18px] py-[7px] text-[12px]"
            style={{ background: APP.rail, borderColor: APP.hairline }}
          >
            <span className="font-semibold" style={{ color: APP.text }}>
              Tag moved · 1
            </span>
            <span style={{ color: APP.subdued }}>same tag, a new image behind it</span>
          </div>
          <Tr cols={COLS}>
            <span className="text-[9px]" style={{ color: APP.muted }}>
              ▸
            </span>
            <span className="text-[13px] font-semibold" style={{ color: APP.text }}>
              gluetun
            </span>
            <code className="font-mono text-[12px]" style={{ color: APP.subdued }}>
              latest
            </code>
            <code className="font-mono text-[12px]" style={{ color: APP.text }}>
              <span style={{ color: APP.muted }}>→ </span>new digest
            </code>
            <span className="text-right">
              <Chip tone="info">moved</Chip>
            </span>
          </Tr>
        </Table>
      </div>
    </Shell>
  );
}
