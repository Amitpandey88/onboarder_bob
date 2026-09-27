// The wizard's face: one readline interface that renders the pure steps from
// `wizard.js`. Everything display-shaped lives here — numbered choices, hints
// in gray, validation loops that re-ask with the reason — and nothing
// decision-shaped does. A step asks, validates, returns; the engine decides
// what the answer means.
//
// Ctrl-C is a first-class answer ("cancelled"), not a stack trace: the wizard
// has written nothing yet at any point it can be pressed, and it says so.

import readline from 'node:readline/promises';

import { bold, cyan, dim, bad, section } from './ui.js';
import { defaultOf } from './wizard.js';

export class WizardCancelled extends Error {
  constructor() {
    super('cancelled');
    this.code = 'CANCELLED';
  }
}

// Run every pending step in order, collecting answers. `answers` is seeded
// with flag answers by the caller, which is how --flags skip questions.
export async function runSteps(steps, answers = {}, io = {}) {
  const input = io.input || process.stdin;
  const output = io.output || process.stdout;
  const rl = readline.createInterface({ input, output });
  // readline eats SIGINT when the terminal is in its raw-ish mode; route it to
  // the same cancellation path as anything else that would kill us mid-ask.
  const onSigint = () => rl.close();
  process.once('SIGINT', onSigint);
  try {
    let lastSection = null;
    for (const step of steps) {
      // `when` is evaluated here, one question at a time — never upfront.
      // Conditions read answers collected earlier in the same run ("ask about
      // the bind only when mode is self-hosted"), so filtering the list
      // before the first question would prune branches the answers reopen.
      if (step.when && !step.when(answers)) continue;
      if (step.section && step.section !== lastSection) {
        output.write(section(step.section) + '\n');
        lastSection = step.section;
      }
      answers[step.id] = await askOne(rl, output, step, answers);
    }
    return answers;
  } catch (err) {
    throw new WizardCancelled();
  } finally {
    process.removeListener('SIGINT', onSigint);
    rl.close();
  }
}

async function askOne(rl, output, step, answers) {
  // Re-ask until the validator is happy; each failure prints the reason so the
  // next attempt is informed rather than punished.
  for (;;) {
    const value = step.type === 'choice'
      ? await askChoice(rl, output, step, answers)
      : step.type === 'confirm'
        ? await askConfirm(rl, step, answers)
        : await askText(rl, step, answers);
    const complaint = step.validate ? step.validate(value) : null;
    if (!complaint) return value;
    output.write(bad('    ' + complaint) + '\n');
  }
}

async function askText(rl, step, answers) {
  const fallback = defaultOf(step, answers);
  if (step.hint) rl.output.write(dim('    ' + step.hint) + '\n');
  const suffix = fallback ? dim(` (${fallback})`) : '';
  const typed = await rl.question(`  ${bold(step.question)}${suffix}: `);
  const value = typed.trim() || String(fallback ?? '');
  return step.type === 'text' && /port/i.test(step.id) ? value : value;
}

async function askConfirm(rl, step, answers) {
  const fallback = Boolean(defaultOf(step, answers));
  const typed = await rl.question(`  ${bold(step.question)} ${dim(fallback ? '(Y/n)' : '(y/N)')} `);
  const v = typed.trim().toLowerCase();
  if (!v) return fallback;
  return v === 'y' || v === 'yes';
}

async function askChoice(rl, output, step, answers) {
  const fallback = defaultOf(step, answers);
  const choices = step.choices.filter((c) => !c.when || c.when(answers));
  output.write(`  ${bold(step.question)}\n`);
  choices.forEach((c, i) => {
    const marker = c.value === fallback ? cyan('›') : ' ';
    const hint = c.hint ? dim('  ' + c.hint) : '';
    output.write(`   ${marker} ${i + 1}. ${c.label}${hint}\n`);
  });
  if (step.hint) output.write(dim('    ' + step.hint) + '\n');
  const typed = await rl.question(dim('  Choose [1-' + choices.length + '] ') + '');
  const v = typed.trim();
  if (!v) return fallback;
  const byNumber = choices[Number(v) - 1];
  if (byNumber) return byNumber.value;
  const byValue = choices.find((c) => c.value === v.toLowerCase());
  if (byValue) return byValue.value;
  output.write(bad('    Pick a number from the list.') + '\n');
  return askChoice(rl, output, step, answers);
}
