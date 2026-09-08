/** A statement supplies its own parentheses around the condition. */
export function cppCondition(text: string): string {
    if (!text.startsWith("(") || !text.endsWith(")")) return text;
    let depth = 0;
    for (let index = 0; index < text.length; index += 1) {
        if (text[index] === "(") depth += 1;
        else if (text[index] === ")") {
            depth -= 1;
            if (depth === 0 && index !== text.length - 1) return text;
        }
    }
    return text.slice(1, -1);
}
