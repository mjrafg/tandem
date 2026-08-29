import path from 'node:path';
import fs from 'node:fs';

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
  version: '0.1.0',
};

fs.mkdirSync(config.dataDir, { recursive: true });
fs.mkdirSync(config.projectsDir, { recursive: true });
