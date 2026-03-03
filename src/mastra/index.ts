
import { Mastra } from '@mastra/core/mastra';
import { PinoLogger } from '@mastra/loggers';
import { LibSQLStore } from '@mastra/libsql';
import { Observability, DefaultExporter, CloudExporter, SensitiveDataFilter } from '@mastra/observability';
import { voiceAgent } from './agents/voice-agent';

const libsqlUrl =
  process.env.MASTRA_STORAGE_URL ??
  process.env.LIBSQL_URL ??
  process.env.TURSO_DATABASE_URL ??
  (process.env.VERCEL ? 'file:/tmp/mastra.db' : 'file:./mastra.db');

const libsqlAuthToken =
  process.env.LIBSQL_AUTH_TOKEN ?? process.env.TURSO_AUTH_TOKEN;

const storageConfig = {
  id: 'mastra-storage',
  url: libsqlUrl,
  ...(libsqlUrl.startsWith('file:') ? {} : libsqlAuthToken ? { authToken: libsqlAuthToken } : {}),
};

export const mastra = new Mastra({
  agents: { voiceAgent },
  storage: new LibSQLStore(storageConfig),
  logger: new PinoLogger({
    name: 'Mastra',
    level: 'info',
  }),
  observability: new Observability({
    configs: {
      default: {
        serviceName: 'mastra',
        exporters: [
          new DefaultExporter(), // Persists traces to storage for Mastra Studio
          new CloudExporter(), // Sends traces to Mastra Cloud (if MASTRA_CLOUD_ACCESS_TOKEN is set)
        ],
        spanOutputProcessors: [
          new SensitiveDataFilter(), // Redacts sensitive data like passwords, tokens, keys
        ],
      },
    },
  }),
});
