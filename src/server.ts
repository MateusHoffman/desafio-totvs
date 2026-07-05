import { app } from './app';
import { logger } from './observability';
import { startWorker } from './worker';

startWorker();
app.listen(3000, () => logger.info('API no ar', { port: 3000 }));
