// lib/analyze.js
// Analyze a repository (given an Octokit instance and owner/repo/ref)
// Returns a compact JSON with detected languages, important files, run/test commands, env vars, docker/ci info, and short snippets.

const PATHS_OF_INTEREST = [
  'package.json', 'requirements.txt', 'Pipfile', 'pyproject.toml', 'setup.py',
  'go.mod', 'Cargo.toml', 'Gemfile', 'composer.json',
  'Dockerfile', 'docker-compose.yml', '.env.example', '.env.sample',
  'Makefile', 'Procfile',
];

const CI_PATH_PREFIX = '.github/workflows/';

function extCountsFromTree(tree) {
  const counts = {};
  for (const item of tree) {
    if (item.type !== 'blob') continue;
    const p = item.path;
    const ext = p.includes('.') ? p.split('.').pop().toLowerCase() : '';
    if (!ext) continue;
    counts[ext] = (counts[ext] || 0) + 1;
  }
  return counts;
}

function detectPrimaryLanguages(extCounts) {
  const map = {
    js: 'JavaScript',
    ts: 'TypeScript',
    py: 'Python',
    java: 'Java',
    go: 'Go',
    rs: 'Rust',
    rb: 'Ruby',
    php: 'PHP',
    cpp: 'C/C++',
    c: 'C/C++',
    cs: 'C#',
    swift: 'Swift',
    kt: 'Kotlin',
    sh: 'Shell',
  };
  const ranked = Object.entries(extCounts).sort((a, b) => b[1] - a[1]);
  const languages = [];
  for (const [ext] of ranked) {
    if (map[ext]) languages.push(map[ext]);
  }
  return languages.slice(0, 3);
}

function extractEnvVarsFromText(text) {
  const names = new Set();
  if (!text) return [];
  // JS: process.env.VAR or process.env["VAR"] etc
  const re1 = /process\.env\.([A-Za-z0-9_]+)/g;
  let m;
  while ((m = re1.exec(text))) names.add(m[1]);

  const re2 = /process\.env\[['"]([A-Za-z0-9_]+)['"]\]/g;
  while ((m = re2.exec(text))) names.add(m[1]);

  // Python: os.getenv("VAR") or os.environ.get("VAR")
  const re3 = /os\.getenv\(\s*['"]([A-Za-z0-9_]+)['"]/g;
  while ((m = re3.exec(text))) names.add(m[1]);

  const re4 = /os\.environ\.get\(\s*['"]([A-Za-z0-9_]+)['"]/g;
  while ((m = re4.exec(text))) names.add(m[1]);

  // Generic ENV['VAR'], ENV["VAR"]
  const re5 = /ENV\[['"]([A-Za-z0-9_]+)['"]\]/g;
  while ((m = re5.exec(text))) names.add(m[1]);

  // Docker ENV referencing ($VAR)
  const re6 = /\$([A-Za-z0-9_]+)/g;
  while ((m = re6.exec(text))) names.add(m[1]);

  return Array.from(names);
}

function shortSnippet(text, max = 800) {
  if (!text) return '';
  return text.length > max ? text.slice(0, max) + '\n...[truncated]' : text;
}

async function safeGetFile(octokit, owner, repo, path, ref) {
  try {
    const content = await octokit.rest.repos.getContent({ owner, repo, path, ref });
    if (Array.isArray(content.data)) return null;
    const buff = Buffer.from(content.data.content, 'base64');
    return buff.toString('utf-8');
  } catch (e) {
    return null;
  }
}

async function analyzeRepo(octokit, owner, repo, ref = 'main') {
  // 1) fetch tree
  const branch = await octokit.rest.repos.getBranch({ owner, repo, branch: ref });
  const commitSha = branch.data.commit.sha;
  const commit = await octokit.rest.git.getCommit({ owner, repo, commit_sha: commitSha });
  const treeSha = commit.data.tree.sha;
  const treeResp = await octokit.rest.git.getTree({ owner, repo, tree_sha: treeSha, recursive: '1' });
  const tree = treeResp.data.tree;

  // 2) extension counts & primary languages
  const extCounts = extCountsFromTree(tree);
  const primaryLanguages = detectPrimaryLanguages(extCounts);

  // 3) find interesting files from PATHS_OF_INTEREST and CI
  const filesFound = [];
  for (const item of tree) {
    if (item.type !== 'blob') continue;
    const path = item.path;
    if (PATHS_OF_INTEREST.includes(path) || path.startsWith(CI_PATH_PREFIX) || path.toLowerCase().includes('readme')) {
      filesFound.push(path);
    }
  }

  // 4) load short contents for the highest-priority files
  const fileContents = {};
  // prefer package.json, pyproject, Dockerfile, .env.example, workflows
  const priority = [
    'package.json', 'pyproject.toml', 'setup.py', 'requirements.txt', 'Pipfile', 'Dockerfile', 'docker-compose.yml',
    '.env.example', '.env.sample', 'Makefile'
  ];
  // include any CI workflow files explicitly
  for (const p of tree) {
    if (p.type === 'blob' && p.path.startsWith(CI_PATH_PREFIX)) {
      if (!filesFound.includes(p.path)) filesFound.push(p.path);
    }
  }

  // Ensure we attempt to fetch the priority list first
  const toFetch = [...priority, ...filesFound.filter(p => !priority.includes(p))].filter((v, i, a) => a.indexOf(v) === i);

  for (const path of toFetch.slice(0, 40)) { // limit number of files fetched
    const txt = await safeGetFile(octokit, owner, repo, path, ref);
    if (txt) fileContents[path] = shortSnippet(txt, 2000);
  }

  // 5) heuristics: package.json scripts, docker ENTRYPOINT, test commands, env vars
  const analysis = {
    repo: `${owner}/${repo}`,
    ref,
    primaryLanguages,
    extCounts,
    filesFound,
    detected: {
      projectType: null,     // e.g., 'node-app', 'python-lib', 'dockerized-app'
      entrypoint: null,      // command or file
      runCommands: [],       // array of one-liners (strings)
      testCommands: [],
      packageManager: null,  // npm/pip/pipenv/poetry/go/cargo
      envVars: [],           // array of names
      hasDocker: false,
      dockerInfo: null,      // { cmd, entrypoint, exposedPorts }
      hasCI: false,
      ciFiles: [],
      hasTests: false,
      readme: null,
      license: null,
      assumptions: [],
    },
    snippets: fileContents,
  };

  // package.json parsing
  if (fileContents['package.json']) {
    try {
      const pj = JSON.parse(fileContents['package.json']);
      analysis.detected.packageManager = 'npm|yarn';
      analysis.detected.runCommands = analysis.detected.runCommands.concat(
        (pj.scripts && Object.values(pj.scripts)) || []
      );
      if (pj.scripts && pj.scripts.start) analysis.detected.entrypoint = pj.scripts.start;
      if (pj.scripts && pj.scripts.test) {
        analysis.detected.testCommands.push(pj.scripts.test);
        analysis.detected.hasTests = true;
      }
      if (pj.main) analysis.detected.entrypoint = analysis.detected.entrypoint || `node ${pj.main}`;
      if (pj.name) analysis.detected.projectType = analysis.detected.projectType || 'node-project';
    } catch (e) {
      // ignore
    }
  }

  // python: requirements, pyproject
  if (fileContents['requirements.txt'] || fileContents['pyproject.toml'] || fileContents['Pipfile'] || fileContents['setup.py']) {
    analysis.detected.packageManager = analysis.detected.packageManager || 'pip/poetry/pipenv';
    // tests
    if (fileContents['pyproject.toml'] && fileContents['pyproject.toml'].includes('[tool.pytest]') ) {
      analysis.detected.hasTests = true;
      analysis.detected.testCommands.push('pytest');
    }
    if (fileContents['requirements.txt']) {
      // nothing more, but we can note presence
    }
    analysis.detected.projectType = analysis.detected.projectType || 'python-project';
  }

  // Dockerfile detection
  if (fileContents['Dockerfile'] || fileContents['docker-compose.yml']) {
    analysis.detected.hasDocker = true;
    const dock = { cmd: null, entrypoint: null, exposedPorts: [] };
    if (fileContents['Dockerfile']) {
      const df = fileContents['Dockerfile'];
      const mCmd = df.match(/CMD\s+(.*)/i);
      const mEntry = df.match(/ENTRYPOINT\s+(.*)/i);
      const mPort = [...df.matchAll(/EXPOSE\s+([0-9]+)/ig)];
      if (mCmd) dock.cmd = mCmd[1].trim();
      if (mEntry) dock.entrypoint = mEntry[1].trim();
      dock.exposedPorts = mPort.map(x => x[1]);
    }
    analysis.detected.dockerInfo = dock;
    if (!analysis.detected.entrypoint && dock.cmd) analysis.detected.entrypoint = dock.cmd;
    analysis.detected.projectType = analysis.detected.projectType || 'dockerized-app';
  }

  // CI files
  const ciFiles = Object.keys(fileContents).filter(p => p.startsWith(CI_PATH_PREFIX));
  if (ciFiles.length) {
    analysis.detected.hasCI = true;
    analysis.detected.ciFiles = ciFiles;
  }

  // README and LICENSE
  const readmePath = Object.keys(fileContents).find(p => /readme/i.test(p));
  if (readmePath) analysis.detected.readme = shortSnippet(fileContents[readmePath], 1500);
  const licensePath = Object.keys(fileContents).find(p => /license/i.test(p));
  if (licensePath) analysis.detected.license = licensePath;

  // Test detection generic: look for test folders or test commands
  if (!analysis.detected.hasTests) {
    const hasTestFolder = tree.some(t => t.path.match(/(^|\/)(__tests__|tests|test)($|\/)/i));
    if (hasTestFolder) {
      analysis.detected.hasTests = true;
      analysis.detected.testCommands.push(analysis.detected.packageManager && analysis.detected.packageManager.includes('npm') ? 'npm test' : 'pytest');
    }
  }

  // Extract env vars from collected snippets
  const allText = Object.values(fileContents).join('\n\n');
  const envs = extractEnvVarsFromText(allText);
  analysis.detected.envVars = Array.from(new Set( (analysis.detected.envVars || []).concat(envs) ));

  // Fallback run command heuristics
  if (analysis.detected.runCommands.length === 0) {
    if (analysis.detected.packageManager && analysis.detected.packageManager.includes('npm')) {
      analysis.detected.runCommands.push('npm install && npm start');
    } else if (analysis.detected.packageManager && analysis.detected.packageManager.includes('pip')) {
      analysis.detected.runCommands.push('pip install -r requirements.txt && python main.py');
    } else if (analysis.detected.hasDocker) {
      analysis.detected.runCommands.push('docker build -t myapp . && docker run -p 3000:3000 myapp');
    } else {
      analysis.detected.runCommands.push('Check project files for run instructions');
    }
  }

  // Assumptions
  if (!analysis.detected.entrypoint) analysis.detected.assumptions.push('Entry point not obvious — assumed from package files or Dockerfile.');
  if (!analysis.detected.envVars.length) analysis.detected.assumptions.push('No ENV vars detected by static scan — there may still be runtime envs.');

  return analysis;
}

module.exports = { analyzeRepo };
