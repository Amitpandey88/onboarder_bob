// Worker bootstrap for the vendored Monaco build. The language workers
// (tsWorker & friends) are AMD modules, so they need the loader inside the
// worker first; the module to run arrives as the query string:
//   worker-boot.js?vs/language/typescript/tsWorker
self.MonacoEnvironment = { baseUrl: location.origin + '/vendor/monaco/' };
importScripts(location.origin + '/vendor/monaco/vs/loader.js');
require.config({ paths: { vs: location.origin + '/vendor/monaco/vs' } });
const mod = decodeURIComponent(location.search.slice(1));
require([mod], () => {}, (err) => { throw err; });
