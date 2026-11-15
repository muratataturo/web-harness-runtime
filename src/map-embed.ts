export function sharedMapEmbed(value: string): string | null {
  try {
    const u = new URL(value);
    if (
      u.protocol !== "https:" ||
      u.hostname !== "www.google.com" ||
      u.pathname !== "/maps/embed" ||
      u.username ||
      u.password ||
      u.hash ||
      [...u.searchParams.keys()].some((k) => !["pb", "hl"].includes(k)) ||
      !u.searchParams.get("pb")?.startsWith("!") ||
      u.href.length > 5000
    )
      return null;
    return u.href;
  } catch {
    return null;
  }
}
