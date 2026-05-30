/**
 * Content collections.
 *
 * `insights` is a Markdown-backed collection (glob loader) used by the
 * Insights index and article pages. Authors drop .md/.mdx files into
 * src/content/insights/ with the frontmatter shape below.
 */
import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const insights = defineCollection({
  loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/insights' }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    cluster: z.string(),          // e.g. "GEO", "LLM SEO", "Technical SEO"
    pubDate: z.coerce.date(),
    updatedDate: z.coerce.date().optional(),
    pillar: z.boolean().optional().default(false),  // cornerstone / hub article
    draft: z.boolean().optional().default(false),
  }),
});

export const collections = { insights };
