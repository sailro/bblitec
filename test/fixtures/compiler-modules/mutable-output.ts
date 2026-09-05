export interface MutableOutput {
    x: number;
    y: number;
}

export function writeMutableOutput(
    value: number,
    output: MutableOutput,
): MutableOutput {
    output.x = value;
    output.y = value * 2;
    return output;
}
