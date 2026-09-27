import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type Mode = 'menu' | 'browse' | 'entry';

function render(lines: string[]): string {
  const width = Math.max(1, Number(process.env.COLUMNS) || process.stdout.columns || 80);
  return lines.map((line) => {
    const chars = [...line];
    if (chars.length <= width) return line;
    const lead = Math.ceil((width - 1) * 0.4);
    return chars.slice(0, lead).join('') + '…' + chars.slice(chars.length - (width - 1 - lead)).join('');
  }).join('\n');
}

export type PickerResult =
  | { done: true; target: string | null; message: string }
  | { done: false; message: string };

/** A prompt-driven folder picker that can share an existing readline session. */
export class SourcePicker {
  private mode: Mode = 'menu';
  private location: string;
  private page = 0;
  private directories: string[] = [];
  private readonly pageSize = 12;

  constructor(start = process.cwd()) {
    this.location = path.resolve(start);
  }

  get prompt(): string { return '  choose > '; }

  async view(): Promise<string> {
    if (this.mode === 'menu') return render([
      '',
      '  SELECT A REPOSITORY',
      `  1  Use current folder  ${this.location}`,
      '  2  Browse folders on this device',
      '  3  Enter a folder path or Git URL',
      '  q  Cancel',
      '',
    ]);
    if (this.mode === 'entry') return render([
      '',
      '  Enter an existing folder path or a Git URL.',
      '  Examples: ~/Projects/my-app  ·  https://github.com/org/repo',
      '  Type `back` to return to the menu.',
      '',
    ]);
    return this.browseView();
  }

  async choose(input: string): Promise<PickerResult> {
    const value = input.trim();
    if (value === 'q' || value === 'quit' || value === 'cancel') {
      return { done: true, target: null, message: '  Selection cancelled.' };
    }
    if (this.mode === 'menu') {
      if (value === '1' || value === '') return { done: true, target: this.location, message: '' };
      if (value === '2') {
        this.mode = 'browse';
        this.page = 0;
        return { done: false, message: await this.view() };
      }
      if (value === '3') {
        this.mode = 'entry';
        return { done: false, message: await this.view() };
      }
      // A pasted path or URL should work immediately, without selecting 3 first.
      return this.validateTarget(value);
    }
    if (this.mode === 'entry') {
      if (value === 'back' || !value) {
        this.mode = 'menu';
        return { done: false, message: await this.view() };
      }
      return this.validateTarget(value);
    }
    if (value === 'back') {
      this.mode = 'menu';
      return { done: false, message: await this.view() };
    }
    if (value === 'home') {
      this.location = os.homedir();
      this.page = 0;
      return { done: false, message: await this.view() };
    }
    if (value === '..') {
      this.location = path.dirname(this.location);
      this.page = 0;
      return { done: false, message: await this.view() };
    }
    if (value === 'use' || value === '.') return { done: true, target: this.location, message: '' };
    if (value === 'n' && (this.page + 1) * this.pageSize < this.directories.length) {
      this.page++;
      return { done: false, message: await this.view() };
    }
    if (value === 'p' && this.page > 0) {
      this.page--;
      return { done: false, message: await this.view() };
    }
    const number = Number(value);
    if (Number.isInteger(number) && number >= 1 && number <= this.pageSize) {
      const selected = this.directories[this.page * this.pageSize + number - 1];
      if (selected) {
        this.location = path.join(this.location, selected);
        this.page = 0;
        return { done: false, message: await this.view() };
      }
    }
    if (value) {
      const result = await this.validateTarget(value);
      if (result.done) return result;
    }
    return { done: false, message: '  Choose a listed folder, `use`, `..`, `home`, or paste a path.' };
  }

  private async browseView(): Promise<string> {
    try {
      const entries = await fs.readdir(this.location, { withFileTypes: true });
      this.directories = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
        .sort((a, b) => a.localeCompare(b));
    } catch (error) {
      this.mode = 'menu';
      const message = error instanceof Error ? error.message : String(error);
      return `  Cannot browse ${this.location}: ${message}\n${await this.view()}`;
    }
    const pages = Math.max(1, Math.ceil(this.directories.length / this.pageSize));
    this.page = Math.min(this.page, pages - 1);
    const shown = this.directories.slice(this.page * this.pageSize, (this.page + 1) * this.pageSize);
    return render([
      '',
      `  FOLDERS  ${this.location}`,
      ...shown.map((name, index) => `  ${String(index + 1).padStart(2)}  ${name}/`),
      ...(shown.length ? [] : ['  No subfolders here.']),
      `  Page ${this.page + 1}/${pages}  ·  n/p next/previous`,
      '  use  Select this folder    ..  Parent    home  Home    back  Menu',
      '',
    ]);
  }

  private async validateTarget(value: string): Promise<PickerResult> {
    if (/^(https?:\/\/|git@|ssh:\/\/)/i.test(value)) {
      return { done: true, target: value, message: '' };
    }
    const expanded = value === '~' ? os.homedir() : value.startsWith('~/')
      ? path.join(os.homedir(), value.slice(2)) : value;
    const target = path.resolve(expanded);
    const stat = await fs.stat(target).catch(() => null);
    if (stat?.isDirectory()) return { done: true, target, message: '' };
    return { done: false, message: `  No folder found at ${target}. Try another path or back.` };
  }
}
