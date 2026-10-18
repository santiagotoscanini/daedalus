import type { ReactNode } from "react";
import { Reveal } from "~/components/reveal";

/** Every section's header: a quiet label with the brand's dot, a headline, an optional line under it. */
export function SectionHeading({
  label,
  title,
  sub,
  align = "left",
  id,
}: {
  label?: string;
  title: ReactNode;
  sub?: ReactNode;
  align?: "center" | "left";
  id?: string;
}) {
  const center = align === "center";
  return (
    <Reveal className={center ? "mx-auto max-w-[46rem] text-center" : "max-w-[50rem]"}>
      {label ? (
        <p className={`label flex items-center gap-2 ${center ? "justify-center" : ""}`}>
          <span className="size-1.5 rounded-full bg-accent" aria-hidden />
          {label}
        </p>
      ) : null}
      <h2 id={id} className="h-section mt-4 text-[clamp(2rem,4.2vw,3.1rem)]">
        {title}
      </h2>
      {sub ? <p className={`lede mt-5 ${center ? "mx-auto" : ""} max-w-[38rem]`}>{sub}</p> : null}
    </Reveal>
  );
}
