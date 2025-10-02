const { Octokit } = require('@octokit/rest');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');


function loadPrivateKey() {
if (process.env.PRIVATE_KEY_PATH) {
return fs.readFileSync(path.resolve(process.env.PRIVATE_KEY_PATH), 'utf-8');
}
if (process.env.PRIVATE_KEY) {
return process.env.PRIVATE_KEY.replace(/\\n/g, '\n');
}
throw new Error('Missing PRIVATE_KEY or PRIVATE_KEY_PATH in env');
}


function getAppOctokit() {
const appId = process.env.APP_ID;
if (!appId) throw new Error('APP_ID missing in env');
const privateKey = loadPrivateKey();
const now = Math.floor(Date.now() / 1000);
const payload = { iat: now - 60, exp: now + 9 * 60, iss: appId };
const token = jwt.sign(payload, privateKey, { algorithm: 'RS256' });
return new Octokit({ auth: token });
}


async function getInstallationOctokit(installationId) {
const appOctokit = getAppOctokit();
const resp = await appOctokit.request('POST /app/installations/{installation_id}/access_tokens', {
installation_id: installationId,
});
return new Octokit({ auth: resp.data.token });
}


async function getRepoTree(octokit, owner, repo, ref = 'main') {
// get branch commit sha
const branch = await octokit.rest.repos.getBranch({ owner, repo, branch: ref });
const commitSha = branch.data.commit.sha;
// get commit to find tree sha
const commit = await octokit.rest.git.getCommit({ owner, repo, commit_sha: commitSha });
const treeSha = commit.data.tree.sha;
// get tree recursively
const tree = await octokit.rest.git.getTree({ owner, repo, tree_sha: treeSha, recursive: '1' });
return tree.data.tree; // array of { path, type, sha, url }
}


async function getFileContent(octokit, owner, repo, filePath, ref = 'main') {
const resp = await octokit.rest.repos.getContent({ owner, repo, path: filePath, ref });
if (Array.isArray(resp.data)) {
throw new Error('Path is a directory');
}
const buff = Buffer.from(resp.data.content, 'base64');
return buff.toString('utf-8');
}


module.exports = { getAppOctokit, getInstallationOctokit, getRepoTree, getFileContent };