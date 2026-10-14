'use strict';

const { badRequest } = require('../utils/errors');

/**
 * Validate request parts with Zod schemas. Parsed (and coerced/trimmed) values
 * go to req.valid.{body,params,query}; handlers read only from req.valid.
 * Schemas are strict, so unexpected fields such as "role" are rejected.
 */
function validate(schemas) {
  return (req, res, next) => {
    req.valid = req.valid || {};
    for (const part of ['params', 'query', 'body']) {
      if (!schemas[part]) continue;
      const result = schemas[part].safeParse(req[part] ?? {});
      if (!result.success) {
        const details = result.error.issues.map((i) => ({
          field: [part, ...i.path].join('.'),
          message: i.code === 'unrecognized_keys' ? `Unexpected field(s): ${i.keys.join(', ')}` : i.message,
        }));
        return next(badRequest('Request validation failed.', details));
      }
      req.valid[part] = result.data;
    }
    return next();
  };
}

module.exports = validate;
