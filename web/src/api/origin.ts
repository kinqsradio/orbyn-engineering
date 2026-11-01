/** The native window keeps its asset origin while its owned service changes ports. */
export function desktopServiceOrigin(location: Pick<Location, "protocol" | "hostname" | "port" | "search">): string | null {
  const native = location.port === "" && (
    (location.protocol === "tauri:" && location.hostname === "localhost") ||
    (location.protocol === "http:" && location.hostname === "tauri.localhost")
  );
  if (!native) return null;
  const value = new URLSearchParams(location.search).get("service_origin");
  if (!value) throw new Error("The desktop service address is missing.");
  const url = new URL(value);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port ||
      url.username || url.password || url.pathname !== "/" || url.search || url.hash || value !== url.origin) {
    throw new Error("The desktop service address is invalid.");
  }
  return url.origin;
}

export function serviceUrl(path: string): string {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) {
    throw new Error("A service request must use a local path.");
  }
  const origin = desktopServiceOrigin(window.location);
  return origin ? `${origin}${path}` : path;
}

export function serviceSocketUrl(path: string, location: Pick<Location, "protocol" | "host"> = window.location): string {
  const origin = desktopServiceOrigin(window.location);
  const base = origin ? new URL(origin) : location;
  const scheme = base.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${base.host}${path}`;
}
