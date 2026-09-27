// GitHub Actions & CI/CD Workflows View.
// Renders workflow triggers, job dependency DAGs, and execution steps.

import { escapeHtml } from './html.js';

export function renderWorkflows(container, { scan }) {
  if (!container) return;

  const workflows = scan?.workflows || [];

  if (!workflows.length) {
    container.innerHTML = `
      <div class="workflows-empty-wrap">
        <div class="wf-empty-icon">⚙️</div>
        <h3>No CI/CD Workflows Detected</h3>
        <p>No GitHub Actions workflows were found under <code>.github/workflows/</code> in this repository.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = `
    <div class="workflows-layout">
      <header class="workflows-header">
        <div>
          <h2>CI/CD Workflows</h2>
          <span class="wf-sub">Automated build, test, and release pipelines</span>
        </div>
        <div class="wf-count-badge">${workflows.length} workflow${workflows.length === 1 ? '' : 's'}</div>
      </header>

      <div class="workflows-list">
        ${workflows.map((wf) => renderWorkflowCard(wf)).join('')}
      </div>
    </div>
  `;
}

function renderWorkflowCard(wf) {
  const triggers = wf.triggers || [];
  const jobs = wf.jobs || [];

  return `
    <article class="workflow-card">
      <div class="wf-card-top">
        <div class="wf-title-area">
          <span class="wf-name">${escapeHtml(wf.name)}</span>
          <span class="wf-file-path">${escapeHtml(wf.file)}</span>
        </div>
        <div class="wf-triggers">
          <span class="wf-trigger-label">Triggers:</span>
          ${triggers.map((t) => `<span class="wf-trigger-chip">${escapeHtml(t)}</span>`).join('') || '<span class="wf-trigger-chip is-none">none</span>'}
        </div>
      </div>

      <div class="wf-jobs-pipeline">
        <div class="wf-jobs-title">Pipeline Jobs (${jobs.length})</div>
        <div class="wf-jobs-grid">
          ${jobs.map((j) => renderJobCard(j)).join('') || '<p class="wf-no-jobs">No jobs defined</p>'}
        </div>
      </div>
    </article>
  `;
}

function renderJobCard(job) {
  const steps = job.steps || [];
  const needs = job.needs || [];

  return `
    <div class="wf-job-card">
      <div class="wf-job-head">
        <span class="wf-job-name">${escapeHtml(job.name)}</span>
        <span class="wf-job-os">${escapeHtml(job.runsOn || 'ubuntu-latest')}</span>
      </div>

      ${needs.length ? `
        <div class="wf-job-needs">
          <span>Depends on:</span>
          ${needs.map((n) => `<span class="wf-need-tag">${escapeHtml(n)}</span>`).join('')}
        </div>
      ` : ''}

      <div class="wf-steps-list">
        ${steps.map((s, idx) => `
          <div class="wf-step-item">
            <span class="wf-step-num">${idx + 1}</span>
            <span class="wf-step-name" title="${escapeHtml(s.name)}">${escapeHtml(s.name)}</span>
            ${s.uses ? `<span class="wf-step-action" title="${escapeHtml(s.uses)}">${escapeHtml(s.uses.split('@')[0])}</span>` : ''}
          </div>
        `).join('')}
      </div>
    </div>
  `;
}
