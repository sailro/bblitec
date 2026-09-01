let active = false;

export function activate(): void {
    active = true;
}

export function isActive(): boolean {
    return active;
}
