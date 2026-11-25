import Link from "next/link";
import { Fragment } from "react";

import type { LegalInlinePart } from "@/lib/legal";

const legalLinkClassName =
  "font-semibold text-(--accent-ink) underline decoration-[rgb(var(--accent-rgb)/0.35)] underline-offset-4";

export function LegalInlineText({
  parts,
}: {
  parts: readonly LegalInlinePart[];
}) {
  return (
    <>
      {parts.map((part, index) => {
        if (part.type === "text") {
          return <Fragment key={index}>{part.text}</Fragment>;
        }

        if (part.type === "email") {
          return (
            <a className={legalLinkClassName} href={part.href} key={index}>
              {part.address}
            </a>
          );
        }

        return (
          <Link className={legalLinkClassName} href={part.href} key={index}>
            {part.label}
          </Link>
        );
      })}
    </>
  );
}
