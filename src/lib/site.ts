/**
 * Site-wide constants. Single source of truth for anything that
 * appears in <head>, structured data, or footer/nav copy.
 */

export const SITE = {
  name: 'Found Everywhere',
  legalName: 'Found Everywhere Ltd',
  tagline: 'SEO and LLM visibility, built for the search era after search.',
  description:
    'Found Everywhere is a UK agency for SEO and LLM visibility. We help brands win attention from both classic search engines and the new generation of AI answer engines.',
  url: 'https://foundeverywhere.co.uk',
  locale: 'en_GB',
  language: 'en-GB',
  country: 'GB',
  email: 'hello@foundeverywhere.co.uk',
  phone: '+44 20 0000 0000',          // TODO: replace with real number
  founded: '2025',
  logo: '/og/logo.png',
  ogImage: '/og/default.png',
  twitter: '@foundeverywhere',
  sameAs: [
    'https://www.linkedin.com/company/foundeverywhere',
    // add socials as they go live
  ],
  address: {
    streetAddress: '',
    addressLocality: 'London',
    addressRegion: 'England',
    postalCode: '',
    addressCountry: 'GB',
  },
} as const;

export const NAV: ReadonlyArray<{ href: string; label: string }> = [
  { href: '/services',  label: 'Services' },
  { href: '/approach',  label: 'Approach' },
  { href: '/work',      label: 'Case studies' },
  { href: '/insights',  label: 'Insights' },
  { href: '/about',     label: 'About' },
];

export const FOOTER_NAV: ReadonlyArray<{
  title: string;
  items: ReadonlyArray<{ href: string; label: string }>;
}> = [
  {
    title: 'Services',
    items: [
      { href: '/services/seo',          label: 'Technical SEO' },
      { href: '/services/llm',          label: 'LLM visibility' },
      { href: '/services/content',      label: 'Content & E-E-A-T' },
      { href: '/services/audit',        label: 'Audits' },
    ],
  },
  {
    title: 'Agency',
    items: [
      { href: '/about',    label: 'About' },
      { href: '/work',     label: 'Case studies' },
      { href: '/insights', label: 'Insights' },
      { href: '/contact',  label: 'Contact' },
    ],
  },
  {
    title: 'Resources',
    items: [
      { href: '/llms.txt',   label: 'llms.txt' },
      { href: '/sitemap-index.xml', label: 'Sitemap' },
      { href: '/rss.xml',    label: 'RSS' },
    ],
  },
];
