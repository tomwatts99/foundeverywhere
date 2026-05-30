import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import cloudflare from '@astrojs/cloudflare';

// https://astro.build/config
//
// Static by default; pages that opt in with `export const prerender = false`
// (e.g. /report/[id]) are rendered on demand by the Cloudflare adapter.
// This is the Astro 5 equivalent of the old `output: 'hybrid'` mode.
export default defineConfig({
  site: 'https://foundeverywhere.co.uk',
  trailingSlash: 'always',
  compressHTML: true,
  output: 'static',
  adapter: cloudflare({
    mode: 'directory',
  }),
  build: {
    inlineStylesheets: 'auto',
    assets: '_assets',
  },
  integrations: [
    sitemap({
      filter: (page) => !page.includes('/404'),
      serialize(item) {
        if (item.url === 'https://foundeverywhere.co.uk/') {
          item.priority = 1.0;
          item.changefreq = 'daily';
        } else if (item.url.includes('/services/')) {
          item.priority = 0.9;
          item.changefreq = 'weekly';
        } else if (item.url.includes('/insights') || item.url.includes('/results')) {
          item.priority = 0.8;
          item.changefreq = 'weekly';
        } else {
          item.priority = 0.7;
          item.changefreq = 'monthly';
        }
        return item;
      },
      lastmod: new Date(),
    }),
  ],
  vite: {
    css: {
      transformer: 'lightningcss',
    },
    build: {
      cssMinify: 'lightningcss',
    },
  },
});
