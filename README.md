# NoETL Documentation

This website is built with [Docusaurus](https://docusaurus.io/).

## Requirements

- Node.js 20+
- npm

## Install dependencies

```bash
npm ci
```

## Local development

```bash
npm run start
```

## Production build

```bash
npm run build
```

Build output is generated into `build/`.

## Cloudflare Pages deployment

Deployment is automated from `main` by GitHub Actions workflow:

- `.github/workflows/deploy-cloudflare-pages.yml`

### Required GitHub repository settings

Add repository secrets:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

Add repository variable:

- `CLOUDFLARE_PAGES_PROJECT` (example: `noetl-docs`; defaults to `noetl-docs` if unset)

### Manual workflow run

If needed, run the workflow manually from Actions:

1. Open `Deploy Docs to Cloudflare Pages`
2. Click **Run workflow**
3. Select `main`
