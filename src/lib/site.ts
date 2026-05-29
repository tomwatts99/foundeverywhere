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

export type NavChild = { href: string; label: string };
export type NavItem  = { href: string; label: string; children?: ReadonlyArray<NavChild> };

export const NAV: ReadonlyArray<NavItem> = [
  {
    href: '/services/',
    label: 'Services',
    children: [
      { href: '/services/seo-audit/',      label: 'SEO audit' },
      { href: '/services/llm-visibility/', label: 'LLM visibility' },
      { href: '/services/technical-seo/',  label: 'Technical SEO' },
      { href: '/services/visibility-that-compounds/',       label: 'Visibility that compounds' },
      { href: '/services/local-seo/',      label: 'Local SEO and Google Business Profile' },
      { href: '/services/expert-content/', label: 'Expert content' },
    ],
  },
  { href: '/how-it-works/', label: 'How it works' },
  { href: '/insights/',     label: 'Insights' },
  { href: '/results/',      label: 'Results' },
  { href: '/about/',        label: 'About' },
];

export const FOOTER_NAV: ReadonlyArray<{
  title: string;
  items: ReadonlyArray<{ href: string; label: string }>;
}> = [
  {
    title: 'Services',
    items: [
      { href: '/services/seo-audit/',                 label: 'SEO audit' },
      { href: '/services/llm-visibility/',            label: 'LLM visibility' },
      { href: '/services/technical-seo/',             label: 'Technical SEO' },
      { href: '/services/visibility-that-compounds/', label: 'Visibility that compounds' },
      { href: '/services/local-seo/',                 label: 'Local SEO' },
    ],
  },
  {
    title: 'Agency',
    items: [
      { href: '/about/',    label: 'About' },
      { href: '/results/',  label: 'Results' },
      { href: '/insights/', label: 'Insights' },
      { href: '/contact/',  label: 'Contact' },
    ],
  },
  {
    title: 'Resources',
    items: [
      { href: '/llms.txt',          label: 'llms.txt' },
      { href: '/sitemap-index.xml', label: 'Sitemap' },
    ],
  },
];
