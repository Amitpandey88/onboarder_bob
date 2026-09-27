// Monaco Editor wrapper: lazy-loads the vendored AMD build, defines themes
// that match the app's palette, and exposes a tiny read-only viewer API.
// The module itself is import-safe in Node (nothing runs until initViewer);
// only the language mapper is used there.

// Extension → monaco language id. Anything unmapped renders as plaintext.
const MONACO_LANGS = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript',
  py: 'python', pyi: 'python',
  go: 'go', java: 'java', kt: 'kotlin', kts: 'kotlin', scala: 'scala',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp',
  cs: 'csharp', rs: 'rust', rb: 'ruby', php: 'php', swift: 'swift',
  m: 'objective-c', mm: 'objective-c', dart: 'dart', lua: 'lua', r: 'r',
  pl: 'perl', pm: 'perl', ex: 'elixir', exs: 'elixir', clj: 'clojure',
  fs: 'fsharp', vb: 'vb', ps1: 'powershell', sh: 'shell', bash: 'shell',
  zsh: 'shell', fish: 'shell', bat: 'bat', cmd: 'bat',
  json: 'json', jsonc: 'json', yaml: 'yaml', yml: 'yaml', toml: 'ini',
  ini: 'ini', env: 'ini', cfg: 'ini', xml: 'xml', svg: 'xml', xsl: 'xml',
  html: 'html', htm: 'html', css: 'css', scss: 'scss', less: 'less',
  md: 'markdown', markdown: 'markdown', mdx: 'markdown',
  sql: 'sql', mysql: 'mysql', pgsql: 'pgsql', graphql: 'graphql',
  dockerfile: 'dockerfile', tf: 'hcl', hcl: 'hcl', proto: 'protobuf',
  sol: 'solidity', tcl: 'tcl', jl: 'julia', coffee: 'coffeescript',
};

export function monacoLangOf(path) {
  const name = path.split('/').pop().toLowerCase();
  if (name === 'dockerfile' || name.startsWith('dockerfile.')) return 'dockerfile';
  if (name === 'makefile' || name === 'gnumakefile') return 'makefile';
  if (name === 'cmakelists.txt') return 'cmake';
  const ext = (name.match(/\.([a-z0-9]+)$/) || [, ''])[1];
  return MONACO_LANGS[ext] || 'plaintext';
}

// Themes mirroring styles.css: same paper/ink/accent, same token colors.
function defineThemes(monaco) {
  monaco.editor.defineTheme('ob-light', {
    base: 'vs',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '8a8578', fontStyle: 'italic' },
      { token: 'string', foreground: '2f5d3f' },
      { token: 'keyword', foreground: '9a3b2e', fontStyle: 'bold' },
      { token: 'number', foreground: '1f5f8b' },
      { token: 'type', foreground: '6b4fa0' },
    ],
    colors: {
      'editor.background': '#fdfbf6',
      'editor.foreground': '#1c1a16',
      'editorLineNumber.foreground': '#a8a296',
      'editorLineNumber.activeForeground': '#6b675c',
      'editor.lineHighlightBackground': '#f1ede2',
      'editorCursor.foreground': '#1c1a16',
      'editor.selectionBackground': '#d8e4d2',
      'editorIndentGuide.background1': '#e5e0d3',
    },
  });
  monaco.editor.defineTheme('ob-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '6f6a5e', fontStyle: 'italic' },
      { token: 'string', foreground: '8fc7a0' },
      { token: 'keyword', foreground: 'e08a6d', fontStyle: 'bold' },
      { token: 'number', foreground: '7fb3d9' },
      { token: 'type', foreground: 'b49ae0' },
    ],
    colors: {
      'editor.background': '#232019',
      'editor.foreground': '#e8e2d4',
      'editorLineNumber.foreground': '#5c574b',
      'editorLineNumber.activeForeground': '#a8a296',
      'editor.lineHighlightBackground': '#2b2720',
      'editorCursor.foreground': '#e8e2d4',
      'editor.selectionBackground': '#3d4a38',
      'editorIndentGuide.background1': '#343026',
    },
  });
}

let editor = null;
let loadPromise = null;

// Loads Monaco once and creates the single reusable editor instance.
// Resolves false when the vendored build is unavailable — callers fall back
// to the hand-rolled highlighter.
export function initViewer(container, theme) {
  if (editor) return Promise.resolve(true);
  if (loadPromise) return loadPromise;

  loadPromise = new Promise((resolve) => {
    if (typeof window.require !== 'function') return resolve(false);
    window.require.config({ paths: { vs: '/vendor/monaco/vs' } });
    self.MonacoEnvironment = {
      // Language workers are AMD modules — they boot through worker-boot.js,
      // which loads the AMD loader inside the worker first.
      getWorkerUrl: (workerId, label) => {
        const boot = '/vendor/monaco/worker-boot.js';
        if (label === 'typescript' || label === 'javascript') return `${boot}?vs/language/typescript/tsWorker`;
        if (label === 'json') return `${boot}?vs/language/json/jsonWorker`;
        if (label === 'css' || label === 'scss' || label === 'less') return `${boot}?vs/language/css/cssWorker`;
        if (label === 'html' || label === 'handlebars' || label === 'razor') return `${boot}?vs/language/html/htmlWorker`;
        return '/vendor/monaco/vs/base/worker/workerMain.js'; // standalone editor worker
      },
    };
    const fail = setTimeout(() => resolve(false), 8000); // never wedge the tab
    window.require(['vs/editor/editor.main'], () => {
      clearTimeout(fail);
      defineThemes(monaco);
      editor = monaco.editor.create(container, {
        value: '',
        language: 'plaintext',
        theme: theme === 'dark' ? 'ob-dark' : 'ob-light',
        readOnly: true,
        domReadOnly: true,
        automaticLayout: true,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        renderLineHighlight: 'none',
        occurrencesHighlight: 'off',
        folding: true,
        wordWrap: 'off',
        contextmenu: false,
        fontSize: 12.5,
        fontFamily: "'IBM Plex Mono', 'SF Mono', ui-monospace, Menlo, Consolas, monospace",
        lineNumbersMinChars: 4,
        padding: { top: 12, bottom: 12 },
        scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
      });
      resolve(true);
    }, () => { clearTimeout(fail); resolve(false); });
  });
  return loadPromise;
}

// The TS/JS language service loads lazily on the first such model. Once it
// exists, turn validation off: a read-only preview should never draw red
// squiggles for imports the standalone worker cannot resolve.
let tsTamed = false;
function tameTypeScript() {
  if (tsTamed) return;
  const t0 = Date.now();
  const iv = setInterval(() => {
    if (window.monaco?.languages?.typescript) {
      const diag = { noSemanticValidation: true, noSyntaxValidation: true };
      monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions(diag);
      monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions(diag);
      tsTamed = true;
      clearInterval(iv);
    } else if (Date.now() - t0 > 5000) {
      clearInterval(iv);
    }
  }, 200);
}

export function showInViewer(text, lang, theme) {
  if (!editor) return;
  monaco.editor.setTheme(theme === 'dark' ? 'ob-dark' : 'ob-light');
  const model = editor.getModel();
  editor.setValue(text);
  monaco.editor.setModelLanguage(model, lang);
  if (lang === 'javascript' || lang === 'typescript') tameTypeScript();
  editor.setScrollTop(0);
  editor.setScrollLeft(0);
}

export function setViewerTheme(theme) {
  if (editor) monaco.editor.setTheme(theme === 'dark' ? 'ob-dark' : 'ob-light');
}

// Put the viewer on a line and leave the cursor there. Used when a search result
// knows where it matched — opening the right file at line 1 is only half an
// answer, and the other half is the reason a content hit is worth showing.
export function revealLineInViewer(line) {
  if (!editor) return;
  const target = Math.floor(Number(line));
  if (!Number.isFinite(target) || target < 1) return;
  const model = editor.getModel();
  if (!model) return;
  const clamped = Math.min(target, model.getLineCount());
  editor.revealLineInCenter(clamped);
  editor.setPosition({ lineNumber: clamped, column: 1 });
}
