# Deployment

## Vercel frontend

The frontend can be deployed as a static UI, but its `/api/...` features require the local API and are unavailable from a hosted page in local-only mode. The Vercel rewrite to Render has been removed.

1. Create a Vercel project for this repository with **Root Directory** set to the repository root (`.`).
2. Use these settings (also configured in `vercel.json`):
   - Install command: `npm ci`
   - Build command: `npm run build --workspace @developer-work-assistant/web`
   - Output directory: `apps/web/dist`
3. Do not deploy the API as a public Render service.

## Local API

- Start with `npm run dev:api` from the repository root.
- The API binds only to `127.0.0.1`, defaults to port `3001`, and accepts dashboard origins on local Vite ports `5173` and `5174`.
- Run the web dashboard locally with `npm run dev:web`; its existing Vite `/api` proxy connects to the loopback API.
- Stop any previously deployed public Render API service. A source change cannot disable an already running deployment.

## Current deployment limitations

- Project metadata, activity, and reports remain JSON files under `apps/api/data` relative to the API process working directory.
- Project scanning and local quality/Git checks access directories available to the local API process.
- There is no Neon PostgreSQL connection or `DATABASE_URL` configuration in this project. No database credentials should be added to Vercel frontend environment variables.
