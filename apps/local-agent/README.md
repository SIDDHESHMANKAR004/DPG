# Local Agent

The Local Agent runs on the developer's computer and exposes project analysis only over loopback.

## Run

From the repository root:

```text
npm install
npm run dev:agent
```

The agent binds to `127.0.0.1:4317` and generates a new 32-byte random session token for each process. The token stays in agent memory and is not printed at startup. In the interactive agent terminal, type `show-token` to reveal it locally, then enter it in the dashboard's Local Agent connection panel. The token expires after 12 hours and is revoked when the agent stops; restarting also clears registered projects.

To connect a deployed dashboard, set `LOCAL_AGENT_ALLOWED_ORIGINS` in the agent process to a comma-separated list of exact frontend origins, for example `https://your-dashboard.vercel.app`. Local Vite origins on ports 5173 and 5174 are allowed by default. Origins are matched exactly; wildcard origins are not supported.

## Safety and limitations

- Every API request requires the per-run bearer token, validated in constant time. The token is not embedded in frontend code and is held by the dashboard in tab-scoped session storage. Exact browser origins are allowlisted, the Host header is restricted to localhost addresses, and private-network preflight is handled for supported browsers.
- The browser must permit the HTTPS dashboard to access the local network/loopback service. Browser policy prompts and support vary; a local development frontend is the fallback.
- Only paths submitted to `POST /projects/scan` are registered. Registrations exist in memory only for the current agent run.
- Project API responses include a folder name rather than an absolute local path. Stop the agent to revoke its active token immediately.
- ESLint and TypeScript checks use the existing fixed-argument quality runner. A project-defined `build` script is run only after an explicit dashboard confirmation; its output is withheld. Build scripts are project code and can modify files.
- The agent never installs packages, fixes files, or performs Git writes. `.env` files and credentials are not read by scanning.
- Project scanning and analysis run locally; no cloud API, paid AI API, or cloud account is required for these local-agent operations.
