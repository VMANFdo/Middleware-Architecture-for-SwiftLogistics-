'use strict';

/**
 * Test helpers for stubbing the gateway's Postgres pool.
 *
 * app.js routes every database access through the single exported `pool`
 * instance, so replacing `pool.query` is enough to run the REST layer
 * without a database.
 */

/**
 * Install a fixture-driven `pool.query` implementation.
 *
 * @param {object} pool    the pool exported by ../app
 * @param {Array<[RegExp, object|Function]>} fixtures
 *        ordered [sqlPattern, rows] pairs; the first match wins.
 *        A function value receives (sql, params) and returns the result.
 * @returns {{calls: Array<{sql: string, params: any[]}>, restore: () => void}}
 */
function installFakePool(pool, fixtures = []) {
  const calls = [];

  const spy = jest.spyOn(pool, 'query').mockImplementation(async (sql, params) => {
    calls.push({ sql, params });

    for (const [pattern, result] of fixtures) {
      if (pattern.test(sql)) {
        return typeof result === 'function' ? result(sql, params) : result;
      }
    }

    return { rows: [] };
  });

  return {
    calls,
    restore: () => spy.mockRestore(),
  };
}

/** Convenience: a fixture that always returns the given rows. */
function rows(value) {
  return { rows: value };
}

module.exports = { installFakePool, rows };
