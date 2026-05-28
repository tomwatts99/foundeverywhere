/**
 * Homepage FAQ content. Lives in /lib so the section component AND
 * the schema-builder can read from the same source: guarantees the
 * rendered Q&A and the FAQPage JSON-LD never drift.
 */

export interface FAQ {
  question: string;
  answer: string;
}

export const HOME_FAQS: ReadonlyArray<FAQ> = [
  {
    question: 'What is LLM visibility?',
    answer:
      'LLM visibility means your website appears as a cited source when people use AI tools like ChatGPT, Perplexity, or Gemini to search for your services. We implement the technical signals (schema markup, structured content, and entity consistency) that these systems use to decide what to recommend.',
  },
  {
    question: 'How long does an audit take?',
    answer:
      'Most audits are turned around within two weeks. You receive a full report with every issue scored by impact, a prioritised fix list, and a before score you can benchmark against.',
  },
  {
    question: 'Do I need ongoing work or just a one-off fix?',
    answer:
      'The audit and fix is a standalone service: many clients start there. Ongoing retainers make sense once the foundations are solid and you want to monitor AI search visibility, track rankings, and keep your schema current as the standards evolve.',
  },
  {
    question: 'Will this work for my industry?',
    answer:
      'Yes. The technical work (site speed, structured data, semantic HTML, entity signals) is universal. We work with service businesses, ecommerce, hospitality, professional services, and local businesses across the UK.',
  },
  {
    question: 'What makes Found Everywhere different?',
    answer:
      'Most SEO agencies optimise for Google. We optimise for everywhere search happens, including ChatGPT, Perplexity, Gemini, and Copilot. That is not a future consideration. AI search is sending traffic right now.',
  },
  {
    question: 'How do I know if I am showing up in AI search?',
    answer:
      'We include an AI visibility audit in every engagement: testing your brand and service across the major AI systems and documenting where you appear and where you do not. You will know exactly where you stand.',
  },
];
