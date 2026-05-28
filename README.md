# Found Everywhere

Source for [foundeverywhere.co.uk](https://foundeverywhere.co.uk), an SEO and LLM-visibility agency. The site is its own proof of concept: near-perfect Lighthouse, complete schema, clean semantic HTML, and a maintained `llms.txt`.

## Stack

- **Astro 5**: zero-JS by default, islands where needed
- **@astrojs/sitemap**: automatic XML sitemap
- **Vanilla JS** (deferred) for any interactivity
- **Native `<details>/<summary>`** for accordions
- No client framework

## Develop

```bash
npm install
npm run dev      # http://localhost:4321
npm run build    # static output to ./dist
npm run preview  # serve the built site
```

## Structure

```
src/
├── components/   # Nav, Footer, section partials
├── layouts/      # Base.astro (meta + schema), Page.astro (wrapper)
├── lib/          # schema builders, helpers
├── pages/        # routes
└── styles/
    ├── tokens.css   # design tokens (colour, type, space, radius, shadow)
    └── global.css   # reset, base type, utilities
public/
├── llms.txt
└── robots.txt
```

## Design tokens

| Token            | Value                |
| ---------------- | -------------------- |
| `--accent`       | `#0C7B82` (teal)     |
| `--bg`           | `#FFFFFF`            |
| `--surface`      | `#F7F9FC`            |
| `--text`         | `#0D1321`            |
| `--muted`        | `#64748B`            |
| `--dark`         | `#0D1826`            |
| Display / Heading| Outfit (400–700)     |
| Body             | Inter                |
| Mono             | JetBrains Mono       |
| Grid             | 8px base             |
