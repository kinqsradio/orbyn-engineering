const KEY = "orbyn.token";

/**
 * Moves a `?token=` from the address bar into sessionStorage so it does not
 * stay in history or get copied with a shared link. Call before the first request.
 */
export function captureToken(): void {
  const url = new URL(window.location.href);
  const token = url.searchParams.get("token");
  if (token === null) return;
  try {
    if (token) sessionStorage.setItem(KEY, token);
  } catch {
    memoryToken = token;
  }
  url.searchParams.delete("token");
  window.history.replaceState(window.history.state, "", url);
}

let memoryToken: string | null = null;

export function readToken(): string | null {
  try {
    return sessionStorage.getItem(KEY) ?? memoryToken;
  } catch {
    return memoryToken;
  }
}
