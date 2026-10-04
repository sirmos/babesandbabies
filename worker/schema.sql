CREATE TABLE IF NOT EXISTS orders (
  order_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Paid',
  kind TEXT NOT NULL,
  total REAL NOT NULL,
  currency TEXT NOT NULL,
  items TEXT NOT NULL,
  note TEXT,
  first_name TEXT,
  capture_id TEXT,
  webhook_confirmed INTEGER NOT NULL DEFAULT 0,
  webhook_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);