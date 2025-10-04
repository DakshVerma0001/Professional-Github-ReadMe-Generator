const express = require('express');
const dotenv = require('dotenv');
const crypto = require('crypto');
const morgan = require('morgan'); 
const { getAppOctokit, getInstallationOctokit, getRepoTree, getFileContent } = require('./lib/github');
const { analyzeRepo } = require('./lib/analyze'); // <-- new

dotenv.config();

const PORT = process.env.PORT || 3000;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
const SKIP_WEBHOOK_VERIFY = process.env.DEBUG_WEBHOOK_NO_VERIFY === 'true'; // set to true only for temporary debugging

const app = express();

// Simple request logger
app.use(morgan('dev'));

// --- WEBHOOK route MUST come BEFORE express.json() middleware ---
// It uses express.raw so we can compute HMAC on the raw request body exactly as GitHub sent it.
app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  try {
    // Basic connectivity check if secret missing
    if (!WEBHOOK_SECRET) {
      console.warn('WEBHOOK_SECRET is not set. Set WEBHOOK_SECRET in .env for verification.');
      // If there's no secret configured, we still accept for dev, but warn.
      // In production you should require the secret.
    }

    // Read signature headers
    const sig256 = req.headers['x-hub-signature-256'];
    const sig1 = req.headers['x-hub-signature'];

    // Optionally skip verification for quick debug (use only temporarily)
    if (!SKIP_WEBHOOK_VERIFY) {
      if (!WEBHOOK_SECRET) {
        console.warn('Rejecting webhook because WEBHOOK_SECRET is missing.');
        return res.status(500).send('Webhook secret not configured on server');
      }

      // Prefer sha256 header (modern). If missing, fall back to sha1 header (old).
      if (sig256) {
        const computed = 'sha256=' + crypto.createHmac('sha256', WEBHOOK_SECRET).update(req.body).digest('hex');
        const header = sig256;
        const headerBuf = Buffer.from(header);
        const computedBuf = Buffer.from(computed);

        // Avoid timing leaks and ensure equal length before timingSafeEqual
        if (headerBuf.length !== computedBuf.length || !crypto.timingSafeEqual(headerBuf, computedBuf)) {
          console.warn('Invalid webhook signature (sha256).', { header, computed });
          return res.status(401).send('Invalid signature');
        }
      } else if (sig1) {
        const computed = 'sha1=' + crypto.createHmac('sha1', WEBHOOK_SECRET).update(req.body).digest('hex');
        const header = sig1;
        const headerBuf = Buffer.from(header);
        const computedBuf = Buffer.from(computed);
        if (headerBuf.length !== computedBuf.length || !crypto.timingSafeEqual(headerBuf, computedBuf)) {
          console.warn('Invalid webhook signature (sha1).', { header, computed });
          return res.status(401).send('Invalid signature');
        }
      } else {
        console.warn('No signature header present on webhook request');
        return res.status(401).send('Missing signature header');
      }
    } else {
      console.warn('DEBUG_WEBHOOK_NO_VERIFY is true — skipping signature verification (dev only)');
    }

    // At this point the signature is valid (or verification skipped)
    const event = req.headers['x-github-event'] || 'unknown';
    const delivery = req.headers['x-github-delivery'] || '';
    let payload = {};
    try {
      payload = JSON.parse(req.body.toString());
    } catch (e) {
      console.warn('Failed to parse webhook JSON payload', e);
    }

    console.log(`✅ Webhook received: event=${event} delivery=${delivery}`);
    // Lightweight logging of payload keys to avoid huge dumps
    if (payload && typeof payload === 'object') {
      const repoFullName = payload.repository?.full_name;
      if (repoFullName) console.log(`Repository: ${repoFullName}`);
      // show a couple useful fields for common events
      if (event === 'ping') {
        console.log('Ping event received from GitHub');
      } else if (event === 'push') {
        console.log(`Push to ${payload.ref} by ${payload.pusher?.name || payload.sender?.login}`);
      } else if (event === 'pull_request') {
        console.log(`Pull request action=${payload.action} number=${payload.number}`);
      }
    }

    // TODO: enqueue or trigger repo analysis for push/pull_request events
    // Example: if (event === 'push') triggerAnalysis(payload.repository.full_name, payload.ref, installation_id...)

    return res.status(200).send('ok');
  } catch (err) {
    console.error('Webhook handler error', err);
    return res.status(500).send('server error');
  }
});

// Now other middleware/routes (these need parsed JSON bodies)
app.use(express.json());

// Health
app.get('/health', (req, res) => res.json({ ok: true }));

// List installations for the App (requires valid APP_ID & private key)
app.get('/installations', async (req, res) => {
  try {
    const appOctokit = getAppOctokit();
    const installations = await appOctokit.request('GET /app/installations');
    res.json(installations.data);
  } catch (err) {
    console.error('GET /installations error', err);
    res.status(500).json({ error: err.message });
  }
});

// List repositories for an installation
app.get('/installations/:installation_id/repos', async (req, res) => {
  try {
    const installationId = req.params.installation_id;
    const installationOctokit = await getInstallationOctokit(installationId);
    const repos = await installationOctokit.request('GET /installation/repositories');
    res.json(repos.data);
  } catch (err) {
    console.error('GET /installations/:id/repos error', err);
    res.status(500).json({ error: err.message });
  }
});

// Get repo tree (recursive)
app.get('/repos/:owner/:repo/tree', async (req, res) => {
  try {
    const { owner, repo } = req.params;
    const { installation_id, ref = 'main' } = req.query;
    if (!installation_id) return res.status(400).json({ error: 'installation_id query param required' });
    const installationOctokit = await getInstallationOctokit(installation_id);
    const tree = await getRepoTree(installationOctokit, owner, repo, ref);
    res.json(tree);
  } catch (err) {
    console.error('GET /repos/:owner/:repo/tree error', err);
    res.status(500).json({ error: err.message });
  }
});

// Get a single file content
app.get('/repos/:owner/:repo/file', async (req, res) => {
  try {
    const { owner, repo } = req.params;
    const { path: filePath, ref = 'main', installation_id } = req.query;
    if (!installation_id) return res.status(400).json({ error: 'installation_id query param required' });
    if (!filePath) return res.status(400).json({ error: 'path query param required' });
    const installationOctokit = await getInstallationOctokit(installation_id);
    const content = await getFileContent(installationOctokit, owner, repo, filePath, ref);
    res.json({ path: filePath, content });
  } catch (err) {
    console.error('GET /repos/:owner/:repo/file error', err);
    res.status(500).json({ error: err.message });
  }
});


// -------------------- NEW: Analyze endpoint --------------------
// POST /analyze
// Body JSON: { installation_id: number, owner: string, repo: string, ref?: string }
// Returns: { ok: true, analysis: {...} }
app.post('/analyze', async (req, res) => {
  try {
    const { installation_id, owner, repo, ref = 'main' } = req.body || {};
    if (!installation_id || !owner || !repo) {
      return res.status(400).json({ error: 'installation_id, owner and repo are required in JSON body' });
    }

    // get installation octokit
    const installationOctokit = await getInstallationOctokit(installation_id);

    // run analysis
    const analysis = await analyzeRepo(installationOctokit, owner, repo, ref);

    // return compact JSON
    return res.json({ ok: true, analysis });
  } catch (err) {
    console.error('POST /analyze error', err);
    return res.status(500).json({ error: err.message });
  }
});
// ----------------------------------------------------------------

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
