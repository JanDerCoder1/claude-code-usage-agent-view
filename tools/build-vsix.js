#!/usr/bin/env node
'use strict';
// Dependency-free .vsix builder (Node >= 14, built-ins only: fs, path, zlib).
// usage: node build-vsix.js <extensionDir> [outFile.vsix] [--secondary]
//
// A .vsix is a plain zip:
//   [Content_Types].xml          OPC content types, one <Default> per file extension
//   extension.vsixmanifest       XML identity/metadata, generated from package.json
//   extension/package.json       the real manifest; everything the extension needs lives under extension/
//   extension/<all other files>
//
// What goes in (SPEC 10): an allow-list AND an exclude list. The production package contains only
//   package.json, extension.js, lib/*.js, media/*, README.md, LICENSE
// Excluded explicitly: test/, tools/, dist/, docs/, .tmp/, fixtures, *.md except README.md, node_modules, .git, *.vsix.
// Anything else the allow-list rejects is reported ("not included") instead of being dropped silently.
//
// --secondary builds the variant that declares the view container in the secondary side bar
// (viewsContainers.secondarySidebar, engines.vscode ^1.106.0) instead of the activity bar.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const EXCLUDE_TOP_DIRS = ['.git', 'node_modules', '.vscode', '.tmp', 'test', 'tools', 'dist', 'docs'];
const EXCLUDE_ANY_DIRS = [/^\.git$/, /^node_modules$/, /^fixtures?$/i];
const EXCLUDE_FILES = [/\.vsix$/i, /^\.vscodeignore$/, /^\.gitignore$/, /^\.gitattributes$/, /^package-lock\.json$/, /\.test\.js$/];
const INCLUDE = [/^package\.json$/, /^extension\.js$/, /^lib\/[^/]+\.js$/, /^media\/.+/, /^README\.md$/, /^LICENSE$/];

const MIME = {
  json: 'application/json', js: 'application/javascript', css: 'text/css', svg: 'image/svg+xml', md: 'text/markdown',
  txt: 'text/plain', png: 'image/png', jpg: 'image/jpeg', html: 'text/html', vsixmanifest: 'text/xml', xml: 'text/xml',
};
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function isExcludedDir(rel) {
  const parts = rel.split('/');
  return EXCLUDE_TOP_DIRS.includes(parts[0]) || parts.some((p) => EXCLUDE_ANY_DIRS.some((re) => re.test(p)));
}

function isExcludedFile(rel) {
  const base = rel.split('/').pop();
  if (/\.md$/i.test(base) && rel !== 'README.md') return true;
  return EXCLUDE_FILES.some((re) => re.test(base));
}

const isIncluded = (rel) => INCLUDE.some((re) => re.test(rel));

/** Walks `src`; returns { files: included relative paths (forward slashes, sorted), notIncluded: rejected by the allow-list }. */
function collectFiles(src) {
  const files = [];
  const notIncluded = [];
  (function walk(dir, rel) {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${d.name}` : d.name; // zip entry names always use forward slashes
      if (d.isDirectory()) { if (!isExcludedDir(r)) walk(path.join(dir, d.name), r); continue; }
      if (!d.isFile()) continue; // symlinks and special files never go into a package
      if (isExcludedDir(r) || isExcludedFile(r)) continue;
      if (isIncluded(r)) files.push(r); else notIncluded.push(r);
    }
  })(src, '');
  files.sort();
  notIncluded.sort();
  return { files, notIncluded };
}

function applySecondary(pkg) {
  const p = JSON.parse(JSON.stringify(pkg));
  const vc = (p.contributes && p.contributes.viewsContainers) || {};
  if (!Array.isArray(vc.activitybar)) throw new Error('--secondary needs contributes.viewsContainers.activitybar');
  const rest = Object.assign({}, vc);
  delete rest.activitybar;
  p.contributes.viewsContainers = Object.assign(rest, { secondarySidebar: vc.activitybar });
  p.engines = Object.assign({}, p.engines, { vscode: '^1.106.0' });
  return p;
}

function vsixManifest(pkg, files) {
  const kind = Array.isArray(pkg.extensionKind) ? pkg.extensionKind.join(',') : (pkg.extensionKind || '');
  const engine = pkg.engines && pkg.engines.vscode;
  return `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="${esc(pkg.name)}" Version="${esc(pkg.version)}" Publisher="${esc(pkg.publisher)}"/>
    <DisplayName>${esc(pkg.displayName || pkg.name)}</DisplayName>
    <Description xml:space="preserve">${esc(pkg.description || '')}</Description>
    <Tags></Tags>
    <Categories>${esc((pkg.categories || ['Other']).join(','))}</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${esc(engine)}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="${esc(kind)}" />
      <Property Id="Microsoft.VisualStudio.Code.LocalizedLanguages" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.EnabledApiProposals" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExecutesCode" Value="true" />
      <Property Id="Microsoft.VisualStudio.Services.Content.Pricing" Value="Free"/>
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code"/>
  </Installation>
  <Dependencies/>
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />${files.includes('README.md') ? '\n    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />' : ''}
${files.includes('LICENSE') ? '    <Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE" Addressable="true" />\n' : ''}  </Assets>
</PackageManifest>
`;
}

function contentTypes(files) {
  const exts = new Set(['json', 'vsixmanifest']);
  for (const f of files) { const e = path.extname(f).slice(1).toLowerCase(); if (e) exts.add(e); }
  const bare = files.filter((f) => !path.extname(f) && path.basename(f) === f);      // LICENSE has no extension: it gets its own content type
  const defaults = Array.from(exts).sort().map((e) => `<Default Extension=".${e}" ContentType="${MIME[e] || 'application/octet-stream'}"/>`);
  return `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${defaults.join('')}${bare.map((f) => `<Override PartName="/extension/${f}" ContentType="text/plain"/>`).join('')}</Types>
`;
}

// ---- minimal zip writer (deflate, UTF-8 names, no zip64: fine below 4 GiB / 65535 entries) ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function zip(entries) {
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((Math.max(1980, now.getFullYear()) - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const comp = zlib.deflateRawSync(e.data, { level: 9 });
    const useDeflate = comp.length < e.data.length;
    const body = useDeflate ? comp : e.data;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(e.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(dosTime, 10); lh.writeUInt16LE(dosDate, 12); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(e.data.length, 22); lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    chunks.push(lh, name, body);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(dosTime, 12); ch.writeUInt16LE(dosDate, 14); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(e.data.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(0, 38); ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += lh.length + name.length + body.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cd, eocd]);
}

/**
 * @param {{ src: string, out?: string, secondary?: boolean }} opts
 * @returns {{ out: string, bytes: number, entries: string[], notIncluded: string[], warnings: string[], pkg: object }}
 */
function buildVsix(opts) {
  const src = path.resolve((opts && opts.src) || '.');
  const secondary = !!(opts && opts.secondary);
  const pkgPath = path.join(src, 'package.json');
  if (!fs.existsSync(pkgPath)) throw new Error('package.json missing in ' + src);
  const basePkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const pkg = secondary ? applySecondary(basePkg) : basePkg;
  if (!pkg.name || !pkg.publisher || !pkg.version || !(pkg.engines && pkg.engines.vscode)) {
    throw new Error('package.json needs name, publisher, version, engines.vscode');
  }
  const out = path.resolve((opts && opts.out) || path.join(src, `${pkg.name}-${pkg.version}${secondary ? '-secondary' : ''}.vsix`));

  const { files, notIncluded } = collectFiles(src);
  const warnings = [];
  const mainRel = typeof pkg.main === 'string' ? pkg.main.replace(/^\.\//, '') : null;
  if (mainRel && !files.includes(mainRel)) throw new Error(`main file "${mainRel}" is not part of the package`);
  const iconRefs = new Set();
  const vc = (pkg.contributes && pkg.contributes.viewsContainers) || {};
  for (const k of Object.keys(vc)) for (const c of vc[k] || []) if (c && c.icon) iconRefs.add(c.icon);
  for (const v of Object.values((pkg.contributes && pkg.contributes.views) || {})) for (const c of v || []) if (c && c.icon) iconRefs.add(c.icon);
  for (const ic of iconRefs) if (!/^\$\(/.test(ic) && !files.includes(ic.replace(/^\.\//, ''))) warnings.push(`icon "${ic}" is not part of the package`);

  const pkgData = secondary ? Buffer.from(JSON.stringify(pkg, null, 2) + '\n', 'utf8') : fs.readFileSync(pkgPath);
  const entries = [
    { name: '[Content_Types].xml', data: Buffer.from(contentTypes(files), 'utf8') },
    { name: 'extension.vsixmanifest', data: Buffer.from(vsixManifest(pkg, files), 'utf8') },
    ...files.map((f) => ({ name: `extension/${f}`, data: f === 'package.json' ? pkgData : fs.readFileSync(path.join(src, f)) })),
  ];
  const data = zip(entries);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, data);
  return { out, bytes: data.length, entries: entries.map((e) => e.name), notIncluded, warnings, pkg };
}

function main(argv) {
  const args = argv.filter((a) => !a.startsWith('--'));
  const r = buildVsix({ src: args[0] || '.', out: args[1], secondary: argv.includes('--secondary') });
  console.log(`wrote ${r.out} (${r.bytes} bytes, ${r.entries.length} entries)`);
  for (const e of r.entries) console.log('  ' + e);
  for (const f of r.notIncluded) console.log('  not included (allow-list): ' + f);
  for (const w of r.warnings) console.log('  warning: ' + w);
}

module.exports = { buildVsix, collectFiles, isIncluded, isExcludedDir, isExcludedFile, applySecondary, INCLUDE };

if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exitCode = 1; }
}
