/** One replacement of `[start, end)` in a text. */
export interface TextEdit {
    readonly start: number;
    readonly end: number;
    readonly text: string;
}

/** `text` with every edit applied, each against the original offsets. */
export function applyTextEdits(text: string, edits: readonly TextEdit[]): string {
    let edited = text;
    // From the end, so every earlier offset holds.
    for (const edit of [...edits].sort((left, right) => right.start - left.start))
        edited = edited.slice(0, edit.start) + edit.text + edited.slice(edit.end);
    return edited;
}
