'use strict';

/**
 * Static safety checks for public/ (no browser needed):
 *  1. every named ES-module import exists as an export of the target file
 *  2. no HTML-injection sinks (innerHTML, outerHTML, insertAdjacentHTML, document.write, eval, new Function)
 *  3. no dead links (href="#") or javascript: URLs
 *  4. no inline event-handler attributes or inline <script> code (CSP forbids them)
 *  5. no console logging, and web storage used only for the documented UI preference
 *   npm run check:frontend
 */
const fs = require('fs');
const path = require('path');

const PUBLIC = path.resolve(__dirname, '..', 'public');
const problems = [];
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
const files = walk(PUBLIC);
const rel = (f) => path.relative(PUBLIC, f);
const jsFiles = files.filter((f) => f.endsWith('.js'));
const htmlFiles = files.filter((f) => f.endsWith('.html'));

// Strip comments so prose mentioning e.g. "innerHTML" doesn't trigger a finding.
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"'`\\])\/\/.*$/gm, '$1');

function exportsOf(file) {
  const src = stripComments(fs.readFileSync(file, 'utf8'));
  const names = new Set();
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (name) names.add(name);
    }
  }
  return names;
}

for (const file of jsFiles) {
  const raw = fs.readFileSync(file, 'utf8');
  const src = stripComments(raw);

  for (const m of src.matchAll(/import\s+(?:\*\s+as\s+\w+|\{([^}]*)\})\s+from\s+['"]([^'"]+)['"]/g)) {
    const target = path.resolve(path.dirname(file), m[2]);
    if (!fs.existsSync(target)) { problems.push(`${rel(file)}: imports missing file ${m[2]}`); continue; }
    if (!m[1]) continue;
    const available = exportsOf(target);
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/)[0].trim();
      if (name && !available.has(name)) problems.push(`${rel(file)}: "${name}" is not exported by ${m[2]}`);
    }
  }

  const banned = [
    [/\.(innerHTML|outerHTML)\s*=/, 'assigns innerHTML/outerHTML'],
    [/insertAdjacentHTML\s*\(/, 'uses insertAdjacentHTML'],
    [/document\.write\s*\(/, 'uses document.write'],
    [/\beval\s*\(/, 'uses eval'],
    [/new\s+Function\s*\(/, 'uses new Function'],
    [/javascript:/i, 'contains a javascript: URL'],
    [/href:\s*['"]#['"]/, 'has a dead href="#" link'],
    [/console\.(log|debug|info|warn|error)\s*\(/, 'logs to the console'],
  ];
  for (const [re, msg] of banned) if (re.test(src)) problems.push(`${rel(file)}: ${msg}`);

  for (const m of src.matchAll(/(localStorage|sessionStorage)\.(setItem|getItem)\(\s*([^,)]+)/g)) {
    if (!/PREF_KEY/.test(m[3])) problems.push(`${rel(file)}: web storage used for ${m[3]} (only the balance-visibility preference is allowed)`);
  }
}

for (const file of htmlFiles) {
  const src = fs.readFileSync(file, 'utf8');
  if (/\son[a-z]+\s*=/i.test(src)) problems.push(`${rel(file)}: inline event handler attribute`);
  if (/<script(?![^>]*\bsrc=)[^>]*>\s*\S/i.test(src)) problems.push(`${rel(file)}: inline <script> code`);
  if (/href=["']#["']/.test(src)) problems.push(`${rel(file)}: dead href="#" link`);
  if (/javascript:/i.test(src)) problems.push(`${rel(file)}: javascript: URL`);
  for (const m of src.matchAll(/(?:src|href)=["'](\/[^"'#?]+)["']/g)) {
    if (!fs.existsSync(path.join(PUBLIC, m[1]))) problems.push(`${rel(file)}: references missing asset ${m[1]}`);
  }
}

// Sprite icons referenced from JS/HTML must exist in the sprite.
const sprite = fs.readFileSync(path.join(PUBLIC, 'assets/icons/sprite.svg'), 'utf8');
const symbols = new Set([...sprite.matchAll(/<symbol id="([^"]+)"/g)].map((m) => m[1]));
for (const file of [...jsFiles, ...htmlFiles]) {
  const src = file.endsWith('.js') ? stripComments(fs.readFileSync(file, 'utf8')) : fs.readFileSync(file, 'utf8');
  for (const m of src.matchAll(/icon\(\s*['"]([\w-]+)['"]/g)) if (!symbols.has(m[1])) problems.push(`${rel(file)}: unknown icon "${m[1]}"`);
  for (const m of src.matchAll(/sprite\.svg#([\w-]+)/g)) if (!symbols.has(m[1])) problems.push(`${rel(file)}: unknown icon "${m[1]}"`);
}

if (problems.length) {
  console.error(`Frontend check FAILED (${problems.length}):\n - ${problems.join('\n - ')}`);
  process.exit(1);
}
console.log(`Frontend check passed: ${jsFiles.length} JS modules, ${htmlFiles.length} HTML pages, ${symbols.size} icons.`);
