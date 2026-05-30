---
title: "The technical SEO guide for UK businesses"
description: "Core Web Vitals, crawlability, schema markup, and site structure explained clearly. Everything UK businesses need to know about technical SEO without the jargon."
pubDate: 2026-05-29
cluster: technical-seo
pillar: true
---

## What is technical SEO

Technical SEO is the practice of optimising the technical foundations of your website so that search engines can find, crawl, understand, and index your content effectively. It is distinct from on-page SEO, which focuses on content and keywords, and off-page SEO, which focuses on links and authority.

Think of technical SEO as the infrastructure layer. Content and links matter enormously, but they cannot work properly if the technical foundations are broken. A page that search engines cannot crawl does not exist as far as Google is concerned. A page that loads too slowly loses rankings before the content gets a chance to do its job.

This guide covers the technical SEO fundamentals every UK business website needs to get right.

## Core Web Vitals

Core Web Vitals are a set of metrics that Google uses to measure the real-world experience of using a web page. They became a confirmed ranking signal in 2021 and have become increasingly important since.

There are three Core Web Vitals metrics:

- **Largest Contentful Paint (LCP)** measures how long it takes for the largest visible element on the page to load. This is usually a hero image or a large block of text. Google's threshold for a good LCP score is under 2.5 seconds. Above 4 seconds is considered poor.
- **Cumulative Layout Shift (CLS)** measures how much the page layout shifts unexpectedly as it loads. You have experienced this when you go to tap a button and the page jumps at the last moment. Google's threshold for a good CLS score is under 0.1.
- **Interaction to Next Paint (INP)** measures the responsiveness of a page to user interactions like clicks and taps. It replaced First Input Delay as a Core Web Vitals metric in 2024. Google's threshold for a good INP score is under 200 milliseconds.

You can check your Core Web Vitals in Google Search Console under the Core Web Vitals report, or by running your site through PageSpeed Insights at pagespeed.web.dev.

Common causes of Core Web Vitals failures include unoptimised images, render-blocking JavaScript, third-party scripts loading slowly, and unstable page layouts caused by elements without defined dimensions.

## Crawlability and indexing

Before Google can rank your pages, it needs to be able to find and crawl them. Crawlability problems are surprisingly common and often go unnoticed until rankings drop or pages disappear from search results.

**Robots.txt** is a file at the root of your domain that tells search engine crawlers which pages they are and are not allowed to crawl. A misconfigured robots.txt file can accidentally block your entire site from being crawled — this happens more often than you might expect, particularly after site migrations or CMS updates.

**XML sitemap** is a file that lists all the pages on your site that you want search engines to index. A well-maintained sitemap helps Google find your content faster and more reliably. Submit your sitemap to Google Search Console and Bing Webmaster Tools.

**Noindex tags** are HTML directives that tell search engines not to index a specific page. Used correctly they are a useful tool — for example, keeping thank you pages or internal search results out of Google's index. Used incorrectly they can remove important pages from search results entirely.

**Crawl errors** are pages that Googlebot attempts to visit but cannot access. Check the Coverage report in Google Search Console regularly for crawl errors and fix them promptly.

**Redirect chains** occur when one URL redirects to another, which redirects to another, and so on. Long redirect chains slow down crawling and dilute authority. Every redirect should go directly from the old URL to the final destination.

## Site architecture and URL structure

The way your website is organised affects how well search engines can understand and index your content. Good site architecture makes it easy for crawlers to find every page on your site and understand how they relate to each other.

A flat site architecture — where every page is reachable within three clicks from the homepage — is generally preferable to a deeply nested structure. Pages buried five or six levels deep are crawled less frequently and seen as less important.

URL structure should be clean, descriptive, and consistent. Use hyphens to separate words, keep URLs as short as possible while remaining descriptive, and avoid parameters and dynamic URLs where possible.

Every page on your site should be reachable via internal links. Orphaned pages — pages with no internal links pointing to them — are crawled infrequently and rank poorly.

## Internal linking

Internal links serve two purposes. They help users navigate your site and they help search engines understand the relationship between your pages and distribute authority across your site.

Pages that receive more internal links are treated as more important by search engines. Your most commercially important pages — service pages, product pages, key landing pages — should receive the most internal links from other pages on your site.

Common internal linking problems include orphaned pages with no inbound links, broken internal links pointing to pages that no longer exist, and over-reliance on navigation menus as the only source of internal links.

A content hub structure — where a central pillar page links to and receives links from a cluster of related articles — is one of the most effective internal linking strategies for building topical authority.

## Page speed optimisation

Page speed affects both rankings and conversions. A one-second delay in mobile page load time can reduce conversions by up to 20 percent. Beyond the user experience impact, Google uses page speed as a ranking signal through Core Web Vitals.

The most impactful page speed improvements for most sites:

- **Image optimisation** — images are typically the largest contributors to page weight. Serve images in modern formats like WebP, compress them appropriately, set explicit width and height attributes to prevent layout shift, and lazy load images below the fold.
- **Eliminate render-blocking resources** — JavaScript and CSS files that load in the head of your page delay the browser from rendering content. Defer non-critical JavaScript, inline critical CSS, and load third-party scripts asynchronously where possible.
- **Implement caching** — browser caching stores static files locally so returning visitors do not have to download them again. Server-side caching reduces the processing time needed to generate pages.
- **Use a CDN** — a content delivery network serves your site from servers geographically close to your visitors, reducing latency. Cloudflare Pages, which this site runs on, includes global CDN as standard.
- **Reduce third-party scripts** — analytics tools, chat widgets, advertising scripts, and social media embeds all add weight and latency. Audit every third-party script on your site and remove anything that is not providing clear value.

## Schema markup

Schema markup is structured data that tells search engines and AI systems exactly what your content is about. It is implemented as JSON-LD code in the head of your pages and validated using Google's Rich Results Test.

Beyond the SEO benefits — rich results, enhanced listings in search — schema markup is increasingly important for AI visibility. AI systems use structured data as a primary signal when deciding whether to cite a source and how to describe a business.

The schema types most UK businesses need:

- **Organisation** — your business name, URL, logo, description, contact details, and social profiles. Implement on every page.
- **WebSite** — your site name and URL. Implement on your homepage.
- **LocalBusiness** — for businesses with a physical location or defined service area. Includes address, opening hours, geographic coordinates, and business type.
- **Service** — describes a specific service you offer, who provides it, and where it is available.
- **FAQPage** — for pages with FAQ sections. Provides pre-formatted question and answer pairs that search engines can display as rich results and AI systems can extract directly.
- **Article** — for blog posts and guides. Includes title, author, publication date, and description.
- **BreadcrumbList** — shows the hierarchical position of a page within your site structure.

## Mobile optimisation

Google uses mobile-first indexing, meaning it primarily uses the mobile version of your site for ranking purposes. If your mobile experience is poor, your rankings will suffer regardless of how good your desktop site is.

Mobile optimisation goes beyond responsive design. Test your site on actual mobile devices, not just by resizing a browser window. Check that tap targets are large enough, that text is readable without zooming, that forms are easy to complete on a touchscreen, and that page speed is acceptable on a mobile connection.

Use Google Search Console's Mobile Usability report to identify specific mobile issues on your site.

## HTTPS and security

HTTPS is a confirmed Google ranking signal and a baseline expectation for any professional website. If your site still runs on HTTP, migrating to HTTPS should be an immediate priority.

Beyond HTTPS, maintain a clean security record. Sites that have been hacked or associated with malware can be penalised in search rankings or delisted entirely. Keep your CMS, plugins, and themes updated, use strong passwords, and implement two-factor authentication on any admin accounts.

## How to audit your technical SEO

A technical SEO audit covers all of the areas described above and identifies specific issues that need fixing. The output should be a prioritised list of issues scored by their likely impact on rankings and traffic.

Tools you can use for a basic technical audit include Google Search Console (free, essential), PageSpeed Insights (free), Screaming Frog (free up to 500 URLs), and Ahrefs or Semrush (paid, more comprehensive).

For a thorough audit that covers AI visibility as well as traditional technical SEO, working with a specialist is usually faster and more reliable than attempting to do it yourself with a combination of tools.

## Frequently asked questions about technical SEO

### How often should I do a technical SEO audit?

For most small to medium-sized businesses, a comprehensive audit once a year is a reasonable baseline. For larger sites or sites that update frequently, quarterly audits are more appropriate. Google Search Console should be checked monthly for crawl errors and Core Web Vitals issues.

### My site is on WordPress. Does that affect technical SEO?

WordPress is a solid platform for SEO when configured correctly. Common WordPress technical SEO issues include slow page speed from poorly optimised themes and plugins, duplicate content from tag and category archives, and incomplete schema implementation. An SEO plugin like Yoast or Rank Math handles some basics but does not replace a proper technical audit.

### What is the difference between technical SEO and on-page SEO?

Technical SEO covers the infrastructure of your website — how it is built, how fast it loads, how search engines can access it. On-page SEO covers the content on individual pages — keywords, headings, meta descriptions, and internal links. Both matter and they work together.

### Does technical SEO affect AI visibility as well as Google rankings?

Yes. AI systems use many of the same crawling and indexing infrastructure as traditional search engines. A technically sound site is indexed more completely and more frequently, which increases the likelihood of AI citation. Schema markup in particular is used directly by AI systems as a signal when deciding whether to cite a source.

### How long does it take to see results from technical SEO fixes?

Quick wins like fixing crawl errors or removing accidental noindex tags can show in Search Console within days. Core Web Vitals improvements typically take two to four weeks to show in Google's reports. Ranking improvements from technical fixes can take four to twelve weeks depending on how frequently Google crawls your site.

### Can I do technical SEO myself?

Some technical SEO tasks are straightforward for anyone comfortable with their CMS — submitting a sitemap, checking robots.txt, installing an SEO plugin. Others require developer access and technical knowledge — fixing Core Web Vitals, implementing schema markup correctly, resolving crawl errors. A technical SEO audit from a specialist will tell you exactly what needs fixing and how complex each fix is.
