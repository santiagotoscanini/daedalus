import { createFileRoute } from "@tanstack/react-router";
import { Universe } from "~/components/universe/universe";
import { iconUrl } from "~/data/icons";
import { type Group, SHOWN } from "~/data/services";
import { pageHead } from "~/site-head";

/** /integrations: everything the engine runs or talks to, out of the landing, where the argument is
 * the person and not the parts. The wall is the picture; the three lists under it say the same
 * thing in words, sorted by what kind of thing each is, for a reader who wants to find one name. */

export const Route = createFileRoute("/integrations")({
  component: IntegrationsPage,
  head: () =>
    pageHead({
      path: "/integrations",
      title: "daedalus integrations: everything it runs and talks to",
      description:
        "The services the daedalus engine can switch on, what the reference box runs beside them, and the outside services it talks to.",
    }),
});

const GROUPS: Array<{ id: Group; title: string; note: string }> = [
  {
    id: "catalog",
    title: "In the engine's catalog",
    note: "Modules a house switches on with one line. Their pins, secrets and policy stay in the house's own repository.",
  },
  {
    id: "beside",
    title: "Run beside it on the reference box",
    note: "Stacks that box declares itself. Most are read by a page of the control plane, and they move into the catalog as they are generalised.",
  },
  {
    id: "outside",
    title: "Outside services it talks to",
    note: "Where the code lives, where the names are, and the APIs the box or its gateway call.",
  },
];

function IntegrationsPage() {
  return (
    <main id="main">
      <header className="wrap pb-4 pt-28 lg:pt-40">
        <h1 id="integrations-title" className="t-display max-w-[792px]">
          Everything it touches.
        </h1>
        <p className="t-lead mt-6 max-w-[588px]">
          What the engine runs, what one house runs beside it, and what it connects to. Hold a mark to see its
          name.
        </p>
      </header>

      <Universe />

      <div className="wrap grid gap-14 pb-32 md:grid-cols-3 md:gap-6">
        {GROUPS.map((g) => {
          const list = SHOWN.filter((s) => s.group === g.id);
          return (
            <section key={g.id} aria-labelledby={`int-${g.id}`}>
              <h2 id={`int-${g.id}`} className="t-body font-medium text-ink-1">
                {g.title}
              </h2>
              <p className="t-body mt-2">{g.note}</p>
              <ul className="mt-5 border-t border-edge-1">
                {list.map((s) => (
                  <li key={s.id} className="t-body flex min-h-11 items-center gap-3 border-b border-edge-1 py-2 text-ink-2">
                    <img src={iconUrl(s.id)} alt="" width={18} height={18} className="size-[18px] object-contain" loading="lazy" />
                    {s.name}
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </main>
  );
}
