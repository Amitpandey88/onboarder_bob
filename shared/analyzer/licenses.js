// License detection and Software Bill of Materials (SBOM) compliance analysis.
// Pure isomorphic analyzer — works in Node and browser.

const KNOWN_LICENSES = [
  { id: 'MIT', name: 'MIT License', type: 'permissive', rx: /\bMIT\b|Permission is hereby granted, free of charge/i },
  { id: 'Apache-2.0', name: 'Apache License 2.0', type: 'permissive', rx: /Apache License,\s*Version 2\.0|http:\/\/www\.apache\.org\/licenses\/LICENSE-2\.0/i },
  { id: 'BSD-3-Clause', name: 'BSD 3-Clause "New" or "Revised" License', type: 'permissive', rx: /Redistribution and use in source and binary forms[\s\S]*?Neither the name of[\s\S]*?nor the names of its contributors/i },
  { id: 'BSD-2-Clause', name: 'BSD 2-Clause "Simplified" License', type: 'permissive', rx: /Redistribution and use in source and binary forms[\s\S]*?Redistributions in binary form must reproduce the above copyright/i },
  { id: 'ISC', name: 'ISC License', type: 'permissive', rx: /Permission to use, copy, modify, and\/or distribute this software for any purpose/i },
  { id: 'GPL-3.0', name: 'GNU General Public License v3.0', type: 'copyleft', rx: /GNU GENERAL PUBLIC LICENSE\s+Version 3|GPL-3\.0/i },
  { id: 'GPL-2.0', name: 'GNU General Public License v2.0', type: 'copyleft', rx: /GNU GENERAL PUBLIC LICENSE\s+Version 2|GPL-2\.0/i },
  { id: 'AGPL-3.0', name: 'GNU Affero General Public License v3.0', type: 'copyleft', rx: /GNU AFFERO GENERAL PUBLIC LICENSE/i },
  { id: 'LGPL-3.0', name: 'GNU Lesser General Public License v3.0', type: 'weak-copyleft', rx: /GNU LESSER GENERAL PUBLIC LICENSE\s+Version 3/i },
  { id: 'MPL-2.0', name: 'Mozilla Public License 2.0', type: 'weak-copyleft', rx: /Mozilla Public License,?\s*v\.?\s*2\.0/i },
  { id: 'Unlicense', name: 'The Unlicense', type: 'public-domain', rx: /This is free and unencumbered software released into the public domain/i },
  { id: 'CC0-1.0', name: 'Creative Commons Zero v1.0 Universal', type: 'public-domain', rx: /CC0 1\.0 Universal|Public Domain Dedication/i },
];

export function detectLicenseFromText(text) {
  if (!text || typeof text !== 'string') return null;
  for (const lic of KNOWN_LICENSES) {
    if (lic.rx.test(text)) {
      return { id: lic.id, name: lic.name, type: lic.type };
    }
  }
  return null;
}

export function classifyLicenseType(licenseId) {
  if (!licenseId || licenseId === 'UNKNOWN') return 'unknown';
  const id = String(licenseId).toUpperCase();
  if (/MIT|APACHE|BSD|ISC|UNLICENSE|CC0|ZLIB|WTFPL/.test(id)) return 'permissive';
  if (/LGPL|MPL|EPL/.test(id)) return 'weak-copyleft';
  if (/AGPL|GPL-2|GPL-3|GPLV2|GPLV3|GPL/.test(id)) return 'copyleft';
  return 'custom';
}

export async function analyzeLicenses(source, manifest = {}) {
  let projectLicense = null;

  // 1. Check root LICENSE / COPYING / LICENSE.md files
  const rootFiles = await source.list('').catch(() => []);
  const licFile = rootFiles.find((f) => /^LICENSE|^COPYING|^UNLICENSE/i.test(f.name));
  if (licFile) {
    const content = await source.read(licFile.path).catch(() => '');
    projectLicense = detectLicenseFromText(content) || {
      id: 'Custom',
      name: licFile.name,
      type: 'custom',
    };
  }

  // 2. Fallback to manifest.license from package.json
  if (!projectLicense && manifest.license) {
    const licId = manifest.license;
    projectLicense = {
      id: licId,
      name: licId,
      type: classifyLicenseType(licId),
    };
  }

  // 3. Build SBOM entries from manifest dependencies
  const sbom = [];
  const addDep = (name, version, ecosystem, dev = false) => {
    sbom.push({
      name,
      version: version || '*',
      ecosystem,
      isDev: dev,
      license: inferKnownDepLicense(name, ecosystem),
    });
  };

  const npmDeps = manifest.deps?.npm || {};
  for (const [name, ver] of Object.entries(npmDeps)) {
    addDep(name, ver, 'npm', false);
  }
  const devDeps = manifest.deps?.dev || {};
  for (const [name, ver] of Object.entries(devDeps)) {
    addDep(name, ver, 'npm', true);
  }
  for (const name of manifest.deps?.pip || []) {
    addDep(name, '*', 'pip', false);
  }
  for (const name of manifest.deps?.go || []) {
    addDep(name, '*', 'go', false);
  }
  for (const name of manifest.deps?.cargo || []) {
    addDep(name, '*', 'cargo', false);
  }

  const counts = { permissive: 0, copyleft: 0, weakCopyleft: 0, unknown: 0, total: sbom.length };
  for (const item of sbom) {
    const type = item.license.type;
    if (type === 'permissive') counts.permissive++;
    else if (type === 'copyleft') counts.copyleft++;
    else if (type === 'weak-copyleft') counts.weakCopyleft++;
    else counts.unknown++;
  }

  const hasCopyleft = counts.copyleft > 0;
  const complianceStatus = hasCopyleft && projectLicense?.type === 'permissive'
    ? 'warning'
    : 'clean';

  return {
    projectLicense: projectLicense || { id: 'UNLICENSED', name: 'None detected', type: 'unknown' },
    sbom,
    counts,
    complianceStatus,
  };
}

// Inferred licenses for standard popular open-source dependencies
const POPULAR_LICENSES = {
  react: 'MIT',
  'react-dom': 'MIT',
  vue: 'MIT',
  express: 'MIT',
  lodash: 'MIT',
  axios: 'MIT',
  typescript: 'Apache-2.0',
  next: 'MIT',
  tailwindcss: 'MIT',
  eslint: 'MIT',
  prettier: 'MIT',
  mocha: 'MIT',
  jest: 'MIT',
  vite: 'MIT',
  fastapi: 'MIT',
  django: 'BSD-3-Clause',
  flask: 'BSD-3-Clause',
  requests: 'Apache-2.0',
  pytest: 'MIT',
  numpy: 'BSD-3-Clause',
  pandas: 'BSD-3-Clause',
  tokio: 'MIT',
  serde: 'MIT / Apache-2.0',
  gin: 'MIT',
  fiber: 'MIT',
};

function inferKnownDepLicense(name, ecosystem) {
  const normName = name.toLowerCase().replace(/^@[^/]+\//, '');
  const id = POPULAR_LICENSES[name] || POPULAR_LICENSES[normName] || 'Permissive (Inferred)';
  return {
    id,
    type: classifyLicenseType(id),
  };
}
