---
title: "How to get your business cited by ChatGPT, Perplexity, and Gemini"
description: "Most websites are invisible to AI search tools. This practical guide explains exactly what signals you need to implement to get your business cited by ChatGPT, Perplexity, Gemini, and other AI systems."
pubDate: 2026-05-29
cluster: llm-seo
pillar: true
---

## Why most businesses are invisible to AI search

When someone asks ChatGPT to recommend a solicitor in Brighton, or asks Perplexity for the best local SEO agency in the UK, those tools do not search the way Google does. They pull from specific sources, cite specific businesses, and generate a confident-sounding answer from whatever signals they can find.

Most businesses are not in those answers. Not because they are bad at what they do, but because their websites do not send the signals AI systems need to cite them confidently.

This guide covers exactly what those signals are and what you need to do to implement them.

## Step 1: Implement schema markup properly

Schema markup is structured data embedded in your website's code that tells AI systems and search engines exactly what your business does, who you are, and how to categorise your content. It is the single highest-impact GEO improvement most businesses can make.

The schema types that matter most for AI citation are:

- **Organisation schema** - on every page of your site. Includes your business name, URL, logo, description, contact details, and links to your social profiles. This is how AI systems build a picture of your business as a coherent entity.
- **WebSite schema** - on your homepage. Tells AI systems the name and URL of your site and can include a sitelinks search box.
- **Service schema** - on each service page. Describes what the service is, who provides it, and where it is available.
- **FAQPage schema** - on any page with a FAQ section. This is one of the most direct routes to AI citation because it provides pre-formatted question and answer pairs that AI systems can extract and use directly.
- **Article schema** - on blog posts and guides. Includes the title, author, publication date, and a description of the content.
- **LocalBusiness schema** - for businesses with a physical location or service area. Includes address, opening hours, and geographic coordinates.

Most websites either have no schema at all or have it implemented partially and incorrectly. Use Google's Rich Results Test to check what schema your site currently has and whether it validates correctly.

## Step 2: Add an llms.txt file

llms.txt is a plain text file in markdown format placed at the root of your domain - for example, yourdomain.com/llms.txt. It tells AI crawlers what your site is about, who you are, and which pages are most useful to index.

Think of it as a cover letter for AI systems. Where robots.txt tells crawlers what not to index, llms.txt tells AI systems what to pay attention to.

A basic llms.txt file should include a brief description of your business, links to your key pages with one-line descriptions of each, and explicit permission for AI systems to use your content.

Several major AI systems already check for this file. Having one in place is a clear signal that your site is AI-aware and has actively made its content available for indexing.

## Step 3: Establish your brand as a consistent entity

AI systems think in entities. For your business to be confidently cited, it needs to exist as a coherent, consistent entity across the web - not just on your own website.

Entity consistency means your business name, description, address, phone number, and other key details are identical everywhere they appear online. Your website, Google Business Profile, LinkedIn, Companies House, industry directories, and any other platform where your business is mentioned should all show the same information.

Inconsistencies create uncertainty. If your business name appears differently across different platforms - abbreviated in some places, with a limited company suffix in others - AI systems become less confident about recommending you.

Audit your brand presence across the web and standardise everything. The same business name, the same description, the same contact details, everywhere.

## Step 4: Structure your content to answer questions directly

AI systems extract from content that answers questions clearly and directly. The format that works best is simple: state the question as a heading, answer it in the first one or two sentences, then expand with supporting detail.

This is not a trick. It is just clear writing. But most web content is not structured this way - it buries the key information in long paragraphs, uses vague headings, and makes the reader work to find the answer.

Practical changes to make to your key pages:

- Add a FAQ section to every service page. Use the actual questions your customers ask and answer them directly. Implement FAQPage schema on each one.
- Rewrite your service descriptions to open with a clear statement of what the service is and who it is for. Do not start with "we are delighted to offer."
- Use specific, descriptive headings. "What is included in an SEO audit" is better than "Our services." "How long does technical SEO take" is better than "Timelines."
- Write your About page as a series of factual, declarative statements about your business - what you do, who founded it, where you operate, what you specialise in. AI systems treat well-structured About pages as a primary source of entity information.

## Step 5: Build third-party citations and mentions

Your own website can only do so much. AI systems also look at what the rest of the web says about your business.

Being mentioned in authoritative third-party sources - industry publications, directories, local press, partner websites - increases both your authority signals and your likelihood of appearing in AI training data.

Practical citation building for most businesses:

- Get listed on Clutch, Trustpilot, or industry-specific directories relevant to your sector. Make sure your listing is complete and accurate.
- Seek coverage in local or industry press. Even a brief mention in a relevant publication is a meaningful signal.
- Guest posts or contributions to industry publications - write something genuinely useful and get it published somewhere with authority.
- Make sure your Google Business Profile is complete, accurate, and regularly updated. GBP is heavily weighted in AI systems that draw on Google's data, particularly Gemini.

## Step 6: Make your site technically sound

AI crawlers behave similarly to search engine crawlers. A site that is slow to load, difficult to crawl, or has significant technical errors is less likely to be fully indexed and cited.

The technical basics that matter for AI visibility:

- **Fast loading times** - aim for a PageSpeed score above 90 on both mobile and desktop. Slow sites get crawled less frequently and less completely.
- **Clean, semantic HTML** - use proper heading hierarchy, meaningful alt text on images, and structured markup that makes it easy for crawlers to understand your content.
- **A complete and accurate sitemap** submitted to Google Search Console and Bing Webmaster Tools. AI systems that use these indexes will find your content more reliably.
- **No crawl errors** - check Google Search Console regularly for pages that cannot be accessed or indexed.

## Step 7: Test your visibility and track it

You cannot manage what you do not measure. Testing your AI visibility is straightforward but requires doing it manually across multiple systems.

Open ChatGPT, Perplexity, Gemini, Copilot, and Claude. Ask questions that your target customers would ask - questions about your services, your location, your sector. Note whether your business appears, whether it is cited as a source, and what is said about it.

Do this before you implement any changes to establish a baseline. Then repeat the test four to eight weeks after implementation to measure the impact.

Keep a simple log of your results - which systems cite you, for which queries, and what they say. This is your AI visibility audit and it is the starting point for understanding where to focus your efforts.

## How long does it take

Schema and llms.txt changes can be picked up within days. Appearing consistently in AI-generated answers typically takes four to eight weeks as systems re-crawl and update.

The businesses seeing the most benefit from AI visibility work are the ones that started early. The channel is less crowded than traditional SEO, the signals are relatively straightforward to implement, and most competitors have not started yet.

## Frequently asked questions

### Do I need a big website to get cited by AI tools?

No. AI systems prioritise clarity, structure, and authority over size. A small site with well-implemented schema, a clear llms.txt file, and question-led content can outperform a large site that has not been optimised for AI citation.

### Is Perplexity different from ChatGPT for optimisation purposes?

Yes. Perplexity is almost entirely retrieval-based and cites sources in real time from the live web. It responds fastest to traditional SEO quality signals combined with good schema. ChatGPT with browsing uses Bing's index, so Bing SEO matters. Gemini draws on Google's index. Optimising for all three means getting the technical and content fundamentals right rather than gaming any single system.

### Will this affect my Google rankings?

Positively. Schema markup, technical quality, and clear content structure all support Google rankings as well as AI citation. GEO work and traditional SEO work reinforce each other.

### How do I know if an AI system is citing my site?

Ask it directly. Query the major AI tools with questions your customers would ask and look for your business name or website URL in the response. Some tools like Perplexity show citations explicitly. Others like ChatGPT may mention your business without a direct link.

### Should I create separate content for AI search?

No. Google has explicitly said that creating content primarily to manipulate AI responses violates its spam policies. Create genuinely useful content for your human audience, structure it clearly, and implement the technical signals correctly. That is what works for both AI citation and traditional search.
