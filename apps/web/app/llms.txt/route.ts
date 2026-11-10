import { publicDocs, docsHref } from "@/lib/docs-pages";
import { description, siteName, siteUrl } from "@/lib/site";

export const dynamic = "force-static";

export async function GET() {
  const docs = await publicDocs();
  const links = docs.map((doc) => {
    const href = docsHref(doc.slug);
    const suffix = doc.description ? `: ${doc.description}` : "";
    return `- [${doc.title}](${siteUrl}${href})${suffix}`;
  });

  const body = [
    `# ${siteName}`,
    "",
    `> ${description}`,
    "",
    `The product home is [${siteUrl}](${siteUrl}). The documentation home is [${siteUrl}/docs](${siteUrl}/docs).`,
    "",
    "## Documentation",
    "",
    ...links,
    "",
  ].join("\n");

  return new Response(body, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
