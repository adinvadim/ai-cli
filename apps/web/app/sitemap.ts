import type { MetadataRoute } from "next";

import { docsHref, publicDocs } from "@/lib/docs-pages";
import { siteUrl } from "@/lib/site";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const docs = await publicDocs();
  const home: MetadataRoute.Sitemap[number] = {
    url: siteUrl,
  };
  const pages = docs.map((doc) => ({
    url: `${siteUrl}${docsHref(doc.slug)}`,
  }));
  return [home, ...pages];
}
