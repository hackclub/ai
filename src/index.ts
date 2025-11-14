import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { serveStatic } from 'hono/bun';
import { csrf } from 'hono/csrf';
import { requestId } from 'hono/request-id';
import { bodyLimit } from 'hono/body-limit';
import { timeout } from 'hono/timeout';
import { secureHeaders } from 'hono/secure-headers';
import { HTTPException } from 'hono/http-exception';
import { env } from './env';
import auth from './routes/auth';
import proxy from './routes/proxy';
import api from './routes/api';
import dashboard from './routes/dashboard';
import { runMigrations } from './migrate';
import type { AppVariables } from './types';
import type { RequestIdVariables } from 'hono/request-id';

await runMigrations();

const app = new Hono<{ Variables: AppVariables & RequestIdVariables }>();

app.use('*', secureHeaders());
app.use('/proxy/*', bodyLimit({
  maxSize: 20 * 1024 * 1024,
  onError: (c) => {
    throw new HTTPException(413, { message: 'Request too large' });
  },
}));
app.use('/proxy/*', timeout(120000));

app.use('/*', requestId());
app.use('/*', csrf({ origin: env.BASE_URL }));

if (env.NODE_ENV === 'development') {
  app.use('*', logger());
}

app.use('/*', serveStatic({ root: './public' }));

app.onError((err, c) => {
  if (err instanceof HTTPException) {
    return err.getResponse();
  }
  console.error('Unhandled error:', err);
  return c.json({ error: 'Internal server error' }, 500);
});

app.route('/', dashboard);
app.route('/auth', auth);
app.route('/proxy', proxy);
app.route('/api', api);

const port = parseInt(env.PORT);

console.log(`Server running on http://localhost:${port}`);

export default {
  port,
  fetch: app.fetch,
  idleTimeout: 60
};
