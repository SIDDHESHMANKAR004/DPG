# Deployment

## Vercel frontend

1. Before deploying, replace `YOUR-RENDER-SERVICE` in `vercel.json` with the Render service hostname. For example, if Render provides `https://developer-work-assistant-api.onrender.com`, use `https://developer-work-assistant-api.onrender.com/api/:path*` as the rewrite destination.
2. Create a Vercel project for this repository with **Root Directory** set to the repository root (`.`).
3. Use these settings (also configured in `vercel.json`):
   - Install command: `npm ci`
   - Build command: `npm run build --workspace @developer-work-assistant/web`
   - Output directory: `apps/web/dist`
4. No frontend API environment variable is required. Existing relative `/api/...` requests are routed by the Vercel rewrite.

## Render backend

Create a Render **Web Service** for the same repository:

- Root Directory: repository root (`.`)
- Runtime: Node
- Build command: `npm ci && npm run build --workspace @developer-work-assistant/api`
- Start command: `npm run start --workspace @developer-work-assistant/api`
- Environment: set `NODE_VERSION` to `22` (or a supported Node 22 release).
- `PORT` is supplied by Render; the API defaults to `3001` when it is not set.

The API binds to `0.0.0.0` for hosted access. No CORS setting is needed while browser API calls use the Vercel same-origin rewrite.

## Current deployment limitations

- Project metadata, activity, and reports remain JSON files under `apps/api/data` relative to the API process working directory. Render's local filesystem is ephemeral by default, so this data can be lost when the service restarts or redeploys. PostgreSQL migration and persistent-disk configuration are not included.
- The project scanner and local quality/Git checks access paths on the API host. A hosted Render API cannot access a developer's local computer directories; these features work only for directories available to the backend service.
- There is no Neon PostgreSQL connection or `DATABASE_URL` configuration in this project. No database credentials should be added to Vercel frontend environment variables.
