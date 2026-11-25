-- Schema v8. Round boundaries use Unix seconds; all *_at/time fields use milliseconds.
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS accounts (
  mode TEXT PRIMARY KEY CHECK(mode IN ('paper','live')),
  session TEXT NOT NULL REFERENCES account_sessions(id) DEFERRABLE INITIALLY DEFERRED,
  config_id INTEGER NOT NULL REFERENCES strategy_configs(id) DEFERRABLE INITIALLY DEFERRED,
  running INTEGER NOT NULL CHECK(running IN (0,1)), reason TEXT
);
CREATE TABLE IF NOT EXISTS strategy_configs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mode TEXT NOT NULL REFERENCES accounts(mode) DEFERRABLE INITIALLY DEFERRED,
  base_amount REAL NOT NULL, initial_balance REAL NOT NULL, max_amount REAL NOT NULL,
  max_doublings INTEGER NOT NULL, stop_loss REAL NOT NULL, entry_delay INTEGER NOT NULL,
  entry_window INTEGER NOT NULL, slippage REAL NOT NULL, max_price REAL NOT NULL,
  min_price REAL NOT NULL DEFAULT 0.4 CHECK(min_price BETWEEN 0.01 AND 0.99),
  same_direction_only INTEGER NOT NULL DEFAULT 0 CHECK(same_direction_only IN (0,1)),
  follow_previous_at_open INTEGER NOT NULL DEFAULT 0 CHECK(follow_previous_at_open IN (0,1)),
  reverse_signal INTEGER NOT NULL DEFAULT 0 CHECK(reverse_signal IN (0,1)),
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS account_sessions (
  id TEXT PRIMARY KEY,
  mode TEXT NOT NULL REFERENCES accounts(mode) DEFERRABLE INITIALLY DEFERRED,
  balance REAL NOT NULL, starting_balance REAL, pnl REAL NOT NULL, cycle_pnl REAL NOT NULL,
  losses INTEGER NOT NULL, wins INTEGER NOT NULL, settled INTEGER NOT NULL,
  cycle INTEGER NOT NULL, created_at INTEGER NOT NULL, closed_at INTEGER
);
CREATE TABLE IF NOT EXISTS strategy_versions (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, rules TEXT NOT NULL, registered_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY, mode TEXT NOT NULL REFERENCES accounts(mode),
  round INTEGER NOT NULL, session TEXT NOT NULL,
  config_id INTEGER REFERENCES strategy_configs(id),
  strategy_version TEXT REFERENCES strategy_versions(id),
  status TEXT NOT NULL, end INTEGER, slug TEXT, condition_id TEXT, asset_id TEXT,
  outcome_index INTEGER, direction TEXT CHECK(direction IN ('UP','DOWN')),
  budget REAL, doubling INTEGER, created_at INTEGER, settled_at INTEGER,
  reference_price REAL, signal_price REAL, signal_rule TEXT, price_source TEXT,
  oracle_window INTEGER, fee_rate REAL, fee_exponent REAL,
  shares REAL, notional REAL, fee REAL, cost REAL, price REAL, price_limit REAL,
  fee_estimated INTEGER CHECK(fee_estimated IN (0,1)),
  payout REAL, pnl REAL, venue_order_id TEXT, note TEXT, entry_reason TEXT,
  is_hide INTEGER NOT NULL DEFAULT 0 CHECK(is_hide IN (0,1)),
  UNIQUE(mode,round)
);
CREATE TABLE IF NOT EXISTS order_rounds (
  mode TEXT NOT NULL REFERENCES accounts(mode), round INTEGER NOT NULL,
  order_id TEXT NOT NULL UNIQUE, reserved_at INTEGER,
  PRIMARY KEY(mode,round)
);
CREATE TABLE IF NOT EXISTS order_trade_ids (
  order_id TEXT NOT NULL REFERENCES orders(id), trade_id TEXT NOT NULL,
  position INTEGER NOT NULL, PRIMARY KEY(order_id,trade_id), UNIQUE(order_id,position)
);
CREATE TABLE IF NOT EXISTS order_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, order_id TEXT NOT NULL REFERENCES orders(id),
  status TEXT NOT NULL, note TEXT, venue_order_id TEXT, time INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS order_books (
  order_id TEXT PRIMARY KEY REFERENCES orders(id), fetched_at INTEGER,
  tick_size REAL, min_order_size REAL
);
CREATE TABLE IF NOT EXISTS order_predictions (
  order_id TEXT PRIMARY KEY REFERENCES orders(id),
  open_price REAL NOT NULL CHECK(open_price>0), close_price REAL NOT NULL CHECK(close_price>0),
  outcome TEXT NOT NULL CHECK(outcome IN ('UP','DOWN')),
  won INTEGER NOT NULL CHECK(won IN (0,1)), source TEXT NOT NULL,
  observed_at INTEGER NOT NULL, price_at INTEGER, verified_at INTEGER,
  matches INTEGER CHECK(matches IN (0,1))
);
CREATE TABLE IF NOT EXISTS round_predictions (
  round INTEGER PRIMARY KEY, condition_id TEXT NOT NULL,
  open_price REAL NOT NULL CHECK(open_price>0), close_price REAL NOT NULL CHECK(close_price>0),
  outcome TEXT NOT NULL CHECK(outcome IN ('UP','DOWN')), source TEXT NOT NULL,
  oracle_window INTEGER, observed_at INTEGER NOT NULL, price_at INTEGER
);
CREATE TABLE IF NOT EXISTS round_openings (
  round INTEGER PRIMARY KEY, condition_id TEXT NOT NULL, open_price REAL NOT NULL CHECK(open_price>0),
  oracle_window INTEGER NOT NULL, observed_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS order_book_levels (
  order_id TEXT NOT NULL REFERENCES order_books(order_id),
  side TEXT NOT NULL CHECK(side IN ('ask','bid')), position INTEGER NOT NULL,
  price REAL NOT NULL, size REAL NOT NULL, PRIMARY KEY(order_id,side,position)
);
CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, time INTEGER NOT NULL,
  mode TEXT NOT NULL, level TEXT NOT NULL, message TEXT NOT NULL,
  is_hide INTEGER NOT NULL DEFAULT 0 CHECK(is_hide IN (0,1))
);
CREATE TABLE IF NOT EXISTS log_clear_positions (
  mode TEXT PRIMARY KEY CHECK(mode IN ('paper','live')),
  system_through_id INTEGER NOT NULL, cleared_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ticks (
  source TEXT NOT NULL, time INTEGER NOT NULL, price REAL NOT NULL, oracle_window INTEGER,
  PRIMARY KEY(source,time)
);
CREATE TABLE IF NOT EXISTS round_signals (
  round INTEGER NOT NULL, target_seconds INTEGER NOT NULL CHECK(target_seconds BETWEEN 0 AND 240), observed_at INTEGER,
  direction TEXT CHECK(direction IN ('UP','DOWN')), price REAL, reference_price REAL,
  source TEXT, rule TEXT, oracle_window INTEGER, PRIMARY KEY(round,target_seconds)
);
CREATE TABLE IF NOT EXISTS round_history (
  round INTEGER PRIMARY KEY, end INTEGER NOT NULL, slug TEXT NOT NULL,
  status TEXT NOT NULL, result TEXT CHECK(result IN ('UP','DOWN')),
  open REAL, close REAL, change REAL, change_percent REAL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS entry_blocks (
  mode TEXT NOT NULL REFERENCES accounts(mode), round INTEGER NOT NULL,
  message TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(mode,round)
);
CREATE INDEX IF NOT EXISTS orders_pending ON orders(status,round);
CREATE TABLE IF NOT EXISTS entry_diagnostics (
  id INTEGER PRIMARY KEY AUTOINCREMENT, mode TEXT NOT NULL REFERENCES accounts(mode), round INTEGER NOT NULL,
  code TEXT NOT NULL, message TEXT NOT NULL, at INTEGER NOT NULL,
  config_id INTEGER REFERENCES strategy_configs(id), direction TEXT, budget REAL,
  elapsed_seconds REAL, entry_delay INTEGER, entry_window INTEGER,
  reference_price REAL, signal_price REAL, spot_round INTEGER, spot_at INTEGER,
  market_round INTEGER, market_at INTEGER, market_active INTEGER, book_at INTEGER, oracle_window INTEGER,
  available_balance REAL, max_price REAL, slippage REAL, tick_size REAL, best_ask REAL,
  slippage_limit REAL, raw_price_limit REAL, price_limit REAL, limit_source TEXT,
  eligible_shares REAL, available_budget REAL, remaining_budget REAL, next_ask REAL,
  minimum_shares REAL, estimated_shares REAL, required_budget REAL, fee_rate REAL, fee_exponent REAL,
  related_round INTEGER, data_age_ms INTEGER, max_age_ms INTEGER
);
CREATE TABLE IF NOT EXISTS entry_diagnostic_levels (
  diagnostic_id INTEGER NOT NULL REFERENCES entry_diagnostics(id),
  side TEXT NOT NULL CHECK(side IN ('ask','bid')), position INTEGER NOT NULL,
  price REAL NOT NULL, size REAL NOT NULL, PRIMARY KEY(diagnostic_id,side,position)
);
CREATE INDEX IF NOT EXISTS diagnostics_mode_round ON entry_diagnostics(mode,round,id DESC);
CREATE INDEX IF NOT EXISTS orders_mode_round ON orders(mode,round DESC);
CREATE INDEX IF NOT EXISTS orders_session ON orders(session);
CREATE INDEX IF NOT EXISTS logs_mode_time ON logs(mode,id DESC);
CREATE INDEX IF NOT EXISTS order_events_order ON order_events(order_id,time);
CREATE INDEX IF NOT EXISTS configs_mode ON strategy_configs(mode,id DESC);
CREATE INDEX IF NOT EXISTS sessions_mode ON account_sessions(mode,created_at DESC);
