import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectLicenseFromText, classifyLicenseType, analyzeLicenses } from '../shared/analyzer/licenses.js';

test('detectLicenseFromText identifies standard licenses', () => {
  const mit = detectLicenseFromText('Permission is hereby granted, free of charge, to any person obtaining a copy...');
  assert.equal(mit?.id, 'MIT');
  assert.equal(mit?.type, 'permissive');

  const apache = detectLicenseFromText('Licensed under the Apache License, Version 2.0 (the "License");');
  assert.equal(apache?.id, 'Apache-2.0');
  assert.equal(apache?.type, 'permissive');

  const gpl = detectLicenseFromText('GNU GENERAL PUBLIC LICENSE Version 3, 29 June 2007');
  assert.equal(gpl?.id, 'GPL-3.0');
  assert.equal(gpl?.type, 'copyleft');
});

test('classifyLicenseType classifies correctly', () => {
  assert.equal(classifyLicenseType('MIT'), 'permissive');
  assert.equal(classifyLicenseType('Apache-2.0'), 'permissive');
  assert.equal(classifyLicenseType('BSD-3-Clause'), 'permissive');
  assert.equal(classifyLicenseType('GPL-3.0'), 'copyleft');
  assert.equal(classifyLicenseType('LGPL-3.0'), 'weak-copyleft');
});

test('analyzeLicenses extracts SBOM from manifest', async () => {
  const fakeSource = {
    list: async () => [{ name: 'LICENSE', path: 'LICENSE', type: 'file' }],
    read: async () => 'MIT License\n\nCopyright (c) 2026',
  };

  const fakeManifest = {
    license: 'MIT',
    deps: {
      npm: { react: '^18.0.0', lodash: '^4.17.21' },
      dev: { typescript: '^5.0.0' },
      pip: ['requests'],
      go: [],
      cargo: ['tokio'],
    },
  };

  const report = await analyzeLicenses(fakeSource, fakeManifest);
  assert.equal(report.projectLicense.id, 'MIT');
  assert.equal(report.projectLicense.type, 'permissive');
  assert.ok(report.sbom.length >= 4);
  assert.equal(report.complianceStatus, 'clean');
});
