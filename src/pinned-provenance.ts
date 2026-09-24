/**
 * The provenance a generated artifact names its pinned source with.
 *
 * `LoweringContext.provenance` writes it, and every deployed pinned module
 * opens with it as one `//` comment line. The browser's own modules carry no
 * such line, so a reader comparing a deployed module against them drops
 * exactly this one, recognized by what the writer writes.
 */

/** What every provenance opens with, ahead of the pin and the source it names. */
export const pinnedProvenanceLead = "Generated from ";

/** The comment line a deployed module opens with, up to the pin it names. */
const pinnedProvenanceComment = `// ${pinnedProvenanceLead}`;

/**
 * `text` without the provenance comment line it opens with; `text` itself
 * when its first line is not one.
 */
export function withoutPinnedProvenance(text: string): string {
    if (!text.startsWith(pinnedProvenanceComment)) return text;
    const end = text.indexOf("\n");
    return end < 0 ? "" : text.slice(end + 1);
}
