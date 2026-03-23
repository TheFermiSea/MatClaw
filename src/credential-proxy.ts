/**
 * Credential proxy for container isolation.
 * Containers connect here instead of directly to the Anthropic API.
 * The proxy injects real credentials so containers never see them.
 *
 * Adapted from pharma-claw's credential-proxy.ts.
 *
 * Two auth modes:
 *   API key:  Proxy injects x-api-key on every request.
 *   OAuth:    Container CLI exchanges its placeholder token for a temp
 *             API key via /api/oauth/claude_cli/create_api_key.
 *             Proxy injects real OAuth token on that exchange request;
 *             subsequent requests carry the temp key which is valid as-is.
 *
 * On macOS, OAuth tokens are auto-refreshed from the system keychain.
 */
import { execSync } from 'child_process';
import { createServer, Server } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';
import { createConnection } from 'net';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

/**
 * Kill any process occupying the given port.
 */
function killPortHolder(port: number): boolean {
  try {
    const cmd =
      os.platform() === 'darwin'
        ? `/usr/sbin/lsof -ti :${port}`
        : `lsof -ti :${port} 2>/dev/null || fuser ${port}/tcp 2>/dev/null`;
    const pid = execSync(cmd, { encoding: 'utf8' }).trim();
    if (pid) {
      const pids = pid
        .split('\n')
        .map((p) => p.trim())
        .filter(Boolean);
      for (const p of pids) {
        if (Number(p) === process.pid) continue;
        try {
          process.kill(Number(p), 'SIGTERM');
          logger.info({ port, pid: p }, 'Killed stale process holding port');
        } catch {
          // process may have already exited
        }
      }
      return pids.length > 0;
    }
  } catch {
    // no process found — fine
  }
  return false;
}

function isPortAvailable(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ port, host }, () => {
      sock.destroy();
      resolve(false);
    });
    sock.on('error', () => resolve(true));
    sock.setTimeout(500, () => {
      sock.destroy();
      resolve(true);
    });
  });
}

export type AuthMode = 'api-key' | 'oauth';

/**
 * Read the current OAuth access token from the macOS keychain.
 * Claude Code stores its OAuth credentials in the login keychain
 * under the service "Claude Code-credentials".
 */
function readOAuthFromKeychain(): string | null {
  if (os.platform() !== 'darwin') return null;
  try {
    const raw = execSync(
      'security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null',
      { encoding: 'utf-8', timeout: 5000 },
    ).trim();
    const parsed = JSON.parse(raw);
    const token = parsed?.claudeAiOauth?.accessToken;
    if (token && typeof token === 'string') return token;
  } catch {
    // Keychain not available or entry missing
  }
  return null;
}

/**
 * Read OAuth token from Claude credentials file (Linux/cross-platform).
 */
function readOAuthFromCredentials(): string | null {
  const credPath = path.join(os.homedir(), '.claude', '.credentials.json');
  try {
    if (!fs.existsSync(credPath)) return null;
    const data = JSON.parse(fs.readFileSync(credPath, 'utf-8'));
    // Claude credentials file format: { "claudeAiOauth": { "accessToken": "..." } }
    const token = data?.claudeAiOauth?.accessToken;
    if (token && typeof token === 'string') {
      // Check if token is expired
      const expiresAt = data?.claudeAiOauth?.expiresAt;
      if (expiresAt && Date.now() > expiresAt) {
        logger.warn('OAuth token from credentials file is expired');
        return null;
      }
      return token;
    }
  } catch {
    // File missing or malformed
  }
  return null;
}

/** Cache token for 5 minutes to avoid repeated reads */
let tokenCache: { token: string; expiresAt: number } | null = null;
const TOKEN_CACHE_TTL = 5 * 60 * 1000;

function getCachedToken(): string | null {
  if (tokenCache && Date.now() < tokenCache.expiresAt) {
    return tokenCache.token;
  }
  // Try keychain first (macOS), then credentials file (Linux)
  const token = readOAuthFromKeychain() || readOAuthFromCredentials();
  if (token) {
    tokenCache = { token, expiresAt: Date.now() + TOKEN_CACHE_TTL };
  } else {
    tokenCache = null;
  }
  return token;
}

export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
  ]);

  const authMode: AuthMode = secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';

  // Re-read API key on each request so .env rotations take effect without restart
  const getApiKey = (): string | undefined => {
    const fresh = readEnvFile(['ANTHROPIC_API_KEY']);
    return fresh.ANTHROPIC_API_KEY || secrets.ANTHROPIC_API_KEY;
  };

  const envOauthToken =
    secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN;

  const getOAuthToken = (): string | undefined => {
    const cached = getCachedToken();
    if (cached) return cached;
    return envOauthToken;
  };

  if (authMode === 'oauth') {
    const initialToken = getOAuthToken();
    logger.info(
      {
        hasToken: !!initialToken,
        source: getCachedToken() ? 'auto-detect' : 'env',
      },
      'Credential proxy: OAuth token loaded',
    );
  }

  const upstreamUrl = new URL(
    secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  );
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

  // --- OAuth exchange cache ---
  // Prevents concurrent/repeated exchanges from the same OAuth token.
  // Critical for Agent Teams where subagents each try their own exchange.
  interface ExchangeCacheEntry {
    statusCode: number;
    headers: Record<string, string | string[] | undefined>;
    body: Buffer;
    oauthToken: string;
    expiresAt: number;
  }
  let exchangeCache: ExchangeCacheEntry | null = null;
  const EXCHANGE_CACHE_TTL = 8 * 60 * 1000; // 8 min (temp API keys expire ~10 min)
  let exchangeInflight: Promise<ExchangeCacheEntry | null> | null = null;

  const isExchangeRequest = (
    method: string | undefined,
    url: string | undefined,
  ) =>
    method === 'POST' && url?.includes('/api/oauth/claude_cli/create_api_key');

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const headers: Record<string, string | number | string[] | undefined> =
          {
            ...(req.headers as Record<string, string>),
            host: upstreamUrl.host,
            'content-length': body.length,
          };

        // Strip hop-by-hop headers
        delete headers['connection'];
        delete headers['keep-alive'];
        delete headers['transfer-encoding'];

        if (authMode === 'api-key') {
          delete headers['x-api-key'];
          headers['x-api-key'] = getApiKey();
        } else {
          // OAuth mode: inject real token on Authorization header
          if (headers['authorization']) {
            delete headers['authorization'];
            const currentToken = getOAuthToken();
            if (currentToken) {
              headers['authorization'] = `Bearer ${currentToken}`;
            }
          }

          // Serve cached exchange response for subagents
          if (isExchangeRequest(req.method, req.url)) {
            const currentToken = getOAuthToken();
            if (
              exchangeCache &&
              Date.now() < exchangeCache.expiresAt &&
              currentToken === exchangeCache.oauthToken
            ) {
              logger.debug('Serving cached OAuth exchange response');
              res.writeHead(exchangeCache.statusCode, exchangeCache.headers);
              res.end(exchangeCache.body);
              return;
            }

            // Coalesce with in-flight exchange
            if (exchangeInflight) {
              logger.debug('Waiting for in-flight OAuth exchange');
              exchangeInflight.then((cached) => {
                if (cached) {
                  res.writeHead(cached.statusCode, cached.headers);
                  res.end(cached.body);
                } else {
                  res.writeHead(502);
                  res.end('Exchange failed');
                }
              });
              return;
            }

            // First exchange: forward upstream, cache result
            exchangeInflight = new Promise<ExchangeCacheEntry | null>(
              (resolveExchange) => {
                const upstream = makeRequest(
                  {
                    hostname: upstreamUrl.hostname,
                    port: upstreamUrl.port || (isHttps ? 443 : 80),
                    path: req.url,
                    method: req.method,
                    headers,
                  } as RequestOptions,
                  (upRes) => {
                    const upChunks: Buffer[] = [];
                    upRes.on('data', (c: Buffer) => upChunks.push(c));
                    upRes.on('end', () => {
                      const upBody = Buffer.concat(upChunks);
                      const upHeaders = upRes.headers as Record<
                        string,
                        string | string[] | undefined
                      >;

                      if (upRes.statusCode === 200) {
                        exchangeCache = {
                          statusCode: upRes.statusCode,
                          headers: upHeaders,
                          body: upBody,
                          oauthToken: currentToken || '',
                          expiresAt: Date.now() + EXCHANGE_CACHE_TTL,
                        };
                        logger.info('OAuth exchange cached for subagent reuse');
                      } else {
                        logger.warn(
                          { statusCode: upRes.statusCode },
                          'OAuth exchange failed upstream',
                        );
                      }

                      res.writeHead(upRes.statusCode!, upHeaders);
                      res.end(upBody);
                      exchangeInflight = null;
                      resolveExchange(exchangeCache);
                    });
                  },
                );

                upstream.on('error', (err) => {
                  logger.error({ err }, 'OAuth exchange upstream error');
                  if (!res.headersSent) {
                    res.writeHead(502);
                    res.end('Bad Gateway');
                  }
                  exchangeInflight = null;
                  resolveExchange(null);
                });

                // Timeout to prevent permanent hang if upstream stalls
                upstream.setTimeout(30000, () => {
                  upstream.destroy(
                    new Error('OAuth exchange request timed out'),
                  );
                });

                upstream.write(body);
                upstream.end();
              },
            );
            return;
          }
        }

        // Forward request to upstream
        const upstream = makeRequest(
          {
            hostname: upstreamUrl.hostname,
            port: upstreamUrl.port || (isHttps ? 443 : 80),
            path: req.url,
            method: req.method,
            headers,
          } as RequestOptions,
          (upRes) => {
            res.writeHead(upRes.statusCode!, upRes.headers);
            upRes.pipe(res);
          },
        );

        upstream.on('error', (err) => {
          logger.error(
            { err, url: req.url },
            'Credential proxy upstream error',
          );
          if (!res.headersSent) {
            res.writeHead(502);
            res.end('Bad Gateway');
          }
        });

        upstream.write(body);
        upstream.end();
      });
    });

    server.on('error', async (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        logger.warn({ port, host }, 'Proxy port in use, attempting to reclaim');
        killPortHolder(port);
        await new Promise((r) => setTimeout(r, 1000));
        const free = await isPortAvailable(port, host);
        if (free) {
          server.listen(port, host, () => {
            logger.info(
              { port, host, authMode },
              'Credential proxy started (after reclaim)',
            );
            resolve(server);
          });
        } else {
          reject(
            new Error(`Port ${port} still in use after attempting to reclaim`),
          );
        }
      } else {
        reject(err);
      }
    });

    server.listen(port, host, () => {
      logger.info({ port, host, authMode }, 'Credential proxy started');
      resolve(server);
    });
  });
}

/** Detect which auth mode the host is configured for. */
export function detectAuthMode(): AuthMode {
  const secrets = readEnvFile(['ANTHROPIC_API_KEY']);
  return secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
}
