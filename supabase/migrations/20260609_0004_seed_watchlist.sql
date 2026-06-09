-- Seed universe: 15 tickers spanning sectors and all four quadrants.
insert into public.watchlist (ticker, name, sector) values
  ('AAPL',  'Apple Inc.',            'Technology'),
  ('MSFT',  'Microsoft Corp.',       'Technology'),
  ('BRK.B', 'Berkshire Hathaway',    'Financials'),
  ('JNJ',   'Johnson & Johnson',     'Healthcare'),
  ('JPM',   'JPMorgan Chase',        'Financials'),
  ('NVDA',  'Nvidia Corp.',          'Technology'),
  ('PFE',   'Pfizer Inc.',           'Healthcare'),
  ('T',     'AT&T Inc.',             'Telecom'),
  ('KO',    'Coca-Cola Co.',         'Consumer Staples'),
  ('UNH',   'UnitedHealth Group',    'Healthcare'),
  ('INTC',  'Intel Corp.',           'Technology'),
  ('CVX',   'Chevron Corp.',         'Energy'),
  ('COST',  'Costco Wholesale',      'Consumer Staples'),
  ('ABBV',  'AbbVie Inc.',           'Healthcare'),
  ('LOW',   'Lowe''s Companies',     'Consumer Discretionary')
on conflict (ticker) do nothing;
