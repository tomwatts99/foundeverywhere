import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// https://astro.build/config
export default defineConfig({
  site: 'https://foundeverywhere.co.uk',
  trailingSlash: 'never',
  compressHTML: true,
  build: {
    inlineStylesheets: 'auto',
    assets: '_assets',
  },
  integrations: [
    sitemap({
      changefreq: 'weekly',
      priority: 0.7,
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
