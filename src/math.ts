export function lerp(a: number, b: number, alpha: number): number {
    return a + (b - a) * alpha;
}

export function damp(a: number, b: number, lambda: number, dt: number) {
    return lerp(a, b, 1 - Math.exp(lambda * -dt));
}