# Local Agent

The Local Agent runs on the developer's computer and exposes project analysis only over loopback.

## Run

From the repository root:

```text
npm install
npm run dev:agent
```

The agent binds to `127.0.0.1:4317`, generates a new session token at startup, and prints it to the terminal. Copy that token into the dashboard's Local Agent connection panel. Keep it private. Stopping and restarting the agent invalidates the previous token and clears registered projects.

To connect a deployed dashboard, set `LOCAL_AGENT_ALLOWED_ORIGINS` in the agent process to a comma-separated list of exact frontend origins, for example `https://your-dashboard.vercel.app`. Local Vite origins on ports 5173 and 5174 are allowed by default. Origins are matched exactly; wildcard origins are not supported.

## Safety and limitations

- Every request requires the per-run bearer token. Browser origins are allowlisted, the Host header is restricted to localhost addresses, and private-network preflight is handled for supported browsers.
- The browser must permit the HTTPS dashboard to access the local network/loopback service. Browser policy prompts and support vary; a local development frontend is the fallback.
- Only paths submitted to `POST /projects/scan` are registered. Registrations exist in memory only for the current agent run.
- ESLint and TypeScript checks use the existing fixed-argument quality runner. A project-defined `build` script is run only after an explicit dashboard confirmation; its output is withheld. Build scripts are project code and can modify files.
- The agent never installs packages, fixes files, or performs Git writes. `.env` files and credentials are not read by scanning.
- Project scanning and analysis run locally; no cloud API, paid AI API, or cloud account is required for these local-agent operations.
