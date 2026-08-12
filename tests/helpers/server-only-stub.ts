/**
 * Stand-in for the `server-only` package under Vitest.
 *
 * The real package throws when imported from a client bundle — a build-time
 * guard that has no meaning in a Node test runner, where every module is server
 * code by definition.
 */
export {};
