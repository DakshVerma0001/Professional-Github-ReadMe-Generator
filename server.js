const express = require('express');


const PORT = process.env.PORT || 3000;


app.get('/health', (req, res) => res.json({ ok: true }));


app.get('/installations', async (req, res) => {
try {
const appOctokit = getAppOctokit();
const installations = await appOctokit.request('GET /app/installations');
res.json(installations.data);
} catch (err) {
console.error(err);
res.status(500).json({ error: err.message });
}
});


app.get('/installations/:installation_id/repos', async (req, res) => {
try {
const installationId = req.params.installation_id;
const installationOctokit = await getInstallationOctokit(installationId);
const repos = await installationOctokit.request('GET /installation/repositories');
res.json(repos.data);
} catch (err) {
console.error(err);
res.status(500).json({ error: err.message });
}
});


app.get('/repos/:owner/:repo/tree', async (req, res) => {
try {
const { owner, repo } = req.params;
const { installation_id, ref = 'main' } = req.query;
if (!installation_id) return res.status(400).json({ error: 'installation_id query param required' });
const installationOctokit = await getInstallationOctokit(installation_id);
const tree = await getRepoTree(installationOctokit, owner, repo, ref);
res.json(tree);
} catch (err) {
console.error(err);
res.status(500).json({ error: err.message });
}
});


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
console.error(err);
res.status(500).json({ error: err.message });
}
});


app.listen(PORT, () => console.log(`Server running on port ${PORT}`));