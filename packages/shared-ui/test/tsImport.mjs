// Lets plain Node (22.6+, which strips TypeScript types itself) import this package's .ts sources,
// whose relative imports are written without an extension the way the Next apps resolve them.
// No build step and no dependency, which is what keeps these tests runnable anywhere.
import module from 'node:module';

const tryTs = (specifier, error) => {
  const relative = specifier.startsWith('./') || specifier.startsWith('../');
  if (relative && !/\.[cm]?[jt]sx?$/.test(specifier)) return specifier + '.ts';
  throw error;
};

if (module.registerHooks) {
  module.registerHooks({
    resolve(specifier, context, next) {
      try { return next(specifier, context); } catch (error) { return next(tryTs(specifier, error), context); }
    },
  });
} else {
  // Node before 22.15: the asynchronous hooks, in a module of their own.
  module.register('data:text/javascript,' + encodeURIComponent(`
    export async function resolve(specifier, context, next) {
      try { return await next(specifier, context); } catch (error) {
        const relative = specifier.startsWith('./') || specifier.startsWith('../');
        if (relative && !/\\.[cm]?[jt]sx?$/.test(specifier)) return next(specifier + '.ts', context);
        throw error;
      }
    }`));
}

/** Import one of this package's TypeScript modules by its path under src/. */
export const importSource = (name) => import(new URL(`../src/${name}.ts`, import.meta.url).href);
