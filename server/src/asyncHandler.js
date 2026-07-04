// Express 4 does not forward rejected promises from async handlers to the error
// middleware, which would otherwise leave the request hanging. Wrap async handlers
// so any rejection reaches next(err).
export const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
