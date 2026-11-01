export const actionCommand = (id: string) => `script.${id}.run`;
export const actionIdFromCommand = (command: string): string | null => /^script\.([A-Za-z0-9_-]{1,128})\.run$/.exec(command)?.[1] ?? null;
