This file contains step-by-step instructions: 
how to create a GitHub App, configure env, run, test endpoints, and notes about security.

Key points (summary):

Create a GitHub App at https://github.com/settings/Developer_Settings.

Give it a name (e.g. readme-gen-bot).

Set Repository permissions → Contents to Read & write (so the app can create files/PRs later).

Set Pull requests to Read & write if you'll open PRs.

Webhook is optional for now.

After creation, download the private key and note the App ID.

Save private key either in config/private-key.pem and set PRIVATE_KEY_PATH env var, or paste it into PRIVATE_KEY env var replacing newline with \\n sequences (see .env.example).

Install dependencies: npm install.

Run: npm run dev (if you installed nodemon) or npm start.

Test endpoints (local):

GET /health — should return { ok: true }.

GET /installations — lists app installations (requires your app to be installed in at least one account).

GET /installations/:installation_id/repos — repos accessible to that installation.

GET /repos/:owner/:repo/tree?installation_id=XXX&ref=main — returns file tree.

GET /repos/:owner/:repo/file?installation_id=XXX&path=package.json&ref=main — returns file content.

Security notes:

Do not commit private key or .env to git. .gitignore already excludes them.

Keep installation tokens short-lived and do not log secrets.