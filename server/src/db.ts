import 'dotenv/config';
import { Pool, type QueryResultRow } from 'pg';

function buildConnectionString(): string {
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (url) return url;

  const user = process.env.PGUSER ?? 'app';
  const pass = process.env.PGPASSWORD ?? 'app';
  const host = process.env.PGHOST ?? '127.0.0.1';
  const port = process.env.PGPORT ?? '5433';  // default to 5433
  const db   = process.env.PGDATABASE ?? 'attendance';
  return `postgres://${user}:${pass}@${host}:${port}/${db}`;
}

export const pool = new Pool({
  connectionString: buildConnectionString(),
  max: Number(process.env.PGPOOL_MAX ?? 10),
});

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: any[]
): Promise<{ rows: T[] }> {
  const client = await pool.connect();
  try {
    const res = await client.query<T>(text, params as any);
    return { rows: res.rows as T[] };
  } finally {
    client.release();
  }
}
