// Stack analytics: from the manifest's declared dependencies plus the scan
// language counts, name the frameworks, libraries and languages a repo leans
// on — each tagged with a category and the official docs URL. The docs URLs
// feed the server-side /api/doc fetch (allowlisted) for informed summaries.

// name -> [category, docs url]
const KNOWN = {
  react: ['Frontend framework', 'https://react.dev'],
  'react-dom': ['Frontend framework', 'https://react.dev'],
  '@angular/core': ['Frontend framework', 'https://angular.dev'],
  vue: ['Frontend framework', 'https://vuejs.org'],
  svelte: ['Frontend framework', 'https://svelte.dev'],
  next: ['Web framework', 'https://nextjs.org/docs'],
  nuxt: ['Web framework', 'https://nuxt.com/docs'],
  remix: ['Web framework', 'https://remix.run/docs'],
  gatsby: ['Web framework', 'https://www.gatsbyjs.com/docs'],
  express: ['Web framework', 'https://expressjs.com'],
  fastify: ['Web framework', 'https://fastify.dev'],
  koa: ['Web framework', 'https://koajs.com'],
  '@nestjs/core': ['Web framework', 'https://docs.nestjs.com'],
  hapi: ['Web framework', 'https://hapi.dev'],
  flask: ['Web framework', 'https://flask.palletsprojects.com'],
  django: ['Web framework', 'https://docs.djangoproject.com'],
  fastapi: ['Web framework', 'https://fastapi.tiangolo.com'],
  'spring-boot': ['Web framework', 'https://docs.spring.io/spring-boot'],
  laravel: ['Web framework', 'https://laravel.com/docs'],
  rails: ['Web framework', 'https://guides.rubyonrails.org'],
  gin: ['Web framework', 'https://gin-gonic.com'],
  echo: ['Web framework', 'https://echo.labstack.com'],
  fiber: ['Web framework', 'https://gofiber.io'],
  'actix-web': ['Web framework', 'https://actix.rs'],
  axum: ['Web framework', 'https://docs.rs/axum'],
  rocket: ['Web framework', 'https://rocket.rs'],
  prisma: ['Database / ORM', 'https://www.prisma.io/docs'],
  sequelize: ['Database / ORM', 'https://sequelize.org'],
  typeorm: ['Database / ORM', 'https://typeorm.io'],
  sqlalchemy: ['Database / ORM', 'https://docs.sqlalchemy.org'],
  'drizzle-orm': ['Database / ORM', 'https://orm.drizzle.team'],
  mongoose: ['Database / ORM', 'https://mongoosejs.com'],
  knex: ['Database / ORM', 'https://knexjs.org'],
  pg: ['Database / ORM', 'https://node-postgres.com'],
  pymongo: ['Database / ORM', 'https://pymongo.readthedocs.io'],
  gorm: ['Database / ORM', 'https://gorm.io'],
  sqlx: ['Database / ORM', 'https://docs.rs/sqlx'],
  diesel: ['Database / ORM', 'https://diesel.rs'],
  redis: ['Database / ORM', 'https://redis.io/docs/'],
  jest: ['Testing', 'https://jestjs.io'],
  vitest: ['Testing', 'https://vitest.dev'],
  mocha: ['Testing', 'https://mochajs.org'],
  '@testing-library/react': ['Testing', 'https://testing-library.com'],
  pytest: ['Testing', 'https://docs.pytest.org'],
  playwright: ['Testing', 'https://playwright.dev'],
  cypress: ['Testing', 'https://docs.cypress.io'],
  rspec: ['Testing', 'https://rspec.info'],
  typescript: ['Tooling / build', 'https://www.typescriptlang.org/docs'],
  vite: ['Tooling / build', 'https://vitejs.dev/guide/'],
  webpack: ['Tooling / build', 'https://webpack.js.org'],
  esbuild: ['Tooling / build', 'https://esbuild.github.io'],
  babel: ['Tooling / build', 'https://babeljs.io/docs'],
  rollup: ['Tooling / build', 'https://rollupjs.org'],
  tailwindcss: ['UI / styling', 'https://tailwindcss.com/docs'],
  bootstrap: ['UI / styling', 'https://getbootstrap.com/docs'],
  sass: ['UI / styling', 'https://sass-lang.com/documentation'],
  'styled-components': ['UI / styling', 'https://styled-components.com'],
  axios: ['Networking', 'https://axios-http.com'],
  requests: ['Networking', 'https://requests.readthedocs.io'],
  urllib3: ['Networking', 'https://urllib3.readthedocs.io'],
  httpx: ['Networking', 'https://www.python-httpx.org'],
  passport: ['Auth', 'https://www.passportjs.org'],
  'next-auth': ['Auth', 'https://next-auth.js.org'],
  jsonwebtoken: ['Auth', 'https://github.com/auth0/node-jsonwebtoken'],
  pydantic: ['Data validation', 'https://docs.pydantic.dev'],
  numpy: ['Data / science', 'https://numpy.org/doc/'],
  pandas: ['Data / science', 'https://pandas.pydata.org/docs/'],
  'scikit-learn': ['Data / science', 'https://scikit-learn.org/stable/'],
  torch: ['Data / science', 'https://pytorch.org/docs/'],
  tensorflow: ['Data / science', 'https://www.tensorflow.org/api_docs'],
  'opencv-python': ['Data / science', 'https://docs.opencv.org'],
  keras: ['Data / science', 'https://keras.io'],
  'python-dotenv': ['Tooling / config', 'https://github.com/theskumar/python-dotenv'],
};

const ORDER = [
  'Web framework', 'Frontend framework', 'Database / ORM', 'Auth',
  'Networking', 'Data / science', 'Data validation', 'UI / styling',
  'Testing', 'Tooling / build', 'Tooling / config', 'Library',
];

// Where a dependency that is not in KNOWN sends you: its registry page. Named
// here rather than inlined below because two things need them — the URL
// builders, and the host allowlist under them.
const REGISTRY = {
  npm: (name) => `https://www.npmjs.com/package/${name}`,
  pip: (name) => `https://pypi.org/project/${name}/`,
  go: (name) => `https://pkg.go.dev/${name}`,
  cargo: (name) => `https://docs.rs/${name}`,
};

// Every host `analyzeStack` can hand out a docs URL for. The server allowlists
// exactly this set for `/api/doc`, and that is the SSRF guard: a host no
// dependency name can produce is a host the server will not fetch.
//
// Derived, not restated. The server used to carry its own hand-written copy of
// this list, and the two had drifted: `diesel.rs` was reachable from a Cargo
// dependency but missing from the allowlist, so those docs always came back 403,
// while `docusaurus.io`, `auth0.com` and a bare `readthedocs.io` were allowed
// and nothing here could ever ask for them — the last one opening every project
// on the site rather than the three we name.
//
// `www.` comes off because the caller strips it from the incoming host too;
// leaving it on would mean `www.npmjs.com` never matched a request for
// `npmjs.com`.
export const DOC_HOSTS = Object.freeze([...new Set(
  [
    ...Object.values(KNOWN).map(([, url]) => url),
    ...Object.values(REGISTRY).map((toUrl) => toUrl('any')),
  ].map((url) => new URL(url).hostname.replace(/^www\./, ''))
)].sort());

function cleanVersion(v) {
  return String(v || '').replace(/^[\^~>=< ]+/, '').split(' ')[0].trim();
}

export function analyzeStack(manifest = {}, languages = {}) {
  const deps = manifest.deps || { npm: {}, dev: {}, pip: [], go: [], cargo: [] };
  const items = [];
  const seen = new Set();

  const add = (name, version, category, lang, docs, dev = false) => {
    if (!name || seen.has(name)) return;
    seen.add(name);
    items.push({ name, version: cleanVersion(version), category, lang, docs, dev });
  };

  const npmDocs = (name) => {
    const k = KNOWN[name];
    return k ? k[1] : REGISTRY.npm(name);
  };
  const catOf = (name) => {
    const k = KNOWN[name];
    return k ? k[0] : 'Library';
  };

  for (const [name, ver] of Object.entries(deps.npm || {})) {
    if (name !== 'react-dom') add(name, ver, catOf(name), 'JavaScript', npmDocs(name), false);
  }
  for (const [name, ver] of Object.entries(deps.dev || {})) {
    if (name !== 'react-dom') add(name, ver, catOf(name), 'JavaScript', npmDocs(name), true);
  }
  for (const name of deps.pip || []) {
    const k = KNOWN[name];
    add(name, '', k ? k[0] : 'Library', 'Python', k ? k[1] : REGISTRY.pip(name), false);
  }
  for (const name of deps.go || []) {
    const k = KNOWN[name.split('/').pop()];
    add(name, '', k ? k[0] : 'Library', 'Go', REGISTRY.go(name), false);
  }
  for (const name of deps.cargo || []) {
    const k = KNOWN[name] || KNOWN[name.replace(/_/g, '-')];
    add(name, '', k ? k[0] : 'Library', 'Rust', k ? k[1] : REGISTRY.cargo(name), false);
  }

  items.sort((a, b) => (ORDER.indexOf(a.category) - ORDER.indexOf(b.category)) || a.name.localeCompare(b.name));

  const pm = [];
  if (deps.npm && Object.keys(deps.npm).length) pm.push('npm');
  if (deps.pip && deps.pip.length) pm.push('pip');
  if (deps.go && deps.go.length) pm.push('go modules');
  if (deps.cargo && deps.cargo.length) pm.push('cargo');

  return { languages, pm, items: items.slice(0, 48) };
}

