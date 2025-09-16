// src/db.ts
import { Pool } from 'pg';

const {
  DATABASE_URL,
  PGHOST,
  PGPORT,
  PGDATABASE,
  PGUSER,
  PGPASSWORD,
  PGSSL,
} = process.env;

const pool =
  DATABASE_URL
    ? new Pool({
        connectionString: DATABASE_URL,
        ssl: shouldUseSSL(),
      })
    : new Pool({
        host: PGHOST || 'localhost',
        port: PGPORT ? Number(PGPORT) : 5432,
        database: PGDATABASE,
        user: PGUSER,
        password: PGPASSWORD,
        ssl: shouldUseSSL(),
      });

function shouldUseSSL() {
  if (!PGSSL) return false;
  return /^(1|true|yes)$/i.test(PGSSL);
}

export async function query(text: string, params?: any[]) {
  return pool.query(text, params);
}

export const db = { query };
export default db;
export { pool };
