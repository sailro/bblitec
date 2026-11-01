/** Literal text embedded in a RegExp source. */
export function regexText(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
