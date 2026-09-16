export const KINDS = ["oak", "pine"] as const;

export function seedCount(kind: string): number {
    return kind.length;
}
