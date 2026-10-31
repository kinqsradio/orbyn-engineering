/** What the add-project path field shows and means, on either platform's paths. */

const SEP = /[\\/]/;
const DRIVE_ROOT = /^[A-Za-z]:[\\/]$/;

const lastSep = (value: string) => Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));

/** A path that means the same thing wherever it starts: POSIX, drive, UNC or home. */
const startsFresh = (path: string) =>
  path === "~" || /^[\\/]/.test(path) || /^[A-Za-z]:[\\/]/.test(path) || /^~[\\/]/.test(path);

/**
 * The field starts on `~/`, so typing `/` or pasting a whole path lands after it.
 * Such a path replaces that prefix instead of nesting under home.
 */
export function replaceHomePrefix(value: string): string {
  const rest = value.replace(/^\s+/, "");
  if (!/^~[\\/]/.test(rest)) return rest;
  const after = rest.slice(2);
  return startsFresh(after) ? after : rest;
}

export function splitPath(value: string): { dir: string; leaf: string } {
  if (value === "~") return { dir: "~/", leaf: "" };
  const at = lastSep(value);
  return { dir: value.slice(0, at + 1), leaf: value.slice(at + 1) };
}

const separatorOf = (path: string) => (path.includes("\\") && !path.includes("/") ? "\\" : "/");

export const withSlash = (path: string) => (SEP.test(path.slice(-1)) ? path : `${path}${separatorOf(path)}`);

export const shortenHome = (path: string, home: string) => {
  if (path === home) return "~/";
  const prefix = withSlash(home);
  return path.startsWith(prefix) ? `~/${path.slice(prefix.length)}` : path;
};

export const expandHome = (path: string, home: string) =>
  path === "~" || /^~[\\/]/.test(path) ? `${withSlash(home)}${path.slice(2)}` : path;

/** The folder a typed path names. A root keeps its slash: `C:` alone is not `C:\`. */
export function dropTrailingSlash(path: string): string {
  return path.length > 1 && !DRIVE_ROOT.test(path) ? path.replace(/[\\/]+$/, "") : path;
}
