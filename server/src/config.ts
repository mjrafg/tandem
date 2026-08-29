import path from 'node:path';
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';

const cwd = process.cwd();
const dataDir = process.env.DATA_DIR || path.join(cwd, 'data');

export const config = {
  port: Number(process.env.PORT || 7810),
  host: process.env.HOST || '127.0.0.1',
  dataDir,
  projectsDir: process.env.PROJECTS_DIR || path.join(dataDir, 'projects'),
  webDist: process.env.WEB_DIST || path.resolve(cwd, '../web/dist'),
  adminEmail: process.env.TANDEM_EMAIL || 'mjrafg2@gmail.com',
  production: process.env.NODE_ENV === 'production',
  version: '0.2.0',
  /** CLI binaries for the agent roles (PATH-resolved unless overridden) */
  claudeBin: process.env.TANDEM_CLAUDE_BIN || 'claude',
  codexBin: process.env.TANDEM_CODEX_BIN || 'codex',
  /** per-boot secret for localhost-internal calls (MCP tools → app); env override is for dev/testing */
  internalToken: process.env.TANDEM_INTERNAL_TOKEN || randomBytes(24).toString('hex'),
};

export const shotsDir = path.join(dataDir, 'shots');

fs.mkdirSync(config.dataDir, { recursive: true });
fs.mkdirSync(config.projectsDir, { recursive: true });
fs.mkdirSync(path.join(config.dataDir, 'tmp'), { recursive: true });
fs.mkdirSync(shotsDir, { recursive: true });
