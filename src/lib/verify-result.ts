// Shared public result types and verdict formatting for /verify. Kept free of
// database imports so the Verify form can format verdicts directly on the
// client while unit tests cover the exact wording in Node.

export type VerifyFileKind = "signed-document" | "certificate";

export type VerifyEnvelopeStatus = "completed" | "declined" | "voided";

export type VerifyResult =
  | { match: false }
  | {
      /** People who approved or rejected instead of signing. */
      approverCount: number;
      envelopeDeleted: false;
      envelopeId: string;
      fileKind: VerifyFileKind;
      finishedAt: number | null;
      match: true;
      signerCount: number;
      status: VerifyEnvelopeStatus;
      title: string;
    }
  | {
      deletedAt: number | null;
      envelopeDeleted: true;
      envelopeId: string | null;
      fileKind: VerifyFileKind;
      finishedAt: number | null;
      match: true;
      status: VerifyEnvelopeStatus | null;
      title: string | null;
    };

export type VerifyVerdict = {
  detail: string;
  heading: string;
  tone: "danger" | "success";
};

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  dateStyle: "long",
  timeStyle: "short",
  timeZone: "UTC",
});

const STATUS_WORDS: Record<VerifyEnvelopeStatus, string> = {
  completed: "completed",
  declined: "declined",
  voided: "voided",
};

function formatUtcTimestamp(timestamp: number): string {
  return `${dateFormatter.format(new Date(timestamp * 1000))} UTC`;
}

export function formatVerifyVerdict(result: VerifyResult): VerifyVerdict {
  if (!result.match) {
    return {
      detail:
        "This site has no record of this exact file. It may be an unsigned copy, have been changed or saved again by another program, come from somewhere else, or belong to a record that has been removed. Check the digital seal in a PDF reader, or ask the sender for their copy.",
      heading: "No match.",
      tone: "danger",
    };
  }

  const fileLabel =
    result.fileKind === "signed-document"
      ? "signed document"
      : "audit certificate";

  if (result.envelopeDeleted) {
    const heading = result.title
      ? `This file is unchanged. It is the ${fileLabel} this site produced for \u201c${result.title}\u201d.`
      : `This file is unchanged. It is the ${fileLabel} this site produced.`;
    const details: string[] = [];

    if (result.status) {
      details.push(
        `The envelope was ${STATUS_WORDS[result.status]}${
          result.finishedAt !== null
            ? ` on ${formatUtcTimestamp(result.finishedAt)}`
            : ""
        }.`,
      );
    }

    details.push(
      result.deletedAt !== null
        ? `Its envelope record was deleted from this site on ${formatUtcTimestamp(result.deletedAt)}.`
        : "Its envelope record has since been deleted from this site.",
    );

    if (result.envelopeId) {
      details.push(`Envelope ID ${result.envelopeId}.`);
    }

    return {
      detail: details.join(" "),
      heading,
      tone: "success",
    };
  }

  return {
    detail: `The envelope was ${STATUS_WORDS[result.status]}${
      result.finishedAt !== null
        ? ` on ${formatUtcTimestamp(result.finishedAt)}`
        : ""
    } with ${result.signerCount} signer${result.signerCount === 1 ? "" : "s"}${
      result.approverCount
        ? ` and ${result.approverCount} approver${result.approverCount === 1 ? "" : "s"}`
        : ""
    }. Envelope ID ${result.envelopeId}.`,
    heading: `This file is unchanged. It is the ${fileLabel} this site produced for \u201c${result.title}\u201d.`,
    tone: "success",
  };
}
