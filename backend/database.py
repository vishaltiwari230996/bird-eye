"""database.py — PostgreSQL connection pool and query helpers."""
import os
import re
from contextlib import contextmanager
import psycopg2
from psycopg2.pool import ThreadedConnectionPool
from psycopg2.extras import RealDictCursor

_pool: ThreadedConnectionPool | None = None

# Match $1, $2, ... but only outside of single-quoted string literals.
_DOLLAR_PARAM_RE = re.compile(r"'(?:[^']|'')*'|\$(\d+)")


def _to_psycopg_sql(sql: str, params):
    """Convert asyncpg-style $1,$2 placeholders + list params to psycopg2 %s + tuple."""
    if not params:
        return sql, params

    indexes: list[int] = []

    def repl(m: re.Match) -> str:
        # If the match is a quoted literal, preserve it.
        if m.group(0).startswith("'"):
            return m.group(0)
        indexes.append(int(m.group(1)))
        return "%s"

    new_sql = _DOLLAR_PARAM_RE.sub(repl, sql)
    if not indexes:
        return sql, params

    seq = list(params)
    new_params = tuple(seq[i - 1] for i in indexes)
    return new_sql, new_params


def query(sql: str, params=None) -> list[dict]:
    pool = get_pool()
    conn = pool.getconn()
    sql, params = _to_psycopg_sql(sql, params)
    try:
        with conn.cursor() as cur:
            cur.execute(sql, params or ())
            conn.commit()
            if cur.description:
                return [dict(row) for row in cur.fetchall()]
            return []
    except Exception:
        conn.rollback()
        raise
    finally:
        pool.putconn(conn)


def get_pool() -> ThreadedConnectionPool:
    global _pool
    if _pool is None:
        dsn = os.environ["DATABASE_URL"]
        _pool = ThreadedConnectionPool(1, 10, dsn, cursor_factory=RealDictCursor)
    return _pool


def query_one(sql: str, params=None) -> dict | None:
    rows = query(sql, params)
    return rows[0] if rows else None


@contextmanager
def transaction():
    pool = get_pool()
    conn = pool.getconn()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        pool.putconn(conn)
