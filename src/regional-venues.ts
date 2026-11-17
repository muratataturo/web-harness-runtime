/** Versioned source identities. A corporate domain is never a single venue by default. */
export const regionalVisitHosts = [
  "www.gakkihaku.jp",
  "www.ncsm.city.nagoya.jp",
];
export const regionalSpaceHosts = ["www.actcity.jp"];
export const regionalCafeHosts = [
  "www.act-okura.co.jp",
  "www.nomura-medias.co.jp",
];
export function regionalVenue(value: string): string | undefined {
  const u = new URL(value);
  if (
    u.hostname === "www.actcity.jp" &&
    ["/visitor/act/", "/faq/"].includes(u.pathname)
  )
    return "official-public-space:hamamatsu-actcity-gardens";
  if (u.hostname === "www.gakkihaku.jp")
    return "official-visit:hamamatsu-gakkihaku";
  if (u.hostname === "www.ncsm.city.nagoya.jp")
    return "official-visit:nagoya-science";
  if (
    u.hostname === "www.act-okura.co.jp" &&
    [
      "/restaurant/cafe/",
      "/restaurant-plan/cafemenu202303/",
      "/restaurant-plan/javabali20260711/",
    ].includes(u.pathname)
  )
    return "official-cafe:okura-hamamatsu-season";
  if (
    u.hostname === "www.nomura-medias.co.jp" &&
    [
      "/shop_list/1083/",
      "/works/228/",
      "/news/774/",
      "/news/view/774",
      "/wordpress/wp-content/uploads/2026/09/774.pdf",
    ].includes(u.pathname)
  )
    return "official-cafe:nagoya-science-cafe";
  return undefined;
}
