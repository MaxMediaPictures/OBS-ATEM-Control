'use strict';

// Stub for threadedclass used in the pkg binary.
// The static require below is picked up by esbuild and bundled into bundle.cjs,
// so AtemSocketChild is available in-process with no runtime file lookup.
const { AtemSocketChild } = require('atem-connection/dist/lib/atemSocketChild');

const CLASS_MAP = { AtemSocketChild };

// Wrap every method call in a Promise, matching threadedclass's async API.
function makeProxy(instance) {
  return new Proxy(instance, {
    get(target, prop) {
      const val = Reflect.get(target, prop);
      if (typeof val === 'function') {
        return (...args) => {
          try { return Promise.resolve(val.apply(target, args)); }
          catch (e) { return Promise.reject(e); }
        };
      }
      return val;
    },
  });
}

async function threadedClass(modulePath, className, constructorArgs) {
  const Cls = CLASS_MAP[className];
  if (!Cls) throw new Error(`threadedclass stub: unknown class "${className}"`);
  // Callbacks in constructorArgs are real functions (same process), pass them straight through.
  const instance = new Cls(...constructorArgs);
  return makeProxy(instance);
}

const ThreadedClassManager = {
  // AtemSocket.destroy() calls disconnect() on the proxy first, so nothing extra needed here.
  destroy: async () => {},
  // 'restarted' / 'thread_closed' events don't apply in single-process mode.
  onEvent: () => {},
  removeAllListeners: () => {},
};

module.exports = { threadedClass, ThreadedClassManager };
