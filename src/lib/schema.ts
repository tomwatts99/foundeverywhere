/**
 * Schema.org JSON-LD builders.
 *
 * Each builder returns a plain object. The Base layout serialises them
 * into a single <script type="application/ld+json"> graph so search and
 * answer engines see one connected entity model.
 */

import { SITE } from './site';

type Thing = Record<string, unknown>;

export function orgSchema(): Thing {
  return {
    '@type': 'Organization',
    '@id': `${SITE.url}/#organization`,
    name: SITE.name,
    legalName: SITE.legalName,
    url: SITE.url,
    logo: {
      '@type': 'ImageObject',
      url: `${SITE.url}${SITE.logo}`,
    },
    foundingDate: SITE.founded,
    email: SITE.email,
    address: {
      '@type': 'PostalAddress',
      addressLocality: SITE.address.addressLocality,
      addressRegion: SITE.address.addressRegion,
      addressCountry: SITE.address.addressCountry,
    },
    sameAs: SITE.sameAs,
  };
}

export function websiteSchema(): Thing {
  return {
    '@type': 'WebSite',
    '@id': `${SITE.url}/#website`,
    url: SITE.url,
    name: SITE.name,
    description: SITE.description,
    inLanguage: SITE.language,
    publisher: { '@id': `${SITE.url}/#organization` },
  };
}

export function webPageSchema(args: {
  url: string;
  title: string;
  description: string;
  datePublished?: string;
  dateModified?: string;
  breadcrumb?: ReadonlyArray<{ name: string; item: string }>;
}): Thing {
  return {
    '@type': 'WebPage',
    '@id': `${args.url}#webpage`,
    url: args.url,
    name: args.title,
    description: args.description,
    inLanguage: SITE.language,
    isPartOf: { '@id': `${SITE.url}/#website` },
    about:    { '@id': `${SITE.url}/#organization` },
    ...(args.datePublished && { datePublished: args.datePublished }),
    ...(args.dateModified  && { dateModified:  args.dateModified  }),
    ...(args.breadcrumb && {
      breadcrumb: {
        '@type': 'BreadcrumbList',
        itemListElement: args.breadcrumb.map((b, i) => ({
          '@type': 'ListItem',
          position: i + 1,
          name: b.name,
          item: b.item,
        })),
      },
    }),
  };
}

/**
 * Wrap any list of @type-bearing entities into a single @graph payload.
 * Pass to <script type="application/ld+json">JSON.stringify(graph(...))</script>.
 */
export function graph(...things: Thing[]): Thing {
  return {
    '@context': 'https://schema.org',
    '@graph': things,
  };
}

/**
 * FAQPage entity. Pass an array of { question, answer } pairs;
 * returns a Thing that can be added to a page's schemaExtras and
 * will be folded into the single JSON-LD graph emitted from Base.
 */
export function faqPageSchema(
  faqs: ReadonlyArray<{ question: string; answer: string }>,
  pageUrl?: string,
): Thing {
  const id = pageUrl ? `${pageUrl}#faq` : `${SITE.url}/#faq`;
  return {
    '@type': 'FAQPage',
    '@id': id,
    mainEntity: faqs.map((faq) => ({
      '@type': 'Question',
      name: faq.question,
      acceptedAnswer: {
        '@type': 'Answer',
        text: faq.answer,
      },
    })),
  };
}
